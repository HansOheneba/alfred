import { clientTurnUpdateId, isClientMessageId, isPaymentNoticeIntent, type ChatMessageRecord, type MessageLog } from "@/lib/accounts/messages";
import type { InterpretRequest } from "@/lib/ai/deepseek";
import type { Channel } from "@/lib/ai/persona";
import { intentOf, keepsFacts, voiceDelivery, type Voice } from "@/lib/ai/voice";
import type { IngestDeps } from "@/lib/bank/ingest";
import {
  applyResolved,
  askAgain,
  askNextReply,
  LABEL_MODEL,
  isLabelUndo,
  groundedPaymentLabel,
  proposableLabel,
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
import { isPaymentSkipRequest, isUnresolvedPaymentNotice, PAYMENT_NOTICE_STAYS_PENDING } from "@/lib/bank/notice-policy";
import { questionFor } from "@/lib/bank/notify";
import { openThread } from "@/lib/conversation/thread";
import { welcomeFor } from "@/lib/conversation/welcome";
import { decidePaymentAnswer, nearbyIds, nearbyPayments, openLabelProposal, proposeLabels, type Proposal } from "@/lib/conversation/proposals";
import { handleAction, type ActionContext, type Delivery } from "@/lib/finance/action-router";
import { attentionLine, interpretWithContext, type ChatCue } from "@/lib/finance/context";
import type { AttentionSummary } from "@/lib/finance/accounting/types";
import type { LoanStore } from "@/lib/finance/loans";
import { answerTypedDecision, decidePending, latestOpenPending, typedDecision } from "@/lib/finance/pending";
import { actionsOf, type FinanceAction, type InterpretedAction } from "@/lib/finance/schemas";
import type { FinanceStore } from "@/lib/finance/store";
import type { ConversationContext } from "@/lib/finance/conversation";
import { createLookup } from "@/lib/conversation/lookups";
import { rememberedAnswers } from "@/lib/conversation/remembered";
import { remember } from "@/lib/learning/log";
import { logInfo } from "@/lib/log";
import { aboutForPrompt, type NotebookStore } from "@/lib/notebook/store";
import { notesForPrompt, type PeopleStore } from "@/lib/people/store";
import type { InlineButton } from "@/lib/telegram/client";
import { localGreeting } from "@/lib/telegram/messages";
import { KIND_LABELS, type InvestmentStore } from "@/lib/investments/store";
import { canonicalizeAmount, toMinor } from "@/lib/finance/money";
import { normalizeCategory } from "@/lib/finance/categories";
import { isRealDate, zonedYmd } from "@/lib/finance/dates";
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
  const started = Date.now();
  const seen: TurnSeen = { actions: [], model: null };
  const reply = await converseTurn(text, ctx, deps, options, seen);
  await remember(ctx.learning, (log) => log.trace({
    ownerId: ctx.profile.profileId, channel: options.channel === "telegram" ? "telegram" : "web", actions: seen.actions, model: seen.model,
    latencyMs: Date.now() - started, intent: reply.intent ?? null, proposed: reply.kind === "confirm", refused: /haven't changed this payment|couldn't tell which/i.test(reply.text),
  }));
  return reply;
}

/** What the model was asked and chose on this turn, for its trace. */
type TurnSeen = { actions: string[]; model: string | null };

async function converseTurn(text: string, ctx: ActionContext, deps: TurnDeps, options: TurnOptions, seen: TurnSeen): Promise<TurnReply> {
  const noticeFocus = await paymentNoticeFocus(deps.messages, ctx.profile.profileId, options);
  const closedNotice = Boolean(noticeFocus && !noticeFocus.requiresPurpose);
  const closedSource = closedNotice && noticeFocus ? await deps.bank?.getMessage(ctx.profile.profileId, noticeFocus.bankMessageId) : null;
  // Direction and duplicate evidence come from the owned source, never client metadata.
  const independentExpenseAllowed = closedSource?.ownerId === ctx.profile.profileId && closedSource.direction === "in" && closedSource.status !== "needs_label";
  const ownedOutgoing = closedSource?.ownerId === ctx.profile.profileId && closedSource.direction === "out" && closedSource.status !== "needs_label" ? closedSource : null;
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
  // A "yes" to Alfred's reading of this payment confirms that reading only.
  if (noticeFocus?.requiresPurpose && decision && !options.newTopic) {
    const proposal = await openLabelProposal(ctx, noticeFocus.bankMessageId);
    if (proposal) {
      const decided = await decidePending({ decision, actionId: proposal.actionId, chatId: null }, ctx);
      return keepNoticeFocus({ kind: "text", text: decided.text, intent: "bank:label" });
    }
  }

  const ingest: IngestDeps | null = deps.bank
    ? { bank: deps.bank, ledger: ctx.store, now: ctx.now, createId: deps.createId, loans: deps.loans ?? undefined, people: deps.people, investments: deps.investments ?? null }
    : null;
  if (!options.newTopic && noticeFocus && ingest && isPaymentSkipRequest(text)) {
    const source = await ingest.bank.getMessage(ctx.profile.profileId, noticeFocus.bankMessageId);
    if (source?.ownerId === ctx.profile.profileId && isUnresolvedPaymentNotice(source)) {
      const question = await questionFor(ingest.loans, ctx.profile, source, ingest.people, ingest.bank);
      return { kind: "text", text: PAYMENT_NOTICE_STAYS_PENDING, intent: "bank:label",
        buttons: question.buttons, paymentNotice: { bankMessageId: source.id, requiresPurpose: true } };
    }
  }
  const separateExpense = noticeFocus && !noticeFocus.requiresPurpose && independentExpenseAllowed ? independentExpenseRequest(text, ctx.profile.currency) : null;
  if (separateExpense) {
    // This is a new, explicit request rather than a purpose answer. The exact
    // user words supply one expense, and it always gets its own confirmation.
    return ordinaryReply({ ...(await handleAction(separateExpense, ctx)), intent: "create_transaction" });
  }
  if (noticeFocus !== undefined && isLabelUndo(text)) {
    return keepNoticeFocus({ kind: "text", text: "I haven't undone anything. Open Review to change a specific payment, or choose Ask something else for a separate request.", intent: "chat:other" }, true);
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
  // The payment Alfred is asking about: the alert being replied to, or the question Alfred just asked in chat.
  const askedAbout = waiting?.current && (waiting.exactQuestion || (noticeFocus === undefined && await alfredAskedAboutPayment(deps.messages, ctx.profile.profileId, options.excludeClientId))) ? waiting.current : null;
  const proposal = askedAbout ? await openProposalText(deps.messages, ctx, askedAbout.id, options.excludeClientId) : null;
  const remembered = askedAbout && deps.bank ? await rememberedAnswers({ bank: deps.bank, store: ctx.store, loans: deps.loans }, ctx.profile, askedAbout) : [];
  const earlier = noticeFocus?.requiresPurpose ? await saidAboutPayment(deps.messages, ctx.profile.profileId, noticeFocus.bankMessageId, options.excludeClientId) : [];
  const lookup = createLookup({ store: ctx.store, bank: deps.bank, loans: deps.loans, investments: deps.investments, notebook: deps.notebook, people: deps.people }, ctx.profile);
  const request = (said: string): Parameters<typeof interpretWithContext>[0] => ({
    text: said,
    lookup,
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
      if (noticeFocus !== undefined || askedAbout) {
        const nearby = waiting?.current ? nearbyPayments(waiting.current, waiting.listed, ctx.profile) : [];
        open.push(waiting?.currentNumber
          ? [
              `Alfred just asked what waiting payment ${waiting.currentNumber} was for. Answer it with label_payments. A short reply like "malt", "fuel" or "Claude" names what it was for: use the category it implies, with their word as the description.`,
              nearby.length ? `Other waiting payments around the same time: ${nearby.join("; ")}. If what the person says also explains one of these (a card top-up and the charge right after it, say), label it in the same answer.` : "",
              "Alfred shows the person its reading and asks before saving, so choose the label that matches what they mean in their own words: money out that someone will pay back is lent to that person, money moved onto their own card or account is own_transfer.",
              "lent only fits money OUT. When someone owes them for something paid from the card or account this money went onto, put lent on that later OUT payment, and keep this payment as own_transfer.",
              "A spending category never fits money IN. When money came onto their card or account to pay for something (\"that's what I used to pay for Claude\"), this payment is own_transfer and the category goes on the OUT payment it paid for, usually the one right after it.",
              remembered.length ? `How they filed payments like this one before: ${remembered.join("; ")}. If this one looks the same, or they say it's the same, propose the same reading; their own words always win.` : "",
              earlier.length ? `Earlier about this payment they said: ${earlier.map((item) => `"${item}"`).join(", then ")}. Read the new message together with that.` : "",
              proposal ? `Alfred already showed this reading, still waiting for a yes: "${proposal.replace(/\s+/g, " ").slice(0, 400)}". If the new message corrects or adds to it, answer with the full corrected set of labels.` : "",
              "If the purpose is unclear, ask; never invent a person or purpose they didn't give, or log the same payment again.",
            ].filter(Boolean).join(" ")
          : "The last private payment notice did not leave an open purpose question. A bare reply does not answer an older payment question or confirmation. Ask which payment they mean if needed.");
      }
      return open;
    },
  });
  let { action, context, cue, unread, lookedUp, found } = await interpretWithContext(request(text));
  // A "yes" to a question Alfred asked in plain words has no saved confirmation to settle.
  // It accepts what Alfred offered, so read it again as that request instead of a dead end.
  if (!pending && noticeFocus === undefined && isConfirmation(action)) {
    const asked = await alfredsOpenQuestion(deps.messages, ctx.profile.profileId, options.excludeClientId);
    if (asked) ({ action, context, cue, unread, lookedUp, found } = await interpretWithContext(request(`Yes, go ahead with what you asked: "${asked}"${text.trim().length > 12 ? ` (${text.trim()})` : ""}`)));
  }
  seen.actions = [...Array.from({ length: lookedUp ?? 0 }, () => "look_up"), ...actionsOf(action).map((item) => item.type)];
  seen.model = waiting || actionsMayNeedCare(text) ? LABEL_MODEL : "default";
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
  const independent = closedNotice ? await Promise.all(mutations.map(async (item) => {
    if (ownedOutgoing && item.type === "create_transaction" && item.transactions[0]?.transaction_type === "income") return groundedIndependentIncome(item, text, ctx);
    if (!groundedIndependentMutation(item, text, ctx)) return false;
    return item.type !== "create_transaction" || independentExpenseAllowed || Boolean(ownedOutgoing && await separateOutgoingExpense(item, ownedOutgoing, text, ctx));
  })) : [];
  const allowedIndependent = closedNotice && actions.length === 1 && mutations.length === 1 && independent.every(Boolean);
  if (noticeFocus !== undefined && mutations.length > 0 && !allowedIndependent) {
    if (ingest && waiting?.current) {
      const again = await askAgain(ingest, ctx.profile, waiting.current, purposeQuestionIntro(waiting.current, "I couldn't safely match that answer to the captured payment. Tell me its purpose again or choose below."));
      return keepNoticeFocus({ kind: "text", text: again.text, intent: "bank:label", buttons: again.buttons });
    }
    return keepNoticeFocus({ kind: "text", text: "That notice has no open purpose question. Nothing was changed. For a separate transaction, choose Ask something else or give its different amount, currency and date.", intent: "chat:other" }, true);
  }
  const focused = askedAbout;
  if (ingest && focused && actions.some((item) => item.type === "label_payments")) {
    const proposals = actions.flatMap((item) => item.type === "label_payments" ? resolvedFrom(item.answers, waiting!.listed) : [])
      .flatMap((answer) => answer.messageIds.map((id) => ({ message: waiting!.listed.find((message) => message.id === id), label: answer.label })))
      .filter((item): item is Proposal => Boolean(item.message));
    const said = [text, ...(people ?? []), ...remembered];
    const fits = (item: Proposal) => groundedPaymentLabel(text, item.message, item.label) || proposableLabel(text, item.message, item.label, said);
    // A right reading with an embellished note ("Mtcgame purchase on my card") keeps the reading and drops the note.
    const cleaned = proposals.map((item) => fits(item) ? item : fits({ ...item, label: withoutDetails(item.label) }) ? { ...item, label: withoutDetails(item.label) } : item);
    const decision = decidePaymentAnswer({
      text, asked: focused, proposals: cleaned, nearby: nearbyIds(focused, waiting!.listed),
      grounded: groundedPaymentLabel, proposable: (words, message, label) => proposableLabel(words, message, label, said),
    });
    // Filing goes through the model's own labels, so a reading that only fits once its note is dropped is confirmed instead.
    const nearby = nearbyIds(focused, waiting!.listed);
    const trimmed = decision.kind === "file" && cleaned.some((item, index) => item !== proposals[index])
      ? cleaned.filter((item) => item.message.id === focused.id || nearby.has(item.message.id)) : null;
    const proposed = decision.kind === "propose" ? await proposeLabels(ctx, decision.items, ctx.profile, text)
      : trimmed?.length ? await proposeLabels(ctx, trimmed, ctx.profile, text) : null;
    if (proposed) return keepNoticeFocus({ ...proposed, intent: "bank:label" });
    if (decision.kind !== "file") {
      const again = await askAgain(ingest, ctx.profile, focused);
      const purpose = text.replace(/\s+/g, " ").trim().slice(0, 180);
      return keepNoticeFocus({ kind: "text", text: purposeQuestionIntro(focused, `I haven't changed this payment. You said “${purpose}”, and I couldn't turn that into a label I'm sure of. Was it a gift, a repayment, your own money, or another type? Choose below, or tell me in other words.`), intent: "bank:label", buttons: again.buttons });
    }
  }
  const purposeDetail = focused ? await earlierFocusedPurpose(deps.messages, ctx.profile.profileId, focused, text, options.excludeClientId) : null;
  const parts: TurnReply[] = [];
  for (const item of actions) {
    const confirmed = allowedIndependent && item.type === "create_transaction" ? { ...item, explicit: false } : item;
    parts.push(await perform(confirmed, { text, ctx, deps, ingest, waiting, pending: pending?.actionId ?? null, context, cue, open, channel: options.channel, purposeDetail, lookedUp, found }));
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
    // A proposal is shown under a bank:label message, so its type is never the message's intent; the same-turn check below still binds it.
    if (pending.userId !== ctx.profile.profileId || pending.chatId !== String(ctx.chatId) || pending.status !== "pending" || pending.actionType === "account_rule_command" || Date.parse(pending.expiresAt) <= ctx.now.getTime() || !(intents.includes(pending.actionType) || pending.actionType === "label_payments")) return false;
    try {
      const payload = JSON.parse(pending.payloadJson) as { type?: unknown; originUpdateId?: unknown };
      return payload.type === pending.actionType && payload.originUpdateId === origin;
    } catch { return false; }
  });
  return { fenced, pending: matching.length === 1 ? matching[0] : null };
}

/** A closed debit can share an amount with its principal, fee or fee-inclusive
 * total. Resolve only this event's source rows; an unresolved external match
 * needs the explicit new-topic gesture instead of a history-wide guess. */
async function separateOutgoingExpense(action: Extract<FinanceAction, { type: "create_transaction" }>, source: BankMessage, text: string, ctx: ActionContext): Promise<boolean> {
  const draft = action.transactions[0];
  if (action.transactions.length !== 1 || draft.transaction_type !== "expense") return false;
  const explicitDates = text.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? [];
  const explicitDate = explicitDates[0];
  if (explicitDates.length > 1 || explicitDate && (!isRealDate(explicitDate) || draft.date !== explicitDate)) return false;
  const prose = text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, "");
  if (/[\p{Pd}\u2212+]\s*(?:(?:[a-z]{3}|GH₵|₵)\s*)?\d/iu.test(prose) || /\b(?:yesterday|tomorrow|last|next|ago)\b/i.test(prose)
    || (prose.match(/\d[\d,]*(?:\.\d{1,2})?/g) ?? []).length !== 1) return false;
  const sourceAmount = toMinor(source.amount), fee = toMinor(source.fee);
  let principalAmount = sourceAmount;
  const amounts = new Set([sourceAmount, sourceAmount + fee, sourceAmount - fee, fee].filter(value => value > 0));
  const dates = new Set([zonedYmd(new Date(source.occurredAt), ctx.profile.timezone)]);
  if (source.transactionId) {
    const rows = await ctx.store.findTransactionsBySource(ctx.profile.profileId, `bank:${source.id}`);
    const principal = rows.find(row => row.userId === ctx.profile.profileId && row.transactionId === source.transactionId && row.status === "active");
    if (!principal || principal.type !== "expense" || principal.currency !== source.currency || toMinor(principal.amount) <= 0) return false;
    const amount = toMinor(principal.amount);
    principalAmount = amount;
    amounts.add(amount); amounts.add(amount + fee);
    if (sourceAmount > amount) amounts.add(sourceAmount - amount);
    dates.add(principal.transactionDate);
  }
  if (source.feeTransactionId) {
    const rows = await ctx.store.findTransactionsBySource(ctx.profile.profileId, `bank:${source.id}:fee`);
    const linkedFee = rows.find(row => row.userId === ctx.profile.profileId && row.transactionId === source.feeTransactionId && row.status === "active");
    if (!linkedFee || linkedFee.type !== "expense" || linkedFee.currency !== source.currency || toMinor(linkedFee.amount) <= 0) return false;
    const amount = toMinor(linkedFee.amount); amounts.add(amount); amounts.add(sourceAmount + amount); amounts.add(principalAmount + amount); dates.add(linkedFee.transactionDate);
  }
  if (draft.currency !== source.currency) return new RegExp(`\\b${draft.currency}(?=\\b|\\d)`, "i").test(text) || draft.currency === "GHS" && /GH₵|₵/.test(text);
  if (!amounts.has(toMinor(draft.amount))) return true;
  // A model's default date is not evidence that the user meant a different day.
  return Boolean(explicitDate && draft.date === explicitDate && !dates.has(explicitDate));
}

/** A captured debit cannot duplicate a separately requested income. Accept only
 * a single explicit instruction whose financial fields are present in the user's
 * words; borrowing, refunds and transfers retain their existing special flows. */
function groundedIndependentIncome(action: Extract<FinanceAction, { type: "create_transaction" }>, text: string, ctx: ActionContext): boolean {
  const instruction = /^(?:please\s+)?(?:record|log|add)\s+/i.test(text.trim());
  const received = /^(?:i\s+)?(?:received|earned|got|made)\s+/i.test(text.trim());
  const namedIncome = /^(?:salary|paycheck|wages?|gift|income|business\s+income|other\s+income|freelance\s+income)(?=\s|\d)/i.test(text.trim());
  if (action.transactions.length !== 1 || !(instruction || received || namedIncome)
    || instruction && !/\b(?:income|salary|paycheck|wages?|gift)(?=\s|\d|$)/i.test(text)
    || /[?\n;]|\b(?:and|or|then|also|but|maybe|perhaps|probably|think|guess|not|never|loan|lent|borrow\w*|owe|owed|owing|debt|repay\w*|repaid|refund|reimbursement|return\w*|transfer|deposit|own money|my own|on behalf|pay back|to|expense|spent|paid|yesterday|tomorrow|last|next|that|this|it was)\b/i.test(text)) return false;
  const draft = action.transactions[0];
  if (draft.transaction_type !== "income") return false;
  const dates = text.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? [];
  const explicitDate = dates[0];
  if (dates.length > 1 || explicitDate && !isRealDate(explicitDate)) return false;
  const date = explicitDate ?? zonedYmd(ctx.now, ctx.profile.timezone);
  if (explicitDate ? draft.date !== date : draft.date && draft.date !== date) return false;
  const prose = explicitDate ? text.replace(explicitDate, "") : text;
  if (/[\p{Pd}\u2212+]\s*(?:(?:[a-z]{3}|GH₵|₵)\s*)?\d/iu.test(prose)) return false;
  const amounts = prose.match(/\d[\d,]*(?:\.\d{1,2})?/g) ?? [];
  const amount = amounts.length === 1 ? canonicalizeAmount(amounts[0]) : null;
  if (!amount || amount !== canonicalizeAmount(draft.amount)) return false;
  const currencies = new Set<string>();
  for (const match of [...prose.matchAll(/\b([a-z]{3})\s*(?=\d)/gi), ...prose.matchAll(/\d[\d,.]*\s*([a-z]{3})\b/gi)]) {
    const currency = match[1].toUpperCase();
    if (!["FOR", "THE", "AND", "NEW", "ADD", "LOG", "GOT"].includes(currency)) currencies.add(currency);
  }
  if (/GH₵|₵/.test(prose)) currencies.add("GHS");
  if (currencies.size > 1 || draft.currency !== ([...currencies][0] ?? ctx.profile.currency)) return false;
  const categories = new Set((prose.toLowerCase().match(/\p{L}+/gu) ?? []).map(word => normalizeCategory(word, "income")).filter(Boolean));
  const category = normalizeCategory(draft.category, "income");
  if (!category || category === "Refund" || categories.size !== 1 || !categories.has(category)) return false;
  if (category === "Gift" && (!/^(?:i\s+)?(?:received|got)\s+|\bincome\b/i.test(text.trim()) || /\bfor\b/i.test(text))) return false;
  const words = new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const grounded = (value: string | null | undefined) => !value || (value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).length > 0 && (value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).every(word => words.has(word) || ["a", "an", "the", "for", "on", "income"].includes(word) || normalizeCategory(word, "income") === category);
  return grounded(draft.description) && grounded(draft.payment_method) && grounded(draft.notes);
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
  for (const match of [...prose.matchAll(/\b([a-z]{3})\s*(?=\d)/gi), ...prose.matchAll(/\d[\d,.]*\s*([a-z]{3})\b/gi)]) {
    const currency = match[1].toUpperCase();
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
  const words = new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const grounded = (value: string | null | undefined) => !value || (value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).length > 0 && (value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).every(word => words.has(word) || ["a", "an", "the", "for", "on", "expense"].includes(word) || normalizeCategory(word, "expense") === category);
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
  if (last?.role !== "assistant" || last.channel !== "web" || (!last.paymentNotice && !isPaymentNoticeIntent(last.intent))) return undefined;
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

/**
 * Whether a message goes to the stronger model. Plain logging ("uber 35",
 * "spent 50 on food") stays on the everyday one; questions, corrections,
 * money between people, planning and anything long or multi-part get the
 * model that reads more carefully.
 */
export function actionsMayNeedCare(text: string): boolean {
  const lower = text.trim().toLowerCase();
  if (lower.length > 160) return true;
  // Several things in one message.
  if (/\b(?:but|also|and then|plus)\b/.test(lower)) return true;
  if ((lower.match(/\d+(?:[.,]\d+)?/g) ?? []).length >= 3) return true;
  // Questions.
  if (lower.includes("?")) return true;
  if (/^(?:how|what|why|when|who|whose|which|where|did|do|does|is|are|was|were|can|could|should|have|has|show|list|compare|explain|tell me)\b/.test(lower)) return true;
  // Corrections.
  if (/^(?:no|nope|actually|wait|sorry)\b/.test(lower)) return true;
  if (/\b(?:wrong|instead|meant|mistake|change|edit|fix|correct|delete|remove)\b/.test(lower)) return true;
  // Money between people.
  if (/\b(?:owe[sd]?|lent|lend|borrow(?:ed)?|pa(?:y|id) (?:me |him |her |them )?back|repa(?:y|id)|split|chip(?:ped)? in|on (?:his|her|their|my) behalf)\b/.test(lower)) return true;
  // Planning.
  if (/\b(?:budget|goal|afford|invest(?:ed|ment)?|sav(?:e|ing) (?:for|up))\b/.test(lower)) return true;
  return false;
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
  /** The model looked records up this turn, so its reply rests on results the voice never sees. */
  lookedUp?: number;
  found?: { query: string; lines: string[] }[];
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
  // An answer built from lookups is kept as the model wrote it: the voice only sees the snapshot and would undo it.
  // Every figure in it must come from the results; if not, the results are shown plainly instead.
  const voiced = turn.lookedUp ? groundedInLookups(delivery, turn) : await voiceDelivery(turn.deps.voice, action, delivery, {
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

/** The model settling a confirmation with a yes, alone or first among several actions. */
function isConfirmation(action: InterpretedAction): boolean {
  const first = action.type === "several" ? action.actions[0] : action;
  return first?.type === "answer_confirmation" && first.decision === "confirm";
}

/** Alfred's last message, when it was a plain question still waiting for its answer. */
async function alfredsOpenQuestion(messages: MessageLog | null | undefined, ownerId: string, excludeClientId?: string | null): Promise<string | null> {
  if (!messages) return null;
  const recent = (await messages.listRecent(ownerId, 4)).filter((item) => !excludeClientId || item.clientId !== excludeClientId);
  const last = recent.at(-1);
  if (last?.role !== "assistant" || last.paymentNotice || /^bank:/.test(last.intent ?? "")) return null;
  const body = last.body.replace(/\s+/g, " ").trim();
  return body.endsWith("?") ? body.slice(0, 400) : null;
}

/** What Alfred last proposed for this payment, while that proposal is still open. */
async function openProposalText(messages: MessageLog | null | undefined, ctx: ActionContext, bankMessageId: string, excludeClientId?: string | null): Promise<string | null> {
  if (!messages || !(await openLabelProposal(ctx, bankMessageId))) return null;
  const recent = (await messages.listRecent(ctx.profile.profileId, 8)).filter((item) => !excludeClientId || item.clientId !== excludeClientId);
  return [...recent].reverse().find((item) => item.role === "assistant" && item.body.startsWith("Here's how I read"))?.body ?? null;
}

/** What the person already said in reply to this payment's alert, oldest first. */
async function saidAboutPayment(messages: MessageLog | null | undefined, ownerId: string, bankMessageId: string, excludeClientId?: string | null): Promise<string[]> {
  if (!messages) return [];
  const recent = (await messages.listRecent(ownerId, 12)).filter((item) => !excludeClientId || item.clientId !== excludeClientId);
  return recent.filter((item) => item.role === "user" && item.paymentNotice?.bankMessageId === bankMessageId)
    .map((item) => item.body.replace(/\s+/g, " ").trim().slice(0, 300)).slice(-3);
}

/** Whether Alfred's last chat message was its question about a waiting payment. */
async function alfredAskedAboutPayment(messages: MessageLog | null | undefined, ownerId: string, excludeClientId?: string | null): Promise<boolean> {
  if (!messages) return false;
  const last = (await messages.listRecent(ownerId, 4)).filter((item) => !excludeClientId || item.clientId !== excludeClientId).at(-1);
  return last?.role === "assistant" && /^bank:/.test(last.intent ?? "") && last.body.includes("?");
}

/** A lookup-based reply whose figures all come from the results, or the results themselves when they don't. */
function groundedInLookups(delivery: Delivery, turn: Turn): Delivery {
  if (delivery.kind !== "text") return delivery;
  const results = (turn.found ?? []).flatMap((item) => item.lines);
  if (keepsFacts(delivery.text, [...results, turn.text, turn.cue.snapshot].join("\n"))) return delivery;
  logInfo("lookup_reply_rejected", { userId: turn.ctx.profile.profileId });
  return { ...delivery, text: ["Here's what I found:", ...results.slice(0, 8)].join("\n") };
}

/** The same label without the model's free-text extras, which are the part most often not in the person's words. */
function withoutDetails(label: Proposal["label"]): Proposal["label"] {
  const plain: Record<string, unknown> = { ...label };
  for (const key of ["description", "note"]) if (key in plain) plain[key] = null;
  return plain as Proposal["label"];
}
