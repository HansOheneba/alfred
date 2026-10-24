import { budgetMath } from "@/lib/finance/budgets";
import { addDays, rangeForPeriod } from "@/lib/finance/dates";
import { toMinor } from "@/lib/finance/money";
import { inRange, totalsByCategory } from "@/lib/finance/summaries";
import type { BudgetRecord, SavingsGoalRecord, TransactionRecord, TransactionType } from "@/lib/finance/types";

export type DashboardDay = {
  date: string;
  day: number;
  spentMinor: number;
};

export type DashboardCategory = {
  category: string;
  minor: number;
  share: number;
};

export type DashboardTransaction = {
  transactionId: string;
  transactionDate: string;
  type: TransactionType;
  amount: string;
  currency: string;
  category: string;
  description: string;
};

export type DashboardBudget = {
  category: string;
  currency: string;
  spentMinor: number;
  budgetMinor: number;
  remainingMinor: number;
};

export type DashboardGoal = {
  name: string;
  currency: string;
  currentMinor: number;
  targetMinor: number;
  status: SavingsGoalRecord["status"];
};

export type DashboardCurrencyTotal = {
  currency: string;
  spentMinor: number;
  incomeMinor: number;
};

export type DashboardSnapshot = {
  monthLabel: string;
  currency: string;
  spentMinor: number;
  incomeMinor: number;
  netMinor: number;
  categories: DashboardCategory[];
  days: DashboardDay[];
  budgets: DashboardBudget[];
  goals: DashboardGoal[];
  recent: DashboardTransaction[];
  otherCurrencies: DashboardCurrencyTotal[];
  hasActivity: boolean;
};

const RECENT_LIMIT = 8;

export function buildDashboard(input: {
  userId: string;
  currency: string;
  today: string;
  transactions: TransactionRecord[];
  budgets: BudgetRecord[];
  goals: SavingsGoalRecord[];
}): DashboardSnapshot {
  const range = rangeForPeriod("this_month", input.today);
  const lastDay = input.today < range.end ? input.today : range.end;
  const own = input.transactions.filter((item) => item.userId === input.userId && item.status === "active");
  const monthExpenses = inRange(own, { userId: input.userId, range: { start: range.start, end: lastDay }, type: "expense" });
  const monthIncome = inRange(own, { userId: input.userId, range: { start: range.start, end: lastDay }, type: "income" });
  const spent = monthExpenses.filter((item) => item.currency === input.currency);
  const income = monthIncome.filter((item) => item.currency === input.currency);
  const spentMinor = sumMinor(spent);
  const incomeMinor = sumMinor(income);
  const categories = totalsByCategory(spent).map((item) => ({
    category: item.category,
    minor: item.minor,
    share: spentMinor === 0 ? 0 : item.minor / spentMinor,
  }));

  return {
    monthLabel: monthLabel(input.today),
    currency: input.currency,
    spentMinor,
    incomeMinor,
    netMinor: incomeMinor - spentMinor,
    categories,
    days: daysThrough(range.start, lastDay, spent),
    budgets: input.budgets
      .filter((budget) => budget.userId === input.userId && budget.period === input.today.slice(0, 7))
      .map((budget) => ({ category: budget.category, currency: budget.currency, ...budgetMath(budget, own) }))
      .sort((left, right) => left.category.localeCompare(right.category)),
    goals: input.goals
      .filter((goal) => goal.userId === input.userId && goal.status !== "deleted")
      .map((goal) => ({
        name: goal.name,
        currency: goal.currency,
        currentMinor: toMinor(goal.currentAmount),
        targetMinor: toMinor(goal.targetAmount),
        status: goal.status,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    recent: [...own]
      .sort((left, right) => {
        const byDate = right.transactionDate.localeCompare(left.transactionDate);
        if (byDate !== 0) return byDate;
        return right.createdAt.localeCompare(left.createdAt);
      })
      .slice(0, RECENT_LIMIT)
      .map((item) => ({
        transactionId: item.transactionId,
        transactionDate: item.transactionDate,
        type: item.type,
        amount: item.amount,
        currency: item.currency,
        category: item.category,
        description: item.description,
      })),
    otherCurrencies: otherCurrencies(monthExpenses, monthIncome, input.currency),
    hasActivity: own.length > 0,
  };
}

function sumMinor(transactions: TransactionRecord[]): number {
  return transactions.reduce((sum, item) => sum + toMinor(item.amount), 0);
}

function daysThrough(start: string, end: string, expenses: TransactionRecord[]): DashboardDay[] {
  const spentByDay = new Map<string, number>();
  for (const item of expenses) {
    spentByDay.set(item.transactionDate, (spentByDay.get(item.transactionDate) ?? 0) + toMinor(item.amount));
  }
  const days: DashboardDay[] = [];
  for (let date = start; date <= end; date = addDays(date, 1)) {
    days.push({ date, day: Number(date.slice(8, 10)), spentMinor: spentByDay.get(date) ?? 0 });
    if (days.length > 31) break;
  }
  return days;
}

function otherCurrencies(
  expenses: TransactionRecord[],
  income: TransactionRecord[],
  currency: string,
): DashboardCurrencyTotal[] {
  const codes = new Set(
    [...expenses, ...income].map((item) => item.currency).filter((code) => code !== currency),
  );
  return [...codes].sort().map((code) => ({
    currency: code,
    spentMinor: sumMinor(expenses.filter((item) => item.currency === code)),
    incomeMinor: sumMinor(income.filter((item) => item.currency === code)),
  }));
}

function monthLabel(today: string): string {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  return new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  );
}
