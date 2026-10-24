import { LIMITS, type AppSettings } from "@/lib/config";
import { ConfigError } from "@/lib/errors";
import { logError, logInfo } from "@/lib/log";
import { interpretMessage, type InterpretRequest } from "@/lib/ai/deepseek";
import { createVoice, voiceDelivery, type Voice } from "@/lib/ai/voice";
import type { FinanceAction } from "@/lib/finance/schemas";
import type { FinanceStore } from "@/lib/finance/store";
import { handleAction, type ActionContext, type Delivery } from "@/lib/finance/action-router";
import { answerTypedDecision, decidePending } from "@/lib/finance/pending";
import { newActionId, newTransactionId } from "@/lib/finance/ids";
import { MemoryAccountDirectory } from "@/lib/accounts/directory";
import type { MessageLog } from "@/lib/accounts/messages";
import { claimUpdate, completeUpdate } from "@/lib/security/idempotency";
import { SlidingWindowRateLimiter } from "@/lib/security/rate-limit";
import type { AccountDirectory } from "@/lib/accounts/directory";
import { createSupabaseAccountDirectory } from "@/lib/accounts/supabase-directory";
import { createSupabaseMessageLog } from "@/lib/accounts/supabase-messages";
import { DbRateLimiter } from "@/lib/security/db-rate-limit";
import { createSheetsFinanceStore } from "@/lib/google/finance-store";
import { createSupabaseFinanceStore } from "@/lib/supabase/finance-store";
import { createTelegramClient, type InlineButton, type TelegramSender } from "@/lib/telegram/client";
import { commandName, parseCallbackData, type TelegramUpdate } from "@/lib/telegram/schemas";
import { interpretWithContext } from "@/lib/finance/context";
import { welcomeText, userFacingError, UNLINKED_TEXT } from "@/lib/telegram/messages";

export type HandlerDeps = {
  settings: AppSettings;
  store: FinanceStore | null;
  telegram: TelegramSender;
  interpret: (request: InterpretRequest) => Promise<FinanceAction>;
  now: () => Date;
  rateLimiter: { allow(key: string, now: number): boolean | Promise<boolean> };
  accounts: AccountDirectory;
  messages?: MessageLog | null;
  voice?: Voice | null;
  createId: () => string;
  createActionId: () => string;
};

type Actor = {
  userId: number;
  chatId: number;
  chatType: string;
  messageId?: number;
  callbackId?: string;
};

export async function handleTelegramUpdate(
  update: TelegramUpdate,
  deps: HandlerDeps,
): Promise<{ httpStatus: number }> {
  if (update.callback_query) return handleCallback(update, deps);
  return handleMessage(update, deps);
}

async function handleMessage(update: TelegramUpdate, deps: HandlerDeps): Promise<{ httpStatus: number }> {
  const message = update.message;
  if (!message?.from || message.from.is_bot) return { httpStatus: 200 };
  if (message.chat.type !== "private") return { httpStatus: 200 };
  const actor: Actor = { userId: message.from.id, chatId: message.chat.id, chatType: message.chat.type };
  if (!(await deps.rateLimiter.allow(String(actor.userId), deps.now().getTime()))) {
    await deps.telegram.sendMessage(actor.chatId, "Too many messages. Wait a minute and try again.");
    return { httpStatus: 200 };
  }

  const command = message.text ? commandName(message.text) : null;
  if (command === "id") {
    await deps.telegram.sendMessage(actor.chatId, `Your Telegram user ID is ${actor.userId}.`);
    await acceptSender(actor, deps);
    return { httpStatus: 200 };
  }

  const profile = await acceptSender(actor, deps);
  if (!profile) {
    await deps.telegram.sendMessage(actor.chatId, UNLINKED_TEXT);
    return { httpStatus: 200 };
  }

  if (!message.text?.trim()) {
    await deps.telegram.sendMessage(
      actor.chatId,
      "Send a text message. Photos, voice notes, and files aren't supported yet.",
    );
    return { httpStatus: 200 };
  }

  const text = message.text.trim();
  if (command === "start" || command === "help") {
    await deps.telegram.sendMessage(actor.chatId, welcomeText());
    return { httpStatus: 200 };
  }
  if (command) {
    await deps.telegram.sendMessage(actor.chatId, "I don't have that command. Tell me what you spent, or ask how your money is looking.");
    return { httpStatus: 200 };
  }
  if (text.length > LIMITS.maxUserTextChars) {
    await deps.telegram.sendMessage(actor.chatId, "That message is too long. Send one expense or question at a time.");
    return { httpStatus: 200 };
  }
  if (!deps.store) {
    await deps.telegram.sendMessage(actor.chatId, "Finance storage is not configured yet.");
    return { httpStatus: 200 };
  }
  if (!deps.settings.deepseek) {
    await deps.telegram.sendMessage(actor.chatId, "The language model isn't configured yet.");
    return { httpStatus: 200 };
  }

  return withClaim(update.update_id, actor, profile, deps, { userText: text, channel: "telegram" }, async (ctx) => {
    const settled = await answerTypedDecision(text, ctx);
    if (settled) return { kind: "text", text: settled.text, context: settled.context };
    const { action, context } = await interpretWithContext({
      text,
      profile,
      store: deps.store!,
      now: deps.now(),
      interpret: deps.interpret,
      messages: deps.messages,
      channel: "telegram",
    });
    logInfo("interpreted", { updateId: update.update_id, userId: profile.profileId, action: action.type });
    const delivery = await handleAction(action, { ...ctx, conversation: context });
    return voiceDelivery(deps.voice, action, delivery, { userText: text, profile, channel: "telegram" });
  });
}

async function handleCallback(update: TelegramUpdate, deps: HandlerDeps): Promise<{ httpStatus: number }> {
  const callback = update.callback_query;
  if (!callback) return { httpStatus: 200 };
  const message = callback.message;
  if (!message || message.chat.type !== "private") {
    await deps.telegram.answerCallbackQuery(callback.id, "Use a private chat.");
    return { httpStatus: 200 };
  }
  const actor: Actor = {
    userId: callback.from.id,
    chatId: message.chat.id,
    chatType: message.chat.type,
    messageId: message.message_id,
    callbackId: callback.id,
  };
  if (!(await deps.rateLimiter.allow(String(actor.userId), deps.now().getTime()))) {
    await deps.telegram.answerCallbackQuery(callback.id, "Too many requests. Wait a minute.");
    return { httpStatus: 200 };
  }
  const profile = await acceptSender(actor, deps);
  if (!profile) {
    await deps.telegram.answerCallbackQuery(callback.id, "This Telegram account isn't linked yet.");
    return { httpStatus: 200 };
  }
  const decision = callback.data ? parseCallbackData(callback.data) : null;
  if (!decision || !deps.store) {
    await deps.telegram.answerCallbackQuery(callback.id, "That button is no longer valid.");
    return { httpStatus: 200 };
  }

  return withClaim(update.update_id, actor, profile, deps, { userText: decision.decision, channel: "telegram" }, async (ctx) => {
    const settled = await decidePending(
      { decision: decision.decision, actionId: decision.actionId, chatId: String(actor.chatId) },
      ctx,
    );
    return { kind: "text", text: settled.text, context: settled.context };
  });
}

async function acceptSender(actor: Actor, deps: HandlerDeps) {
  const profile = await deps.accounts.resolveTelegram(actor.userId);
  if (!profile) return null;
  await deps.accounts.lockTelegram(actor.userId, actor.chatId, deps.now());
  return profile;
}

async function withClaim(
  updateId: number,
  actor: Actor,
  profile: NonNullable<Awaited<ReturnType<AccountDirectory["resolveTelegram"]>>>,
  deps: HandlerDeps,
  exchange: { userText: string; channel: "telegram" },
  produce: (ctx: ActionContext) => Promise<Delivery>,
): Promise<{ httpStatus: number }> {
  const store = deps.store;
  if (!store) return { httpStatus: 200 };
  const now = deps.now();
  const claim = await claimUpdate(store, {
    updateId,
    userId: profile.profileId,
    now,
    staleMs: LIMITS.processingStaleMs,
  });
  if (claim.kind === "in_progress" || claim.kind === "lost_race") {
    if (actor.callbackId) await deps.telegram.answerCallbackQuery(actor.callbackId, "Still working on that.");
    return { httpStatus: 503 };
  }
  if (claim.kind === "replay") {
    const pendingId = claim.pendingActionId;
    const pending = pendingId ? await store.getPendingAction(pendingId) : null;
    const stillPending =
      pending?.status === "pending" &&
      pending.userId === profile.profileId &&
      pending.chatId === String(actor.chatId);
    await deliver(
      deps,
      actor,
      stillPending && pendingId
        ? { kind: "confirm", text: claim.reply, actionId: pendingId }
        : { kind: "text", text: claim.reply },
    );
    return { httpStatus: 200 };
  }

  let delivery: Delivery;
  try {
    delivery = await produce(actionContext(actor, deps, profile, updateId));
  } catch (error) {
    logError("finance_action", error);
    delivery = { kind: "text", text: userFacingError(error) };
  }

  try {
    await deliver(deps, actor, delivery);
    if (deps.messages) {
      await deps.messages.append({
        ownerId: profile.profileId,
        role: "user",
        body: exchange.userText,
        channel: exchange.channel,
      });
      await deps.messages.append({
        ownerId: profile.profileId,
        role: "assistant",
        body: delivery.text,
        channel: exchange.channel,
      });
    }
    await completeUpdate(
      store,
      claim.rowNumber,
      {
        reply: delivery.text,
        pendingActionId: delivery.kind === "confirm" ? delivery.actionId : undefined,
        context: delivery.context,
      },
      deps.now(),
    );
    return { httpStatus: 200 };
  } catch (error) {
    logError("telegram_reply", error);
    return { httpStatus: 500 };
  }
}

function actionContext(
  actor: Actor,
  deps: HandlerDeps,
  profile: NonNullable<Awaited<ReturnType<AccountDirectory["resolveTelegram"]>>>,
  updateId: number,
): ActionContext {
  return {
    profile,
    store: deps.store as FinanceStore,
    now: deps.now(),
    updateId,
    chatId: actor.chatId,
    confirmTransactions: deps.settings.confirmTransactions,
    pendingTtlMs: LIMITS.pendingTtlMs,
    createId: deps.createId,
    createActionId: deps.createActionId,
  };
}

async function deliver(deps: HandlerDeps, actor: Actor, delivery: Delivery): Promise<void> {
  const buttons: InlineButton[] | undefined =
    delivery.kind === "confirm" && delivery.actionId
      ? [
          { text: "Confirm", callbackData: `c:${delivery.actionId}` },
          { text: "Cancel", callbackData: `x:${delivery.actionId}` },
        ]
      : undefined;
  if (actor.callbackId && actor.messageId) {
    try {
      await deps.telegram.editMessageText(actor.chatId, actor.messageId, delivery.text);
    } catch (error) {
      logError("telegram_edit", error);
      await deps.telegram.sendMessage(actor.chatId, delivery.text, buttons);
    }
    await deps.telegram.answerCallbackQuery(actor.callbackId);
    return;
  }
  await deps.telegram.sendMessage(actor.chatId, delivery.text, buttons);
}

let sharedLimiter: SlidingWindowRateLimiter | null = null;

export function createHandlerDeps(settings: AppSettings, fetchImpl?: typeof fetch): HandlerDeps {
  sharedLimiter ??= new SlidingWindowRateLimiter(LIMITS.rateLimit, LIMITS.rateWindowMs);
  const accounts = settings.supabase
    ? createSupabaseAccountDirectory(settings.supabase)
    : MemoryAccountDirectory.fromIds(settings.authorizedUserIds, {
        currency: settings.currency,
        timezone: settings.timezone,
        communicationPreference: "concise",
      });
  return {
    settings,
    store: settings.supabase
      ? createSupabaseFinanceStore(settings.supabase)
      : settings.google
        ? createSheetsFinanceStore(settings.google, fetchImpl)
        : null,
    telegram: createTelegramClient(settings.telegramBotToken, fetchImpl),
    interpret: (request) => {
      if (!settings.deepseek) {
        throw new ConfigError("Missing required environment variable: DEEPSEEK_API_KEY");
      }
      return interpretMessage(settings.deepseek, request, fetchImpl);
    },
    now: () => new Date(),
    rateLimiter: settings.supabase ? new DbRateLimiter(settings.supabase, LIMITS.rateLimit, LIMITS.rateWindowMs) : sharedLimiter,
    accounts,
    messages: settings.supabase ? createSupabaseMessageLog(settings.supabase) : null,
    voice: settings.deepseek ? createVoice(settings.deepseek, fetchImpl) : null,
    createId: newTransactionId,
    createActionId: newActionId,
  };
}
