import type { CategoryRecord } from "@/lib/finance/types";
import type { LedgerRow } from "@/lib/finance/analytics";
import { normalizeCategory } from "@/lib/finance/categories";
import { formatDisplayDate } from "@/lib/finance/dates";
import { canonicalizeAmount, formatMinor, toMinor } from "@/lib/finance/money";
import { amountSchema, isoDateSchema } from "@/lib/finance/schemas";

export type TransactionEditDraft = Pick<LedgerRow, "type" | "amount" | "description" | "category" | "date"> & { includedFee: string };
export type TransactionEditReview = { changes: Record<string, string>; differences: { label: string; before: string; after: string }[]; splitsFee: boolean };

/** Review the exact native record change without writing or changing report totals. */
export function prepareTransactionEdit(row: LedgerRow, draft: TransactionEditDraft, custom: readonly CategoryRecord[] = []): { ok: true; review: TransactionEditReview } | { ok: false; error: string } {
  const amount = canonicalizeAmount(draft.amount), description = draft.description.trim();
  const category = draft.type === row.type && draft.category === row.category ? row.category : normalizeCategory(draft.category, draft.type, custom);
  if (!amount || !amountSchema.safeParse(amount).success) return { ok: false, error: "Enter a positive amount with up to two decimals." };
  if (!description || description.length > 200) return { ok: false, error: "Enter a description of 200 characters or fewer." };
  if (!category) return { ok: false, error: "Choose a category for this transaction type." };
  if (!isoDateSchema.safeParse(draft.date).success) return { ok: false, error: "Choose a valid transaction date." };
  const fee = draft.includedFee.trim() ? canonicalizeAmount(draft.includedFee) : null;
  if (draft.includedFee.trim() && (!fee || !amountSchema.safeParse(fee).success || draft.type !== "expense" || row.category === "Fees" || toMinor(fee) >= toMinor(amount))) return { ok: false, error: "An included fee must be positive and less than this expense's amount." };
  const changes: Record<string, string> = {}, differences: TransactionEditReview["differences"] = [];
  const add = (key: string, label: string, before: string, after: string, value: string) => { changes[key] = value; differences.push({ label, before, after }); };
  const principal = toMinor(amount) - (fee ? toMinor(fee) : 0);
  if (amount !== row.amount || fee) {
    if (amount !== row.amount) changes.amount = amount;
    differences.push({ label: "Payment amount", before: formatMinor(Math.abs(row.minor), row.currency), after: formatMinor(principal, row.currency) });
  }
  if (description !== row.description) add("description", "Description", row.description, description, description);
  if (category !== row.category || draft.type !== row.type) add("category", "Category", row.category, category, category);
  if (draft.date !== row.date) add("date", "Date", formatDisplayDate(row.date), formatDisplayDate(draft.date), draft.date);
  if (draft.type !== row.type) add("transactionType", "Type", row.type === "income" ? "Income" : "Expense", draft.type === "income" ? "Income" : "Expense", draft.type);
  if (fee) add("includedFee", "Separate fee", "None", formatMinor(toMinor(fee), row.currency), fee);
  return { ok: true, review: { changes, differences, splitsFee: Boolean(fee) } };
}
