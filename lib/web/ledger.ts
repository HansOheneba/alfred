import type { UserProfile, StudioSettings } from "@/lib/config";
import { toLedgerRows, type LedgerRow } from "@/lib/finance/analytics";
import { budgetMath } from "@/lib/finance/budgets";
import { zonedYmd } from "@/lib/finance/dates";
import { buildInsights } from "@/lib/finance/insights";
import { createSupabaseFinanceStore } from "@/lib/supabase/finance-store";

export type LedgerBudget = {
  budgetId: string;
  period: string;
  category: string;
  amount: string;
  currency: string;
  spentMinor: number;
  budgetMinor: number;
  remainingMinor: number;
};

export type LedgerGoal = {
  goalId: string;
  name: string;
  targetAmount: string;
  currentAmount: string;
  currency: string;
  targetDate: string;
  status: "active" | "completed";
};

/** Everything the dashboard, settings and chat side panel need for one person. */
export type Ledger = {
  today: string;
  currency: string;
  rows: LedgerRow[];
  budgets: LedgerBudget[];
  goals: LedgerGoal[];
  /** Server-computed findings for this month, the same ones Alfred narrates in chat. */
  insights: string[];
};

export async function loadLedger(profile: UserProfile, settings: StudioSettings): Promise<Ledger> {
  const store = createSupabaseFinanceStore(settings.supabase);
  const userId = profile.profileId;
  const [transactions, budgets, goals] = await Promise.all([
    store.listTransactions(userId),
    store.listBudgets(userId),
    store.listSavingsGoals(userId),
  ]);
  const today = zonedYmd(new Date(), profile.timezone);
  const monthStart = `${today.slice(0, 7)}-01`;
  const [year, month] = today.split("-").map(Number);
  const monthEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return {
    today,
    currency: profile.currency,
    rows: toLedgerRows(transactions),
    budgets: budgets
      .map((budget) => ({
        budgetId: budget.budgetId,
        period: budget.period,
        category: budget.category,
        amount: budget.amount,
        currency: budget.currency,
        ...budgetMath(budget, transactions),
      }))
      .sort((left, right) => right.period.localeCompare(left.period) || left.category.localeCompare(right.category)),
    goals: goals
      .filter((goal) => goal.status !== "deleted")
      .map((goal) => ({
        goalId: goal.goalId,
        name: goal.name,
        targetAmount: goal.targetAmount,
        currentAmount: goal.currentAmount,
        currency: goal.currency,
        targetDate: goal.targetDate,
        status: goal.status === "completed" ? "completed" : "active",
      })),
    insights: buildInsights({
      userId,
      currency: profile.currency,
      range: { start: monthStart, end: monthEnd },
      today,
      transactions,
      budgets,
    }),
  };
}
