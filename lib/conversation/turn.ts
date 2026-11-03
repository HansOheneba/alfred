import { clientTurnUpdateId, isClientMessageId, type ChatMessageRecord, type MessageLog } from "@/lib/accounts/messages";
import type { InterpretRequest } from "@/lib/ai/deepseek";
import type { Channel } from "@/lib/ai/persona";
import { intentOf, voiceDelivery, type Voice } from "@/lib/ai/voice";
import type { IngestDeps } from "@/lib/bank/ingest";
import {
  applyResolved,
  askAgain,
  askNextReply,
  LABEL_MODEL,
  isLabelUndo,
  groundedPaymentLabel,
  explicitExpenseCategory,
  labelShortcut,
  paymentPurposeUnclear,
  paymentPurposeNeedsClassification,
  resolvedFrom,
  UNMATCHED_LABEL,
  waitingPayments,
  type WaitingPayments,
} from "@/lib/bank/reply";
import type { BankMessage, BankStore } from "@/lib/bank/store";
import { openThread } from "@/lib/conversation/thread";
import { welcomeFor } from "@/lib/conversation/welcome";
import { handleAction, type ActionContext, type Delivery } from "@/lib/finance/action-router";
import { attentionLine, interpretWithContext, type ChatCue } from "@/lib/finance/context";
import type { AttentionSummary } from "@/lib/finance/accounting/types";
import type { LoanStore } from "@/lib/finance/loans";
import { answerTypedDecision, decidePending, latestOpenPending, typedDecision } from "@/lib/finance/pending";
import { actionsOf, type FinanceAction, type InterpretedAction } from "@/lib/finance/schemas";
import type { FinanceStore } from "@/lib/finance/store";
import type { ConversationContext } from "@/lib/finance/conversation";
import { logInfo } from "@/lib/log";
import { aboutForPrompt, type NotebookStore } from "@/lib/notebook/store";
import { notesForPrompt, type PeopleStore } from "@/lib/people/store";
import type { InlineButton } from "@/lib/telegram/client";
import { localGreeting } from "@/lib/telegram/messages";
import { KIND_LABELS, type InvestmentStore } from "@/lib/investments/store";
import { canonicalizeAmount } from "@/lib/finance/money";
import { normalizeCategory } from "@/lib/finance/categories";
import { zonedYmd } from "@/lib/finance/dates";
import type { PendingActionRecord } from "@/lib/finance/types";

/** What a conversation turn needs, from Telegram or the website. */
export type TurnDeps = {
  store: FinanceStore;
  interpret: (request: InterpretRequest) => Promise<InterpretedAction>;
  createId: () => string;
  messages?: MessageLog | null;
  voice?: Voice | null;
  bank?: BankStore | null;
  loans?: LoanStore | null;
  /** Investments: what the person holds and the money they put in. */
  investments?: InvestmentStore | null;
  people?: PeopleStore | null;
  notebook?: NotebookStore | null;
};

/** Alfred's reply to one message, with buttons for Telegram and the intent stored with it. */
export type TurnReply = Delivery & { intent?: string; buttons?: InlineButton[][]; paymentNotice?: ChatMessageRecord["paymentNotice"]; newTopic?: boolean };

type TurnOptions = { channel: Channel; excludeClientId?: string | null; replyToPayment?: ChatMessageRecord["paymentNotice"] | null; newTopic?: boolean };

/**
 * Answers one typed message as the next line of the conversation. Settled
 * without the model when it can be ("undo", a bare yes to an open
 * confirmation); otherwise the model reads it against the recent messages and
 * what's open, and may ask for a few actions, done in order.
 */
export async function converse(text: string, ctx: ActionContext, deps: TurnDeps, options: TurnOptions): Promise<TurnReply> {
  const noticeFocus = await paymentNoticeFocus(deps.messages, ctx.profile.profileId, options);
  const closedNotice = Boolean(noticeFocus && !noticeFocus.requiresPurpose);
  const confirmation = await confirmationAfterBoundary(deps, ctx, options);
  const currentMessageId = noticeFocus === undefined ? undefined : noticeFocus?.requiresPurpose ? noticeFocus.bankMessageId : null;
  const ordinaryReply = (reply: TurnReply): TurnReply => closedNotice || confirmation.fenced || options.newTopic ? { ...reply, newTopic: true } : reply;
  const keepNoticeFocus = async (reply: TurnReply, retainClosed = false): Promise<TurnReply> => {
    if (!noticeFocus || !noticeFocus.requiresPurpose && !retainClosed) return ordinaryReply(reply);
    const message = noticeFocus.requiresPurpose ? await deps.bank?.getMessage(ctx.profile.profileId, noticeFocus.bankMessageId) : null;
    // A settled question keeps a false binding, so a subsequent "yes" cannot
    // confirm something older and the private acknowledgment stays private.
    return { ...reply, paymentNotice: { ...noticeFocus, requiresPurpose: Boolean(message?.ownerId === ctx.profile.profileId && message.status === "needs_label") } };
  };
  // A "yes" after a new payment notice must not confirm an unrelated, older
  // financial action. Explicit confirmation controls still name that action.
  const decision = typedDecision(text);
  const settled = noticeFocus === undefined && !options.newTopic
    ? confirmation.fenced
      ? decision && confirmation.pending ? await decidePending({ decision, actionId: confirmation.pending.actionId, chatId: String(ctx.chatId) }, ctx) : null
      : await answerTypedDecision(text, ctx)
    : null;
  if (settled) return ordinaryReply({ kind: "text", text: settled.text, context: settled.context });

  const ingest: IngestDeps | null = deps.bank
    ? { bank: deps.bank, ledger: ctx.store, now: ctx.now, createId: deps.createId, loans: deps.loans ?? undefined, people: deps.people, investments: deps.investments ?? null }
    : null;
  const separateExpense = noticeFocus && !noticeFocus.requiresPurpose ? independentExpenseRequest(text, ctx.profile.currency) : null;
  if (separateExpense) {
    // This is a new, explicit request rather than a purpose answer. The exact
    // user words supply one expense, and it always gets its own confirmation.
    return ordinaryReply({ ...(await handleAction(separateExpense, ctx)), intent: "create_transaction" });
  }
  if (noticeFocus !== undefined && isLabelUndo(text)) {
    return keepNoticeFocus({ kind: "text", text: "I haven't undone anything. Open Review to change a specific payment, or start a new topic for a separate request.", intent: "chat:other" }, true);
  }
  const shortcut = ingest && !options.newTopic ? await labelShortcut(ingest, ctx.profile, text) : null;
  if (shortcut) return ordinaryReply({ kind: "text", text: shortcut.text, intent: "bank:label", buttons: shortcut.buttons });

  // Someone saying hello for the first time hears who Alfred is and what to do first.
  if (localGreeting(text) && deps.messages && (await deps.messages.listRecent(ctx.profile.profileId, 2)).filter((item) => item.clientId !== options.excludeClientId).length === 0) {
    return { kind: "text", text: await welcomeFor(ctx.profile, deps.bank), intent: "welcome" };
  }

  // Waiting payments are part of the conversation, so "Mitch was business" or "who's Mitch?" both work.
  const [waiting, pending, people, about, investments] = await Promise.all([
    ingest && !options.newTopic ? waitingPayments(ingest, ctx.profile, { currentMessageId }) : Promise.resolve(null),
    noticeFocus === undefined && !options.newTopic ? confirmation.fenced ? Promise.resolve(confirmation.pending) : latestOpenPending(ctx.store, ctx.profile.profileId, ctx.now) : Promise.resolve(null),
    notesForPrompt(deps.people, ctx.profile.profileId),
    aboutForPrompt(deps.notebook, ctx.profile.profileId),
    investmentsForPrompt(deps.investments, ctx.profile.profileId),
  ]);
  const acknowledgement = !waiting?.current ? closedNoticeAcknowledgement(text) : null;
  if (noticeFocus !== undefined && acknowledgement) {
    return keepNoticeFocus({ kind: "text", text: acknowledgement, intent: "chat:other" }, true);
  }
  // A vague answer isn't permission to invent a purpose, even if a model could
  // produce a plausible category. Keep the exact question open without a write.
  if (noticeFocus !== undefined && paymentPurposeUnclear(text, waiting?.current?.direction ?? "in")) {
    if (ingest && waiting?.current) {
      const again = await askAgain(ingest, ctx.profile, waiting.current, purposeQuestionIntro(waiting.current, "I'll leave this uncategorised until you tell me what it was for."));
      return keepNoticeFocus({ kind: "text", text: again.text, intent: "bank:label", buttons: again.buttons });
    }
    return keepNoticeFocus({ kind: "text", text: "That notice has no open purpose question. Tell me which payment you mean if you'd like to label one.", intent: "chat:other" }, true);
  }
  let open: string[] = [];
  const { action, context, cue, unread } = await interpretWithContext({
    text,
    profile: ctx.profile,
    store: ctx.store,
    now: ctx.now,
    interpret: deps.interpret,
    messages: options.newTopic ? null : deps.messages,
    excludeClientId: options.excludeClientId,
    channel: options.channel,
    waiting: waiting ? { lines: waiting.lines, current: waiting.currentNumber } : null,
    people,
    about,
    investments,
    model: waiting || actionsMayNeedCare(text) ? LABEL_MODEL : undefined,
    open: (history) => {
      open = openThread({ history: noticeFocus === undefined ? history : [], waiting, pending, now: ctx.now });
      if (noticeFocus !== undefined) {
        open.push(waiting?.currentNumber
          ? `Alfred just asked what waiting payment ${waiting.currentNumber} was for. A purpose answer refers to that payment only: use label_payments. If the purpose is unclear, ask; never guess it or log the same payment again.`
          : "The last private payment notice did not leave an open purpose question. A bare reply does not answer an older payment question or confirmation. Ask which payment they mean if needed.");
      }
      return open;
    },
  });
  logInfo("interpreted", { userId: ctx.profile.profileId, action: action.type === "several" ? action.actions.map((item) => item.type).join("+") : action.type });

  // A reply that couldn't be read, or that came while the model was down, most likely answers the
  // payment just asked about, so that question stays open with buttons that work without the model.
  if (unread && ingest && waiting?.current) {
    const intro = unread === "outage" ? OUTAGE_INTRO : undefined;
    const again = await askAgain(ingest, ctx.profile, waiting.current, noticeFocus !== undefined ? purposeQuestionIntro(waiting.current, intro ?? "I couldn't understand that answer.") : intro);
    return keepNoticeFocus({ kind: "text", text: again.text, intent: "bank:label", buttons: again.buttons });
  }

  const actions = actionsOf(action);
  // A purpose answer can label its exact captured source. It cannot create a
  // second transaction or silently turn into a different financial operation,
  // including when the original notice is already settled or no longer exists.
  const mutations = actions.filter((item) => NOTICE_FINANCIAL_MUTATIONS.has(item.type) || closedNotice && item.type === "label_payments");
  const allowedIndependent = closedNotice && mutations.length > 0 && mutations.every((item) => groundedIndependentMutation(item, text, ctx));
  if (noticeFocus !== undefined && mutations.length > 0 && !allowedIndependent) {
    if (ingest && waiting?.current) {
      const again = await askAgain(ingest, ctx.profile, waiting.current, purposeQuestionIntro(waiting.current, "I couldn't safely match that answer to the captured payment. Tell me its purpose again or choose below."));
      return keepNoticeFocus({ kind: "text", text: again.text, intent: "bank:label", buttons: again.buttons });
    }
    return keepNoticeFocus({ kind: "text", text: "That notice has no open purpose question. Nothing was changed. A different transaction needs its own request.", intent: "chat:other" }, true);
  }
  const focused = waiting?.exactQuestion ? waiting.current : null;
  if (ingest && focused && actions.some((item) => item.type === "label_payments" && resolvedFrom(item.answers, waiting!.listed).some((answer) => answer.messageIds.includes(focused.id) && !groundedPaymentLabel(text, focused, answer.label)))) {
    const again = await askAgain(ingest, ctx.profile, focused);
    const purpose = text.replace(/\s+/g, " ").trim().slice(0, 180);
    return keepNoticeFocus({ kind: "text", text: purposeQuestionIntro(focused, `I haven't changed this payment. You said “${purpose}”. Was it a gift, a repayment, your own money, or another type? Choose the matching answer below, or tell me the type.`), intent: "bank:label", buttons: again.buttons });
  }
  const purposeDetail = focused ? await earlierFocusedPurpose(deps.messages, ctx.profile.profileId, focused, text, options.excludeClientId) : null;
  const parts: TurnReply[] = [];
  for (const item of actions) {
    const confirmed = allowedIndependent && item.type === "create_transaction" ? { ...item, explicit: false } : item;
    parts.push(await perform(confirmed, { text, ctx, deps, ingest, waiting, pending: pending?.actionId ?? null, context, cue, open, channel: options.channel, purposeDetail }));
  }
  return keepNoticeFocus(combine(parts, action));
}

/** After a topic boundary, only the confirmation actually shown can answer a bare yes. */
async function confirmationAfterBoundary(deps: TurnDeps, ctx: ActionContext, options: TurnOptions): Promise<{ fenced: boolean; pending: PendingActionRecord | null }> {
  if (options.channel !== "web" || !deps.messages) return { fenced: false, pending: null };
  const history = (await deps.messages.listRecent(ctx.profile.profileId, 64)).filter(item => !options.excludeClientId || item.clientId !== options.excludeClientId);
  const fenced = history.some(item => item.paymentNotice || item.newTopic);
  if (!fenced || options.newTopic) return { fenced, pending: null };
  const last = history.at(-1);
  if (last?.role !== "assistant" || last.paymentNotice || !last.clientId || !isClientMessageId(last.clientId)) return { fenced, pending: null };
  const origin = String(clientTurnUpdateId(last.clientId));
  const intents = (last.intent ?? "").split("+");
  const matching = (await ctx.store.listPendingActions(ctx.profile.profileId)).filter(pending => {
    if (pending.userId !== ctx.profile.profileId || pending.chatId !== String(ctx.chatId) || pending.status !== "pending" || pending.actionType === "account_rule_command" || Date.parse(pending.expiresAt) <= ctx.now.getTime() || !intents.includes(pending.actionType)) return false;
    try {
      const payload = JSON.parse(pending.payloadJson) as { type?: unknown; originUpdateId?: unknown };
      return payload.type === pending.actionType && payload.originUpdateId === origin;
    } catch { return false; }
  });
  return { fenced, pending: matching.length === 1 ? matching[0] : null };
}

/** Closed notices allow only a separate, evidenced expense/budget request, always confirmed. */
function groundedIndependentMutation(action: FinanceAction, text: string, ctx: ActionContext): boolean {
  if ((action.type !== "create_transaction" && action.type !== "set_budget") || /[?\n;]/.test(text) || paymentPurposeUnclear(text, "out")) return false;
  const today = zonedYmd(ctx.now, ctx.profile.timezone);
  const period = /\b\d{4}-(?:0[1-9]|1[0-2])\b/.exec(text)?.[0] ?? today.slice(0, 7);
  const prose = text.replace(/\b\d{4}-\d{2}(?:-\d{2})?\b/g, "");
  const amounts = new Set((prose.match(/\d[\d,]*(?:\.\d{1,2})?/g) ?? []).map(value => canonicalizeAmount(value)).filter(Boolean));
  const currencies = new Set<string>();
  if (/(?:GH₵|₵)/i.test(text)) currencies.add("GHS");
  for (const match of prose.matchAll(/\b([a-z]{3})\s*\d|\d(?:[\d,.]*)\s*([a-z]{3})\b/gi)) {
    const currency = (match[1] ?? match[2]).toUpperCase();
    if (!["FOR", "THE", "AND"].includes(currency)) currencies.add(currency);
  }
  if (currencies.size > 1) return false;
  const currency = [...currencies][0] ?? ctx.profile.currency;
  const category = explicitExpenseCategory(prose);
  if (!category) return false;
  if (action.type === "set_budget") {
    const requested = /\b(?:set|change|update|make|create|limit)\b.*\bbudget\b|^\s*budget\b/i.test(text);
    return requested && amounts.has(canonicalizeAmount(action.amount)) && action.currency === currency
      && normalizeCategory(action.category, "expense") === category && (action.period ?? today.slice(0, 7)) === period;
  }
  if (action.transactions.length !== 1 || /\b(?:budget|income|salary|gift|loan|lent|borrowed|repaid|repayment|refund|received|that was|this was)\b/i.test(text)) return false;
  const entry = prose.replace(/\b(?:GHS|USD|EUR|GBP)\b|GH₵|₵|\d[\d,]*(?:\.\d{1,2})?/gi, "").trim().replace(/[.!]+$/g, "").trim().replace(/^(?:a|an|my)\s+/i, "");
  if (!/\b(?:spent|paid|bought|cost|purchase|purchased)\b/i.test(text) && !normalizeCategory(entry, "expense")) return false;
  const draft = action.transactions[0];
  if (draft.transaction_type !== "expense" || !amounts.has(canonicalizeAmount(draft.amount)) || draft.currency !== currency || normalizeCategory(draft.category, "expense") !== category || draft.date && draft.date !== today && !text.includes(draft.date)) return false;
  const words = new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const grounded = (value: string | null | undefined) => !value || (value.toLowerCase().match(/[a-z0-9]+/g) ?? []).every(word => words.has(word) || ["a", "an", "the", "for", "on", "expense"].includes(word) || normalizeCategory(word, "expense") === category);
  return grounded(draft.description) && grounded(draft.payment_method) && grounded(draft.notes);
}

/** Metadata supplies the reply target; the private notice body stays out of model history. */
export async function paymentNoticeFocus(messages: MessageLog | null | undefined, ownerId: string, options: TurnOptions): Promise<ChatMessageRecord["paymentNotice"] | null> {
  if (options.newTopic) return undefined;
  if (options.channel !== "web") return undefined;
  if (options.replyToPayment) return options.replyToPayment;
  if (!messages) return undefined;
  const history = await messages.listRecent(ownerId, 3);
  const last = history.filter((item) => !options.excludeClientId || item.clientId !== options.excludeClientId).at(-1);
  if (last?.role !== "assistant" || last.channel !== "web" || (!last.paymentNotice && last.intent !== "automation:incoming-payment")) return undefined;
  // Explicit null means no proactive question was displayed. A newly arrived
  // server notice may suppress old pointers, but cannot become the reply target.
  return options.replyToPayment === null && last.paymentNotice
    ? { ...last.paymentNotice, requiresPurpose: false }
    : last.paymentNotice ?? null;
}

function closedNoticeAcknowledgement(text: string): string | null {
  const said = text.trim().toLowerCase().replace(/[.!]+$/g, "").trim();
  if (/^(?:thanks(?: a lot)?|thank you(?: very much)?|cheers)$/.test(said)) return "You're welcome.";
  return /^(?:ok|okay|got it|alright|all right|yes|yeah|yep|sure)$/.test(said) ? "Got it." : null;
}

function independentExpenseRequest(text: string, defaultCurrency: string): Extract<FinanceAction, { type: "create_transaction" }> | null {
  const match = /^i\s+(?:just\s+)?spent\s+(?:(GHS|GH₵|₵|[A-Z]{3})\s*)?([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(?:(GHS|GH₵|₵|[A-Z]{3})\s+)?(?:on|for)\s+(.+?)[.!]?$/i.exec(text.trim());
  if (!match || /[\n;?]|\b(?:and|or|then|also|but|maybe|perhaps)\b/i.test(match[4])) return null;
  const amount = canonicalizeAmount(match[2]);
  const prefix = match[1]?.toUpperCase(), suffix = match[3]?.toUpperCase();
  const currencyOf = (value: string | undefined) => value === "GH₵" || value === "₵" ? "GHS" : value;
  if (prefix && suffix && currencyOf(prefix) !== currencyOf(suffix)) return null;
  const currency = currencyOf(prefix ?? suffix) ?? defaultCurrency;
  const category = explicitExpenseCategory(match[4]);
  if (!amount || !category || !/^[A-Z]{3}$/.test(currency) || match[4].length > 200) return null;
  return { type: "create_transaction", explicit: false, transactions: [{ transaction_type: "expense", amount, currency, category, description: match[4], payment_method: "", notes: "" }] };
}

/** Recover only the person's own earlier purpose for this exact open alert. Never model history. */
async function earlierFocusedPurpose(messages: MessageLog | null | undefined, ownerId: string, message: BankMessage, text: string, excludeClientId?: string | null): Promise<string | null> {
  if (!messages) return null;
  const classification = text.trim().replace(/[.!]+$/g, "").replace(/^(?:(?:it was|it's|a|an)\s+)+/i, "");
  if (!normalizeCategory(classification, message.direction === "in" ? "income" : "expense")) return null;
  const history = await messages.listRecent(ownerId, 20);
  const previous = [...history].reverse().find(item => item.role === "user" && item.paymentNotice?.bankMessageId === message.id && item.paymentNotice.requiresPurpose && (!excludeClientId || item.clientId !== excludeClientId)
    && item.body.trim().split(/\s+/).length > 1 && paymentPurposeNeedsClassification(item.body, message.direction));
  return previous?.body.replace(/\s+/g, " ").trim().slice(0, 200) ?? null;
}

function purposeQuestionIntro(message: BankMessage, intro: string): string {
  return message.readBy === "model" || message.kind === "unknown"
    ? `This is a possible payment alert; please check its details in Review. ${intro}`
    : intro;
}

const NOTICE_FINANCIAL_MUTATIONS = new Set<FinanceAction["type"]>([
  "create_transaction", "record_loan", "add_investment", "update_investment", "invest_money",
  "set_budget", "create_savings_goal", "update_savings_goal", "correct_transaction", "delete_transaction",
  "ignore_account", "answer_confirmation",
  "ask_next",
]);

/** Long or multi-part messages go to the stronger model, which reads them more carefully. */
function actionsMayNeedCare(text: string): boolean {
  return text.length > 160 || /\b(?:but|also|and then|plus)\b/i.test(text);
}

type Turn = {
  text: string;
  ctx: ActionContext;
  deps: TurnDeps;
  ingest: IngestDeps | null;
  waiting: WaitingPayments | null;
  pending: string | null;
  context: ConversationContext | null;
  cue: ChatCue;
  open: string[];
  channel: Channel;
  purposeDetail?: string | null;
};

/**
 * No bank text is waiting for a label, but the Accounts page can still list
 * movements that need a category or an account; say so rather than "all clear".
 */
export function nothingWaiting(attention: AttentionSummary | null | undefined): string {
  if (!attention?.total) return "Nothing is waiting for a label right now. Tell me what you spent, or ask how the month is going.";
  return `No bank texts are waiting for a label, but ${attentionLine(attention)} Open Accounts, then Needs attention, to sort them.`;
}

/** Said before re-asking a payment question when the model is down, so a tap still moves things on. */
export const OUTAGE_INTRO = "My thinking is running slow right now, so I couldn't take that in. Tap an answer below, or send it again in a minute. Nothing was saved.";

async function perform(action: FinanceAction, turn: Turn): Promise<TurnReply> {
  const { ctx, ingest, waiting } = turn;
  if (action.type === "label_payments") {
    const resolved = waiting ? resolvedFrom(action.answers, waiting.listed) : [];
    const answers = turn.purposeDetail ? resolved.map(answer => answer.label.kind === "category" ? { ...answer, label: { ...answer.label, description: turn.purposeDetail } } : answer) : resolved;
    const said = turn.purposeDetail ? `${turn.text}\n${turn.purposeDetail}` : turn.text;
    const labelled = ingest && waiting ? await applyResolved(ingest, ctx.profile, said, answers, waiting) : null;
    return { kind: "text", text: labelled?.text ?? UNMATCHED_LABEL, intent: "bank:label", buttons: labelled?.buttons };
  }
  if (action.type === "ask_next") {
    const asked = ingest ? await askNextReply(ingest, ctx.profile) : null;
    return asked
      ? { kind: "text", text: asked.text, intent: "bank:label", buttons: asked.buttons }
      : { kind: "text", text: nothingWaiting(turn.cue.attention), intent: "ask_next" };
  }
  if (action.type === "answer_confirmation") {
    if (!turn.pending) return { kind: "text", text: "There's nothing waiting for a yes or no right now. What would you like me to do?", intent: "answer_confirmation" };
    const decided = await decidePending({ decision: action.decision, actionId: turn.pending, chatId: null }, ctx);
    return { kind: "text", text: decided.text, context: decided.context, intent: "answer_confirmation" };
  }
  const delivery = await handleAction(action, { ...ctx, conversation: turn.context });
  const voiced = await voiceDelivery(turn.deps.voice, action, delivery, {
    userText: turn.text,
    profile: ctx.profile,
    channel: turn.channel,
    cue: turn.cue,
    state: stateLines(turn),
  });
  return { ...voiced, intent: intentOf(action) };
}

/** What's true right now, so the voice never contradicts it ("the books are quiet" with payments waiting). */
function stateLines(turn: Turn): string[] {
  const count = turn.waiting?.all.length ?? 0;
  return [
    count > 0 ? `${count === 1 ? "One payment from their bank texts is" : `${count} payments from their bank texts are`} waiting for them to say what ${count === 1 ? "it was" : "they were"}.` : "No payments from their bank texts are waiting for a label.",
    // The Accounts page's own list, so "nothing waiting" never reads as "everything is categorised".
    ...(turn.cue.attention ? [attentionLine(turn.cue.attention)] : []),
    ...turn.open,
  ];
}

/** Several replies as one message: texts in order, the last buttons and confirmation win. */
function combine(parts: TurnReply[], action: InterpretedAction): TurnReply {
  if (parts.length === 1) return parts[0];
  const text = parts.map((part) => part.text).join("\n\n");
  const confirm = [...parts].reverse().find((part) => part.kind === "confirm");
  const buttons = [...parts].reverse().find((part) => part.buttons?.length)?.buttons;
  const context = [...parts].reverse().find((part) => part.context)?.context;
  const chart = parts.find((part) => part.chart)?.chart;
  const intent = action.type === "several" ? action.actions.map((item) => intentOf(item)).join("+").slice(0, 60) : parts[0].intent;
  const base = confirm?.kind === "confirm" ? { kind: "confirm" as const, text, actionId: confirm.actionId } : { kind: "text" as const, text };
  return { ...base, ...(context ? { context } : {}), ...(chart ? { chart } : {}), ...(buttons ? { buttons } : {}), intent };
}

/** "Risevest (US stocks, USD)" for each investment, so the model can name the one the user means. */
async function investmentsForPrompt(store: InvestmentStore | null | undefined, ownerId: string): Promise<string[]> {
  if (!store) return [];
  return (await store.list(ownerId)).map((item) => `${item.name} (${KIND_LABELS[item.kind]}, ${item.currency}${item.maturesOn ? `, matures ${item.maturesOn}` : ""})`);
}
