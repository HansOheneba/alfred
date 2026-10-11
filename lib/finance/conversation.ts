import type { FinanceAction } from "@/lib/finance/schemas";
import type { FinanceStore } from "@/lib/finance/store";
import type { ProcessedUpdateRecord } from "@/lib/finance/types";

const SUMMARY_KINDS = ["spending", "income", "budget", "history", "overview", "record", "correction"] as const;
const DETAILS = ["total", "by_category", "largest", "comparison"] as const;

export type ConversationContext = {
  rangeStart: string;
  rangeEnd: string;
  category: string | null;
  detail: (typeof DETAILS)[number] | null;
  summaryKind: (typeof SUMMARY_KINDS)[number];
  transactionId: string | null;
  pendingActionId: string | null;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function conversationContext(value: unknown): ConversationContext | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.rangeStart !== "string" || !DATE.test(record.rangeStart)) return null;
  if (typeof record.rangeEnd !== "string" || !DATE.test(record.rangeEnd)) return null;
  if (record.rangeStart > record.rangeEnd) return null;
  if (typeof record.summaryKind !== "string" || !(SUMMARY_KINDS as readonly string[]).includes(record.summaryKind)) {
    return null;
  }
  const detail = record.detail;
  if (detail != null && (typeof detail !== "string" || !(DETAILS as readonly string[]).includes(detail))) {
    return null;
  }
  return {
    rangeStart: record.rangeStart,
    rangeEnd: record.rangeEnd,
    category: typeof record.category === "string" && record.category ? record.category : null,
    detail: detail == null ? null : (detail as ConversationContext["detail"]),
    summaryKind: record.summaryKind as ConversationContext["summaryKind"],
    transactionId: typeof record.transactionId === "string" && record.transactionId ? record.transactionId : null,
    pendingActionId: typeof record.pendingActionId === "string" && record.pendingActionId ? record.pendingActionId : null,
  };
}

export function latestConversation(rows: ProcessedUpdateRecord[], userId: string): ConversationContext | null {
  const own = rows
    .filter((row) => row.userId === userId && row.status === "completed")
    .sort((left, right) => right.rowNumber - left.rowNumber);
  for (const row of own) {
    const context = contextFromReference(row.resultReference);
    if (context) return context;
  }
  return null;
}

export function contextFromReference(raw: string): ConversationContext | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object") return null;
    return conversationContext((value as { context?: unknown }).context);
  } catch {
    return null;
  }
}

export async function readConversation(store: FinanceStore, userId: string): Promise<ConversationContext | null> {
  return latestConversation(await store.listProcessedUpdates(), userId);
}

function mentionsNewPeriod(text: string): boolean {
  return /\b(today|yesterday|this week|last week|this month|last month|this year|january|february|march|april|may|june|july|august|september|october|november|december|20\d{2})\b/i.test(
    text,
  );
}

function isBreakdownRequest(text: string): boolean {
  const value = text.toLowerCase();
  if (/\b(breakdown|by categor|other categor|where else did i|anything else i spent)\b/.test(value)) return true;
  return /\bwhat else\b/.test(value) && /\b(spend|spent|money|categor|that|those)\b/.test(value);
}

function hasExplicitRange(action: {
  period?: string | null;
  month?: number | null;
  start_date?: string | null;
  end_date?: string | null;
}): boolean {
  return Boolean(action.period || action.month || action.start_date || action.end_date);
}

export function applyFollowUp(
  text: string,
  action: FinanceAction,
  context: ConversationContext | null,
): FinanceAction {
  if (action.type === "get_spending_summary" && action.continue_previous && context && !hasExplicitRange(action)) {
    return {
      ...action,
      detail: action.detail ?? "by_category",
      period: null,
      month: null,
      year: null,
      start_date: context.rangeStart,
      end_date: context.rangeEnd,
    };
  }
  if (!isBreakdownRequest(text)) return action;

  const category = action.type === "get_spending_summary" ? (action.category ?? null) : null;
  if (!mentionsNewPeriod(text) && context) {
    return {
      type: "get_spending_summary",
      detail: category ? "total" : "by_category",
      continue_previous: true,
      period: null,
      month: null,
      year: null,
      start_date: context.rangeStart,
      end_date: context.rangeEnd,
      category,
    };
  }
  if (action.type === "get_spending_summary") {
    return { ...action, detail: category ? (action.detail ?? "total") : "by_category" };
  }
  return action;
}
