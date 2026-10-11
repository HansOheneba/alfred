import type { DateRange } from "@/lib/finance/dates";
import { toMinor } from "@/lib/finance/money";
import type { TransactionRecord, TransactionType } from "@/lib/finance/types";

export type MoneyTotal = {
  currency: string;
  minor: number;
};

export type CategoryTotal = {
  category: string;
  currency: string;
  minor: number;
};

export function inRange(
  transactions: TransactionRecord[],
  input: {
    userId: string;
    range: DateRange;
    type?: TransactionType;
    category?: string;
  },
): TransactionRecord[] {
  return transactions.filter(
    (item) =>
      item.userId === input.userId &&
      item.status === "active" &&
      item.transactionDate >= input.range.start &&
      item.transactionDate <= input.range.end &&
      (input.type ? item.type === input.type : true) &&
      (input.category ? item.category === input.category : true),
  );
}

export function totalsByCurrency(transactions: TransactionRecord[]): MoneyTotal[] {
  const totals = new Map<string, number>();
  for (const item of transactions) {
    totals.set(item.currency, (totals.get(item.currency) ?? 0) + toMinor(item.amount));
  }
  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, minor]) => ({ currency, minor }));
}

export function totalsByCategory(transactions: TransactionRecord[]): CategoryTotal[] {
  const totals = new Map<string, number>();
  for (const item of transactions) {
    const key = `${item.category}\u0000${item.currency}`;
    totals.set(key, (totals.get(key) ?? 0) + toMinor(item.amount));
  }
  return [...totals.entries()]
    .map(([key, minor]) => {
      const [category, currency] = key.split("\u0000");
      return { category, currency, minor };
    })
    .sort((left, right) => right.minor - left.minor || left.category.localeCompare(right.category));
}

export function largestExpenses(transactions: TransactionRecord[], limit: number): TransactionRecord[] {
  return [...transactions]
    .filter((item) => item.type === "expense" && item.status === "active")
    .sort((left, right) => toMinor(right.amount) - toMinor(left.amount))
    .slice(0, limit);
}

export function netByCurrency(income: MoneyTotal[], expenses: MoneyTotal[]): MoneyTotal[] {
  const currencies = new Set([...income.map((item) => item.currency), ...expenses.map((item) => item.currency)]);
  return [...currencies].sort().map((currency) => ({
    currency,
    minor:
      (income.find((item) => item.currency === currency)?.minor ?? 0) -
      (expenses.find((item) => item.currency === currency)?.minor ?? 0),
  }));
}
