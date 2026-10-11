import { LIMITS, type AppSettings } from "@/lib/config";
import { ConfigError } from "@/lib/errors";
import { logError, logInfo } from "@/lib/log";
import { interpretMessage, type InterpretRequest } from "@/lib/ai/deepseek";
import type { FinanceAction } from "@/lib/finance/schemas";
import { pendingPayloadSchema } from "@/lib/finance/schemas";
import type { FinanceStore } from "@/lib/finance/store";
import {
  executeConfirmed,
  handleAction,
  type ActionContext,
  type Delivery,
} from "@/lib/finance/action-router";
import { newActionId, newTransactionId } from "@/lib/finance/ids";
import { authorizeUser } from "@/lib/security/authorization";
import { claimUpdate, completeUpdate } from "@/lib/security/idempotency";
import { SlidingWindowRateLimiter } from "@/lib/security/rate-limit";
import { createSheetsFinanceStore } from "@/lib/google/finance-store";
import { createSupabaseFinanceStore } from "@/lib/supabase/finance-store";
import { createTelegramClient, type InlineButton, type TelegramSender } from "@/lib/telegram/client";
import { commandName, parseCallbackData, type TelegramUpdate } from "@/lib/telegram/schemas";
import { helpText, userFacingError } from "@/lib/telegram/messages";

export type HandlerDeps = {
  settings: AppSettings;
  store: FinanceStore | null;
  telegram: TelegramSender;
  interpret: (request: InterpretRequest) => Promise<FinanceAction>;
  now: () => Date;
  rateLimiter: SlidingWindowRateLimiter;
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
  if (!deps.rateLimiter.allow(String(actor.userId), deps.now().getTime())) {
    await deps.telegram.sendMessage(actor.chatId, "Too many messages. Wait a minute and try again.");
    return { httpStatus: 200 };
  }

  const command = message.text ? commandName(message.text) : null;
  if (command === "id") {
    await deps.telegram.sendMessage(actor.chatId, `Your Telegram user ID is ${actor.userId}.`);
    return { httpStatus: 200 };
  }

  const profile = authorizeUser(actor.userId, deps.settings);
  if (!profile) {
    await deps.telegram.sendMessage(actor.chatId, "This bot is private.");
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
    await deps.telegram.sendMessage(actor.chatId, helpText(profile.timezone));
    return { httpStatus: 200 };
  }
  if (command) {
    await deps.telegram.sendMessage(actor.chatId, helpText(profile.timezone));
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

  return withClaim(update.update_id, actor, deps, async (ctx) => {
    const recent = (await deps.store!.listTransactions(String(profile.telegramUserId)))
      .filter((item) => item.status === "active")
      .sort((left, right) => right.transactionDate.localeCompare(left.transactionDate))
      .slice(0, LIMITS.recentContext)
      .map((item) => ({
        transactionId: item.transactionId,
        transactionDate: item.transactionDate,
        type: item.type,
        amount: item.amount,
        currency: item.currency,
        category: item.category,
        description: item.description.slice(0, 80),
      }));
    const action = await deps.interpret({
      text,
      timezone: profile.timezone,
      currency: profile.currency,
      now: ctx.now,
      recent,
    });
    logInfo("interpreted", { updateId: update.update_id, userId: actor.userId, action: action.type });
    return handleAction(action, ctx);
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
  if (!deps.rateLimiter.allow(String(actor.userId), deps.now().getTime())) {
    await deps.telegram.answerCallbackQuery(callback.id, "Too many requests. Wait a minute.");
    return { httpStatus: 200 };
  }
  const profile = authorizeUser(actor.userId, deps.settings);
  if (!profile) {
    await deps.telegram.answerCallbackQuery(callback.id, "This bot is private.");
    return { httpStatus: 200 };
  }
  const decision = callback.data ? parseCallbackData(callback.data) : null;
  if (!decision || !deps.store) {
    await deps.telegram.answerCallbackQuery(callback.id, "That button is no longer valid.");
    return { httpStatus: 200 };
  }

  return withClaim(update.update_id, actor, deps, async () => {
    const pending = await deps.store!.getPendingAction(decision.actionId);
    const userId = String(profile.telegramUserId);
    const chatId = String(actor.chatId);
    if (!pending || pending.userId !== userId || pending.chatId !== chatId) {
      return { kind: "text", text: "That confirmation isn't for this chat." };
    }
    const now = deps.now();
    if (Date.parse(pending.expiresAt) <= now.getTime() && pending.status === "pending") {
      await deps.store!.updatePendingAction(pending.actionId, { status: "expired" });
      return { kind: "text", text: "That confirmation expired. Send the request again. Nothing was changed." };
    }
    if (pending.status === "completed") return { kind: "text", text: "That was already confirmed." };
    if (pending.status === "cancelled" || pending.status === "expired") {
      return { kind: "text", text: "That confirmation is closed. Nothing was changed." };
    }
    if (decision.decision === "cancel") {
      await deps.store!.updatePendingAction(pending.actionId, { status: "cancelled" });
      return { kind: "text", text: "Cancelled. Nothing was changed." };
    }
    let raw: unknown = null;
    try {
      raw = JSON.parse(pending.payloadJson) as unknown;
    } catch {
      raw = null;
    }
    const payload = pendingPayloadSchema.safeParse(raw);
    if (!payload.success || payload.data.type !== pending.actionType) {
      await deps.store!.updatePendingAction(pending.actionId, { status: "cancelled" });
      return { kind: "text", text: "That confirmation is no longer valid. Nothing was changed." };
    }
    await deps.store!.updatePendingAction(pending.actionId, { status: "processing" });
    const ctx = actionContext(actor, deps, profile, update.update_id);
    const text = await executeConfirmed(payload.data, ctx);
    await deps.store!.updatePendingAction(pending.actionId, { status: "completed" });
    return { kind: "text", text };
  });
}

async function withClaim(
  updateId: number,
  actor: Actor,
  deps: HandlerDeps,
  produce: (ctx: ActionContext) => Promise<Delivery>,
): Promise<{ httpStatus: number }> {
  const store = deps.store;
  if (!store) return { httpStatus: 200 };
  const profile = authorizeUser(actor.userId, deps.settings);
  if (!profile) return { httpStatus: 200 };
  const now = deps.now();
  const claim = await claimUpdate(store, {
    updateId,
    userId: String(profile.telegramUserId),
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
      pending.userId === String(profile.telegramUserId) &&
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
    await completeUpdate(
      store,
      claim.rowNumber,
      {
        reply: delivery.text,
        pendingActionId: delivery.kind === "confirm" ? delivery.actionId : undefined,
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
  profile: NonNullable<ReturnType<typeof authorizeUser>>,
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
    rateLimiter: sharedLimiter,
    createId: newTransactionId,
    createActionId: newActionId,
  };
}
