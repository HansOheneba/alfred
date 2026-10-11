import { toMinor } from "@/lib/finance/money";
import type { BudgetRecord, TransactionRecord } from "@/lib/finance/types";

export type BudgetMath = {
  spentMinor: number;
  budgetMinor: number;
  remainingMinor: number;
};

export function budgetMath(budget: BudgetRecord, transactions: TransactionRecord[]): BudgetMath {
  const spentMinor = transactions
    .filter(
      (item) =>
        item.userId === budget.userId &&
        item.status === "active" &&
        item.type === "expense" &&
        item.category === budget.category &&
        item.currency === budget.currency &&
        item.transactionDate.startsWith(budget.period),
    )
    .reduce((sum, item) => sum + toMinor(item.amount), 0);
  const budgetMinor = toMinor(budget.amount);
  return {
    spentMinor,
    budgetMinor,
    remainingMinor: budgetMinor - spentMinor,
  };
}
