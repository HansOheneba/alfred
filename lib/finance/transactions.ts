import type { UserProfile } from "@/lib/config";
import { normalizeCategory, categoryList } from "@/lib/finance/categories";
import { isSaneTransactionDate } from "@/lib/finance/dates";
import type { FinanceAction } from "@/lib/finance/schemas";
import type { FinanceStore } from "@/lib/finance/store";
import type { TransactionDraft, TransactionRecord } from "@/lib/finance/types";
import { userFacingError } from "@/lib/telegram/messages";

type AiDraft = Extract<FinanceAction, { type: "create_transaction" }>["transactions"][number];

export function normalizeDrafts(
  drafts: AiDraft[],
  profile: UserProfile,
  today: string,
): { ok: true; drafts: TransactionDraft[] } | { ok: false; message: string } {
  const normalized: TransactionDraft[] = [];
  for (const draft of drafts) {
    const category = normalizeCategory(draft.category, draft.transaction_type);
    if (!category) {
      return {
        ok: false,
        message: `I don't know the category "${draft.category}". Use one of: ${categoryList(draft.transaction_type).join(", ")}.`,
      };
    }
    const date = draft.date ?? today;
    if (!isSaneTransactionDate(date, today)) {
      return { ok: false, message: `I can't use ${date} as the transaction date.` };
    }
    normalized.push({
      transactionType: draft.transaction_type,
      amount: draft.amount,
      currency: draft.currency || profile.currency,
      category,
      description: draft.description.trim(),
      date,
      paymentMethod: draft.payment_method?.trim() ?? "",
      notes: draft.notes?.trim() ?? "",
    });
  }
  return { ok: true, drafts: normalized };
}

export async function writeTransactions(input: {
  store: FinanceStore;
  userId: string;
  drafts: TransactionDraft[];
  sourcePrefix: string;
  createId: () => string;
  now: Date;
}): Promise<{
  succeeded: TransactionRecord[];
  failed: { description: string; message: string }[];
}> {
  const succeeded: TransactionRecord[] = [];
  const failed: { description: string; message: string }[] = [];
  for (const [index, draft] of input.drafts.entries()) {
    const sourceUpdateId = `${input.sourcePrefix}:${index}`;
    try {
      const existing = (await input.store.findTransactionsBySource(input.userId, sourceUpdateId))
        .filter((item) => item.status === "active")
        .sort((left, right) => left.rowNumber - right.rowNumber);
      if (existing.length > 0) {
        succeeded.push(existing[0]);
        continue;
      }
      const timestamp = input.now.toISOString();
      await input.store.appendTransaction({
        transactionId: input.createId(),
        createdAt: timestamp,
        transactionDate: draft.date,
        userId: input.userId,
        type: draft.transactionType,
        amount: draft.amount,
        currency: draft.currency,
        category: draft.category,
        description: draft.description,
        paymentMethod: draft.paymentMethod,
        notes: draft.notes,
        status: "active",
        updatedAt: timestamp,
        sourceUpdateId,
      });
      const after = (await input.store.findTransactionsBySource(input.userId, sourceUpdateId))
        .filter((item) => item.status === "active")
        .sort((left, right) => left.rowNumber - right.rowNumber);
      const keeper = after[0];
      if (!keeper) {
        failed.push({
          description: draft.description,
          message: "I couldn't confirm the spreadsheet write.",
        });
        continue;
      }
      for (const extra of after.slice(1)) {
        await input.store.updateTransaction(input.userId, extra.transactionId, { status: "deleted" });
      }
      succeeded.push(keeper);
    } catch (error) {
      failed.push({ description: draft.description, message: userFacingError(error) });
    }
  }
  return { succeeded, failed };
}

export function findCandidates(
  transactions: TransactionRecord[],
  query: {
    transactionId?: string | null;
    descriptionQuery?: string | null;
    undoLast?: boolean;
    type?: "income" | "expense";
  },
): TransactionRecord[] {
  const sorted = transactions
    .filter((item) => item.status === "active")
    .sort((left, right) => {
      const byDate = right.transactionDate.localeCompare(left.transactionDate);
      if (byDate !== 0) return byDate;
      return right.createdAt.localeCompare(left.createdAt);
    });
  if (query.transactionId) {
    return sorted.filter((item) => matchesTransactionId(item.transactionId, query.transactionId ?? ""));
  }
  if (query.undoLast) {
    const type = query.type ?? "expense";
    const latest = sorted.find((item) => item.type === type);
    return latest ? [latest] : [];
  }
  const needle = query.descriptionQuery?.trim().toLowerCase();
  if (!needle) return [];
  return sorted.filter(
    (item) =>
      item.description.toLowerCase().includes(needle) || item.category.toLowerCase() === needle,
  );
}

export function matchesTransactionId(recordId: string, query: string): boolean {
  if (recordId === query) return true;
  const compactQuery = query.replace(/-/g, "").toLowerCase();
  if (compactQuery.length < 8 || !/^[a-f0-9]+$/.test(compactQuery)) return false;
  return recordId.replace(/-/g, "").toLowerCase().startsWith(compactQuery);
}

export function describeCandidates(matches: TransactionRecord[]): string {
  const lines = ["I found more than one match. Tell me which one you mean:"];
  matches.slice(0, 5).forEach((match, index) => {
    lines.push(
      `${index + 1}. ${match.transactionDate} · ${match.amount} ${match.currency} · ${match.category} · ${match.description} · ${match.transactionId}`,
    );
  });
  if (matches.length > 5) lines.push(`${matches.length - 5} more are not shown.`);
  return lines.join("\n");
}
