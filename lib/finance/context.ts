import type { InterpretRequest } from "@/lib/ai/deepseek";
import type { Channel } from "@/lib/ai/persona";
import type { ChatMessageRecord, MessageLog } from "@/lib/accounts/messages";
import type { UserProfile } from "@/lib/config";
import { LIMITS } from "@/lib/config";
import { AiError } from "@/lib/errors";
import { applyFollowUp, readConversation, type ConversationContext } from "@/lib/finance/conversation";
import type { InterpretedAction } from "@/lib/finance/schemas";
import { readReporting, type FinanceStore } from "@/lib/finance/store";
import type { AttentionSummary } from "@/lib/finance/accounting/types";
import { zonedYmd } from "@/lib/finance/dates";
import { formatMinor, toMinor } from "@/lib/finance/money";
import { logError } from "@/lib/log";
import type { TransactionRecord } from "@/lib/finance/types";
import { conversationalFallback } from "@/lib/telegram/messages";

export async function interpretWithContext(input: {
  text: string;
  profile: UserProfile;
  store: FinanceStore;
  now: Date;
  interpret: (request: InterpretRequest) => Promise<InterpretedAction>;
  messages?: MessageLog | null;
  excludeClientId?: string | null;
  channel: Channel;
  /** Bank payments waiting for a label, which the user may be answering about. */
  waiting?: { lines: string[]; current: number } | null;
  /** What the user has told Alfred about people. */
  people?: string[];
  /** What Alfred has learnt about the user themself. */
  about?: string[];
  /** The user's investments, one per line. */
  investments?: string[];
  model?: string;
  /** Works out what's open in the conversation from its recent messages. */
  open?: (history: ChatMessageRecord[]) => string[];
}): Promise<{ action: InterpretedAction; context: ConversationContext | null; cue: ChatCue; /** Why the model gave nothing usable, so `action` is a stock fallback: its reply couldn't be read, or it was down or too slow. */ unread?: "invalid" | "outage" }> {
  const ownerId = input.profile.profileId;
  const [transactions, context, budgets, goals, history, reporting] = await Promise.all([
    input.store.listTransactions(ownerId),
    readConversation(input.store, ownerId),
    input.store.listBudgets(ownerId),
    input.store.listSavingsGoals(ownerId),
    input.messages ? input.messages.listRecent(ownerId, LIMITS.maxHistory) : Promise.resolve([]),
    readReporting(input.store, ownerId),
  ]);
  const recent = transactions
    .filter((item) => item.status === "active")
    .sort((left, right) => right.transactionDate.localeCompare(left.transactionDate) || right.rowNumber - left.rowNumber)
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
  // Deterministic private payment notices are not an extra source of model
  // history. The normal, user-requested ledger context remains unchanged.
  const ownHistory = history.filter((item) => !item.paymentNotice && item.intent !== "automation:incoming-payment" && (!input.excludeClientId || item.clientId !== input.excludeClientId));
  const cue: ChatCue = {
    offTopicTurn: offTopicStreak(ownHistory) + 1,
    history: ownHistory.slice(-8).map((item) => ({ role: item.role, body: item.body.slice(0, 400) })),
    snapshot: snapshotLine(reporting, input.profile, input.now),
    attention: reporting.attention,
  };
  let interpreted: InterpretedAction;
  try {
    interpreted = await input.interpret({
      text: input.text,
      timezone: input.profile.timezone,
      currency: input.profile.currency,
      now: input.now,
      recent,
      context,
      preferredName: input.profile.preferredName,
      communicationPreference: input.profile.communicationPreference,
      toneNote: input.profile.toneNote,
      telegramUserId: input.profile.telegramUserId,
      channel: input.channel,
      budgets: budgets.slice(0, 12).map((item) => ({
        period: item.period,
        category: item.category,
        amount: item.amount,
        currency: item.currency,
      })),
      goals: goals.slice(0, 8).map((item) => ({
        name: item.name,
        currentAmount: item.currentAmount,
        targetAmount: item.targetAmount,
        currency: item.currency,
      })),
      history: ownHistory.map((item) => ({
          role: item.role,
          body: item.body.slice(0, 500),
        })),
      waiting: input.waiting,
      people: input.people,
      about: input.about,
      investments: input.investments,
      model: input.model,
      open: input.open?.(ownHistory),
    });
  } catch (error) {
    if (error instanceof AiError && error.code === "invalid") {
      logError("interpret_unread", error);
      return { action: { type: "chat", message: conversationalFallback(input.text) }, context, cue, unread: "invalid" };
    }
    // While a payment question is open, its buttons still work without the model, so the turn can carry on.
    if (error instanceof AiError && (error.code === "unavailable" || error.code === "timeout") && input.waiting?.current) {
      logError("interpret_outage", error);
      return { action: { type: "chat", message: conversationalFallback(input.text) }, context, cue, unread: "outage" };
    }
    throw error;
  }
  const action = interpreted.type === "several" ? interpreted : applyFollowUp(input.text, interpreted, context);
  return { action, context, cue };
}

/** What the voice needs to hold a natural conversation without drifting from money. */
export type ChatCue = {
  /** 1 for the first off-topic message in a row, 2 for the second, and so on. */
  offTopicTurn: number;
  history: { role: "user" | "assistant"; body: string }[];
  snapshot: string;
  /** What the Accounts page lists under Needs attention, or null when the ledger can't say. */
  attention?: AttentionSummary | null;
};

/** Assistant replies in a row, newest first, that were off-topic chat. */
export function offTopicStreak(history: ChatMessageRecord[]): number {
  let streak = 0;
  for (const message of [...history].reverse()) {
    if (message.role !== "assistant") continue;
    if (message.intent !== "chat:other") break;
    streak += 1;
  }
  return streak;
}

function snapshotLine({ transactions, attention }: { transactions: TransactionRecord[]; attention: AttentionSummary | null }, profile: UserProfile, now: Date): string {
  const today = zonedYmd(now, profile.timezone);
  const expenses = transactions.filter(
    (item) => item.status === "active" && item.type === "expense" && item.currency === profile.currency,
  );
  const sum = (rows: TransactionRecord[]) => rows.reduce((total, item) => total + toMinor(item.amount), 0);
  const todayRows = expenses.filter((item) => item.transactionDate === today);
  const month = expenses.filter((item) => item.transactionDate.startsWith(today.slice(0, 7)));
  const todayText = todayRows.length
    ? `${formatMinor(sum(todayRows), profile.currency)} spent today across ${todayRows.length} expenses`
    : "nothing logged today yet";
  return `Today: ${todayText}. This month so far: ${formatMinor(sum(month), profile.currency)} spent.${attention ? ` ${attentionLine(attention)}` : ""}`;
}

/** What the Accounts page lists under Needs attention, in words Alfred can repeat. */
export function attentionLine(attention: AttentionSummary): string {
  if (attention.total === 0) return "Nothing on the Accounts page needs attention.";
  const reasons = [
    attention.review ? `${attention.review} waiting for a category` : "",
    attention.unassigned ? `${attention.unassigned} with no account assigned` : "",
    attention.hold ? `${attention.hold} on hold` : "",
  ].filter(Boolean);
  return `${attention.total} ${attention.total === 1 ? "movement needs" : "movements need"} attention on the Accounts page (${reasons.join(", ")}).`;
}
