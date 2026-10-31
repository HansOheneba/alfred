import type { InterpretRequest } from "@/lib/ai/deepseek";
import type { Channel } from "@/lib/ai/persona";
import type { ChatMessageRecord, MessageLog } from "@/lib/accounts/messages";
import type { UserProfile } from "@/lib/config";
import { LIMITS } from "@/lib/config";
import { AiError } from "@/lib/errors";
import { applyFollowUp, readConversation, type ConversationContext } from "@/lib/finance/conversation";
import type { FinanceAction } from "@/lib/finance/schemas";
import type { FinanceStore } from "@/lib/finance/store";
import { zonedYmd } from "@/lib/finance/dates";
import { formatMinor, toMinor } from "@/lib/finance/money";
import type { TransactionRecord } from "@/lib/finance/types";
import { conversationalFallback } from "@/lib/telegram/messages";

export async function interpretWithContext(input: {
  text: string;
  profile: UserProfile;
  store: FinanceStore;
  now: Date;
  interpret: (request: InterpretRequest) => Promise<FinanceAction>;
  messages?: MessageLog | null;
  excludeClientId?: string | null;
  channel: Channel;
  /** Bank payments waiting for a label, which the user may be answering about. */
  waiting?: { lines: string[]; current: number } | null;
  /** What the user has told Alfred about people. */
  people?: string[];
  /** What Alfred has learnt about the user themself. */
  about?: string[];
  model?: string;
}): Promise<{ action: FinanceAction; context: ConversationContext | null; cue: ChatCue }> {
  const ownerId = input.profile.profileId;
  const transactions = await input.store.listTransactions(ownerId);
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
  const context = await readConversation(input.store, ownerId);
  const [budgets, goals, history] = await Promise.all([
    input.store.listBudgets(ownerId),
    input.store.listSavingsGoals(ownerId),
    input.messages ? input.messages.listRecent(ownerId, LIMITS.maxHistory) : Promise.resolve([]),
  ]);
  const ownHistory = history.filter((item) => !input.excludeClientId || item.clientId !== input.excludeClientId);
  const cue: ChatCue = {
    offTopicTurn: offTopicStreak(ownHistory) + 1,
    history: ownHistory.slice(-8).map((item) => ({ role: item.role, body: item.body.slice(0, 400) })),
    snapshot: snapshotLine(transactions, input.profile, input.now),
  };
  let interpreted: FinanceAction;
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
      model: input.model,
    });
  } catch (error) {
    if (error instanceof AiError && error.code === "invalid") {
      return { action: { type: "chat", message: conversationalFallback(input.text) }, context, cue };
    }
    throw error;
  }
  const action = applyFollowUp(input.text, interpreted, context);
  return { action, context, cue };
}

/** What the voice needs to hold a natural conversation without drifting from money. */
export type ChatCue = {
  /** 1 for the first off-topic message in a row, 2 for the second, and so on. */
  offTopicTurn: number;
  history: { role: "user" | "assistant"; body: string }[];
  snapshot: string;
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

function snapshotLine(transactions: TransactionRecord[], profile: UserProfile, now: Date): string {
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
  return `Today: ${todayText}. This month so far: ${formatMinor(sum(month), profile.currency)} spent.`;
}
