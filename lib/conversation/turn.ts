import type { MessageLog } from "@/lib/accounts/messages";
import type { InterpretRequest } from "@/lib/ai/deepseek";
import type { Channel } from "@/lib/ai/persona";
import { intentOf, voiceDelivery, type Voice } from "@/lib/ai/voice";
import type { IngestDeps } from "@/lib/bank/ingest";
import {
  applyResolved,
  askNextReply,
  LABEL_MODEL,
  labelShortcut,
  resolvedFrom,
  UNMATCHED_LABEL,
  waitingPayments,
  type WaitingPayments,
} from "@/lib/bank/reply";
import type { BankStore } from "@/lib/bank/store";
import { openThread } from "@/lib/conversation/thread";
import { welcomeFor } from "@/lib/conversation/welcome";
import { handleAction, type ActionContext, type Delivery } from "@/lib/finance/action-router";
import { interpretWithContext, type ChatCue } from "@/lib/finance/context";
import type { LoanStore } from "@/lib/finance/loans";
import { answerTypedDecision, decidePending, latestOpenPending } from "@/lib/finance/pending";
import { actionsOf, type FinanceAction, type InterpretedAction } from "@/lib/finance/schemas";
import type { FinanceStore } from "@/lib/finance/store";
import type { ConversationContext } from "@/lib/finance/conversation";
import { logInfo } from "@/lib/log";
import { aboutForPrompt, type NotebookStore } from "@/lib/notebook/store";
import { notesForPrompt, type PeopleStore } from "@/lib/people/store";
import type { InlineButton } from "@/lib/telegram/client";
import { localGreeting } from "@/lib/telegram/messages";

/** What a conversation turn needs, from Telegram or the website. */
export type TurnDeps = {
  store: FinanceStore;
  interpret: (request: InterpretRequest) => Promise<InterpretedAction>;
  createId: () => string;
  messages?: MessageLog | null;
  voice?: Voice | null;
  bank?: BankStore | null;
  loans?: LoanStore | null;
  people?: PeopleStore | null;
  notebook?: NotebookStore | null;
};

/** Alfred's reply to one message, with buttons for Telegram and the intent stored with it. */
export type TurnReply = Delivery & { intent?: string; buttons?: InlineButton[][] };

/**
 * Answers one typed message as the next line of the conversation. Settled
 * without the model when it can be ("undo", a bare yes to an open
 * confirmation); otherwise the model reads it against the recent messages and
 * what's open, and may ask for a few actions, done in order.
 */
export async function converse(text: string, ctx: ActionContext, deps: TurnDeps, options: { channel: Channel; excludeClientId?: string | null }): Promise<TurnReply> {
  const settled = await answerTypedDecision(text, ctx);
  if (settled) return { kind: "text", text: settled.text, context: settled.context };

  const ingest: IngestDeps | null = deps.bank
    ? { bank: deps.bank, ledger: ctx.store, now: ctx.now, createId: deps.createId, loans: deps.loans ?? undefined, people: deps.people }
    : null;
  const shortcut = ingest ? await labelShortcut(ingest, ctx.profile, text) : null;
  if (shortcut) return { kind: "text", text: shortcut.text, intent: "bank:label", buttons: shortcut.buttons };

  // Someone saying hello for the first time hears who Alfred is and what to do first.
  if (localGreeting(text) && deps.messages && (await deps.messages.listRecent(ctx.profile.profileId, 2)).filter((item) => item.clientId !== options.excludeClientId).length === 0) {
    return { kind: "text", text: await welcomeFor(ctx.profile, deps.bank), intent: "welcome" };
  }

  // Waiting payments are part of the conversation, so "Mitch was business" or "who's Mitch?" both work.
  const waiting = ingest ? await waitingPayments(ingest, ctx.profile) : null;
  const pending = await latestOpenPending(ctx.store, ctx.profile.profileId, ctx.now);
  let open: string[] = [];
  const { action, context, cue } = await interpretWithContext({
    text,
    profile: ctx.profile,
    store: ctx.store,
    now: ctx.now,
    interpret: deps.interpret,
    messages: deps.messages,
    excludeClientId: options.excludeClientId,
    channel: options.channel,
    waiting: waiting ? { lines: waiting.lines, current: waiting.currentNumber } : null,
    people: await notesForPrompt(deps.people, ctx.profile.profileId),
    about: await aboutForPrompt(deps.notebook, ctx.profile.profileId),
    model: waiting || actionsMayNeedCare(text) ? LABEL_MODEL : undefined,
    open: (history) => (open = openThread({ history, waiting, pending, now: ctx.now })),
  });
  logInfo("interpreted", { userId: ctx.profile.profileId, action: action.type === "several" ? action.actions.map((item) => item.type).join("+") : action.type });

  const parts: TurnReply[] = [];
  for (const item of actionsOf(action)) {
    parts.push(await perform(item, { text, ctx, deps, ingest, waiting, pending: pending?.actionId ?? null, context, cue, open, channel: options.channel }));
  }
  return combine(parts, action);
}

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
};

async function perform(action: FinanceAction, turn: Turn): Promise<TurnReply> {
  const { ctx, ingest, waiting } = turn;
  if (action.type === "label_payments") {
    const labelled = ingest && waiting ? await applyResolved(ingest, ctx.profile, turn.text, resolvedFrom(action.answers, waiting.listed), waiting) : null;
    return { kind: "text", text: labelled?.text ?? UNMATCHED_LABEL, intent: "bank:label", buttons: labelled?.buttons };
  }
  if (action.type === "ask_next") {
    const asked = ingest ? await askNextReply(ingest, ctx.profile) : null;
    return asked
      ? { kind: "text", text: asked.text, intent: "bank:label", buttons: asked.buttons }
      : { kind: "text", text: "Nothing is waiting for a label right now. Tell me what you spent, or ask how the month is going.", intent: "ask_next" };
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
    count > 0 ? `${count === 1 ? "One payment from their bank texts is" : `${count} payments from their bank texts are`} waiting for them to say what ${count === 1 ? "it was" : "they were"}.` : "No payments are waiting for a label.",
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
