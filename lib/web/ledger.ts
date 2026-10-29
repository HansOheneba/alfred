import type { UserProfile, StudioSettings } from "@/lib/config";
import { toLedgerRows, type LedgerRow } from "@/lib/finance/analytics";
import { budgetMath } from "@/lib/finance/budgets";
import { zonedYmd } from "@/lib/finance/dates";
import { buildInsights } from "@/lib/finance/insights";
import { labelQuestion } from "@/lib/bank/ingest";
import { createSupabaseLoanStore, loanBalances, type LoanBalance } from "@/lib/finance/loans";
import { createSupabaseBankStore } from "@/lib/bank/store";
import { query } from "@/lib/supabase/connection";
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

export type LedgerBankItem = {
  id: string;
  direction: "in" | "out";
  amount: string;
  currency: string;
  counterparty: string;
  occurredAt: string;
  question: string;
};

export type LedgerBalance = { source: "momo" | "gcb" | "other"; label: string; balance: string; at: string };

export type LedgerBank = {
  /** Whether a forwarding key exists, and when it was last used. */
  connected: boolean;
  lastUsedAt: string | null;
  /** When the iPhone last forwarded a message with no text in it. */
  lastEmptyAt: string | null;
  accountNames: string[];
  needsLabel: LedgerBankItem[];
  balances: LedgerBalance[];
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
  bank: LedgerBank;
  /** People who still owe the person money they lent, largest first. */
  owed: LoanBalance[];
};

export async function loadLedger(profile: UserProfile, settings: StudioSettings): Promise<Ledger> {
  const store = createSupabaseFinanceStore(settings.supabase);
  const userId = profile.profileId;
  const [transactions, budgets, goals, bank, loans] = await Promise.all([
    store.listTransactions(userId),
    store.listBudgets(userId),
    store.listSavingsGoals(userId),
    loadBank(settings, profile),
    createSupabaseLoanStore(settings.supabase).list(userId),
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
    bank,
    owed: loanBalances(loans).filter((item) => Number(item.owed) > 0),
  };
}

const BALANCE_LABELS = { momo: "MoMo", gcb: "GCB card", other: "Bank" } as const;

async function loadBank(settings: StudioSettings, profile: UserProfile): Promise<LedgerBank> {
  const bank = createSupabaseBankStore(settings.supabase);
  const [held, token, names, balances] = await Promise.all([
    bank.listMessages(profile.profileId, "needs_label"),
    query<{ last_used_at: Date | null; last_empty_at: Date | null }>(settings.supabase, "select last_used_at, last_empty_at from public.ingest_tokens where owner_id = $1::uuid", [profile.profileId]),
    bank.accountNames(profile.profileId),
    query<{ source: LedgerBalance["source"]; balance: string; occurred_at: Date }>(
      settings.supabase,
      `select distinct on (source) source, balance::text, occurred_at
       from public.bank_messages
       where owner_id = $1::uuid and balance is not null
       order by source, occurred_at desc`,
      [profile.profileId],
    ),
  ]);
  return {
    connected: token.length > 0,
    lastUsedAt: token[0]?.last_used_at ? token[0].last_used_at.toISOString() : null,
    lastEmptyAt: token[0]?.last_empty_at ? token[0].last_empty_at.toISOString() : null,
    accountNames: names,
    needsLabel: held.slice(0, 20).map((message) => ({
      id: message.id,
      direction: message.direction,
      amount: message.amount,
      currency: message.currency,
      counterparty: message.counterparty,
      occurredAt: message.occurredAt,
      question: labelQuestion(message, profile.timezone, profile.preferredName),
    })),
    balances: balances.map((row) => ({
      source: row.source,
      label: BALANCE_LABELS[row.source],
      balance: Number(row.balance).toFixed(2),
      at: row.occurred_at.toISOString(),
    })),
  };
}
