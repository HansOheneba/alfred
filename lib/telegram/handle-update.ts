import { LIMITS, type AppSettings } from "@/lib/config";
import { ConfigError } from "@/lib/errors";
import { logError } from "@/lib/log";
import { interpretMessage, type InterpretRequest } from "@/lib/ai/deepseek";
import { createVoice, intentOf, type Voice } from "@/lib/ai/voice";
import { applyLabel, bankAccess } from "@/lib/bank/ingest";
import { labelChoiceText, reviewRow, labelFromCode, parseLabelCallback, questionFor } from "@/lib/bank/notify";
import { createSupabaseNotebookStore, type NotebookStore } from "@/lib/notebook/store";
import { createSupabasePeopleStore, payeeNamesFrom, type PeopleStore } from "@/lib/people/store";
import { createSupabaseLoanStore, type LoanStore } from "@/lib/finance/loans";
import { askNext } from "@/lib/bank/reply";
import { createSupabaseBankStore, type BankStore } from "@/lib/bank/store";
import type { UserProfile } from "@/lib/config";
import { readImageText, type ImageText } from "@/lib/ocr/read-image";
import { bankScreenshotReply } from "@/lib/ocr/screenshot-turn";
import { downloadTelegramFile, pickPhoto } from "@/lib/telegram/files";
import { actionsOf, type InterpretedAction } from "@/lib/finance/schemas";
import type { FinanceStore } from "@/lib/finance/store";
import { handleAction, type ActionContext, type Delivery } from "@/lib/finance/action-router";
import { decidePending } from "@/lib/finance/pending";
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
import { converse } from "@/lib/conversation/turn";
import { welcomeFor } from "@/lib/conversation/welcome";
import { userFacingError, UNLINKED_TEXT } from "@/lib/telegram/messages";
import { createSupabaseInvestmentStore, type InvestmentStore } from "@/lib/investments/store";

export type HandlerDeps = {
  settings: AppSettings;
  store: FinanceStore | null;
  telegram: TelegramSender;
  interpret: (request: InterpretRequest) => Promise<InterpretedAction>;
  now: () => Date;
  rateLimiter: { allow(key: string, now: number): boolean | Promise<boolean> };
  accounts: AccountDirectory;
  messages?: MessageLog | null;
  voice?: Voice | null;
  bank?: BankStore | null;
  loans?: LoanStore | null;
  /** Investments: what the person holds and the money they put in. */
  investments?: InvestmentStore | null;
  people?: PeopleStore | null;
  /** What Alfred has learnt about the person. */
  notebook?: NotebookStore | null;
  /** Downloads and reads a photo the person sent. */
  readPhoto?: ((fileId: string) => Promise<ImageText>) | null;
  /** Files a screenshot of bank texts; null when it isn't one. */
  bankScreenshot?: ((profile: UserProfile, image: ImageText) => Promise<string | null>) | null;
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

  const photo = pickPhoto(message.photo);
  if (!message.text?.trim() && photo && deps.readPhoto && deps.store && deps.settings.deepseek) {
    return handlePhoto(update, photo.file_id, message.caption ?? "", actor, profile, deps);
  }
  if (!message.text?.trim()) {
    await deps.telegram.sendMessage(
      actor.chatId,
      "Send a text message or a screenshot. Voice notes and files aren't supported yet.",
    );
    return { httpStatus: 200 };
  }

  const text = message.text.trim();
  if (command === "start" || command === "help") {
    await deps.telegram.sendMessage(actor.chatId, await welcomeFor(profile, deps.bank));
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
    return converse(text, ctx, { ...deps, store: ctx.store }, { channel: "telegram" });
  });
}

/** A screenshot sent to the bot: bank texts are filed; anything else is read like a message and always confirmed. */
async function handlePhoto(
  update: TelegramUpdate,
  fileId: string,
  caption: string,
  actor: Actor,
  profile: UserProfile,
  deps: HandlerDeps,
): Promise<{ httpStatus: number }> {
  return withClaim(update.update_id, actor, profile, deps, { userText: caption ? `📷 Screenshot\n${caption}` : "📷 Screenshot", channel: "telegram" }, async (ctx) => {
    const read = await deps.readPhoto!(fileId);
    if (!read.text) return { kind: "text", text: "I couldn't make out any text in that image. A sharper screenshot usually does it." };
    const filed = await deps.bankScreenshot?.(profile, read);
    if (filed) return { kind: "text", text: filed, intent: "bank:screenshot" };
    const text = [caption, "📷 Screenshot", read.text].filter(Boolean).join("\n").slice(0, LIMITS.maxUserTextChars);
    const { action, context } = await interpretWithContext({
      text,
      profile,
      store: ctx.store,
      now: ctx.now,
      interpret: deps.interpret,
      messages: deps.messages,
      channel: "telegram",
    });
    // A screenshot is read as one request; anything it suggests is confirmed first.
    const first = actionsOf(action)[0];
    const delivery = await handleAction(first, { ...ctx, confirmTransactions: "always", conversation: context });
    return { ...delivery, intent: intentOf(first) };
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
  const bankChoice = callback.data ? parseLabelCallback(callback.data) : null;
  if (bankChoice && deps.bank && deps.store) {
    const bank = deps.bank;
    const store = deps.store;
    const message = await bank.getMessage(profile.profileId, bankChoice.messageId);
    const label = message ? labelFromCode(message, bankChoice.code) : null;
    const choice = label ? (message?.kind === "hold_settle" && label.kind === "skip" ? "Yes, same payment" : labelChoiceText(label)) : "";
    return withClaim(update.update_id, actor, profile, deps, { userText: choice || "Label", channel: "telegram" }, async () => {
      if (!message || !label) return { kind: "text", text: "That button is no longer valid." };
      const ingest = { bank, ledger: store, now: deps.now(), createId: deps.createId, loans: deps.loans ?? undefined, people: deps.people, investments: deps.investments ?? null };
      const asked = await questionFor(ingest.loans, profile, message, deps.people, bank);
      const result = await applyLabel(ingest, profile, message.id, label);
      if (result.ok) await bank.saveUndo(profile.profileId, result.changes);
      // Keep the conversation moving: ask about the next waiting payment, with its own buttons.
      const next = result.ok ? await askNext(ingest, profile) : null;
      if (next) {
        const question = await questionFor(ingest.loans, profile, next, deps.people, bank);
        const remaining = (await bank.listMessages(profile.profileId, "needs_label")).length;
        await deps.telegram.sendMessage(actor.chatId, question.text, [...question.buttons, ...reviewRow(remaining)]);
        await deps.messages
          ?.append({ ownerId: profile.profileId, role: "assistant", body: question.text, channel: "telegram", intent: "bank:notice" })
          .catch((error) => logError("bank_message_log", error));
      }
      return {
        kind: "text",
        text: `${asked.text}\n\n${result.ok ? "✓ " : ""}${result.text}`,
        intent: "bank:label",
      };
    });
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
  produce: (ctx: ActionContext) => Promise<TelegramDelivery>,
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

  let delivery: TelegramDelivery;
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
        intent: delivery.intent ?? null,
        chart: delivery.chart ?? null,
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
    loans: deps.loans ?? null,
    investments: deps.investments ?? null,
    people: deps.people ?? null,
    payeeNames: deps.bank ? () => payeeNamesFrom(deps.bank!, profile.profileId) : undefined,
    bank: deps.bank ? bankAccess(deps.bank, deps.notebook, profile.profileId) : null,
    notebook: deps.notebook ?? null,
  };
}

/** A reply plus what to store with it, and any buttons beyond Confirm and Cancel. */
type TelegramDelivery = Delivery & { intent?: string; buttons?: InlineButton[][] };

async function deliver(deps: HandlerDeps, actor: Actor, delivery: TelegramDelivery): Promise<void> {
  const buttons: InlineButton[] | InlineButton[][] | undefined =
    delivery.kind === "confirm" && delivery.actionId
      ? [
          { text: "Confirm", callbackData: `c:${delivery.actionId}` },
          { text: "Cancel", callbackData: `x:${delivery.actionId}` },
        ]
      : delivery.buttons;
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
    bank: settings.supabase ? createSupabaseBankStore(settings.supabase) : null,
    loans: settings.supabase ? createSupabaseLoanStore(settings.supabase) : null,
    investments: settings.supabase ? createSupabaseInvestmentStore(settings.supabase) : null,
    people: settings.supabase ? createSupabasePeopleStore(settings.supabase) : null,
    notebook: settings.supabase ? createSupabaseNotebookStore(settings.supabase) : null,
    readPhoto: settings.deepseek
      ? async (fileId) => {
          const bytes = await downloadTelegramFile(settings.telegramBotToken, fileId, fetchImpl);
          return readImageText({ bytes, mime: "image/jpeg", deepseek: settings.deepseek, google: settings.google }, fetchImpl);
        }
      : null,
    bankScreenshot: settings.supabase ? (owner, image) => bankScreenshotReply(settings.supabase!, owner, image) : null,
    createId: newTransactionId,
    createActionId: newActionId,
  };
}
