import type { UserProfile, StudioSettings } from "@/lib/config";
import { toLedgerRows, type LedgerRow } from "@/lib/finance/analytics";
import { createSupabaseBillStore, detectRenewalCandidates, upcomingBills, type BillRecord, type RenewalSuggestion, type UpcomingBill } from "@/lib/finance/bills";
import { budgetMath } from "@/lib/finance/budgets";
import { zonedYmd } from "@/lib/finance/dates";
import { buildInsights } from "@/lib/finance/insights";
import { labelQuestion } from "@/lib/bank/ingest";
import { createSupabaseLoanStore, loanBalances, type LoanBalance } from "@/lib/finance/loans";
import { createSupabaseBankStore } from "@/lib/bank/store";
import { query } from "@/lib/supabase/connection";
import { createSupabaseFinanceStore } from "@/lib/supabase/finance-store";
import { sourceName, type BankSource } from "@/lib/bank/parse";
import { loadAccountingReadModel } from "@/lib/finance/accounting/persisted-store";
import { buildAccountingView, projectAccountingTransactions } from "@/lib/finance/accounting/view";
import { withLedgerReceipts } from "@/lib/finance/accounting/receipts";

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

export type LedgerBalance = { source: BankSource; label: string; balance: string; at: string };

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
  /** People the person borrowed from and still owes, largest first. */
  owe: LoanBalance[];
  /** Confirmed recurring bills and subscriptions. */
  bills?: BillRecord[];
  /** Bills due in the next 30 days. */
  upcomingBills?: UpcomingBill[];
  /** Recurring charges spotted in the ledger that aren't saved as bills yet. */
  renewalSuggestions?: RenewalSuggestion[];
  /** Stable financial accounts and source-based reconciliation; never sum provider-level legacy balances. */
  accounting?: { availability:"ready"|"migration-required";revision:number;balances:ReturnType<typeof buildAccountingView>["balances"];loans:ReturnType<typeof buildAccountingView>["loans"];issues:string[] };
};

export async function loadLedger(profile: UserProfile, settings: StudioSettings): Promise<Ledger> {
  const store = createSupabaseFinanceStore(settings.supabase);
  const userId = profile.profileId;
  const [accounting, budgets, goals, bank, loans, bills] = await Promise.all([
    loadAccountingReadModel(settings.supabase,userId),
    store.listBudgets(userId),
    store.listSavingsGoals(userId),
    loadBank(settings, profile),
    createSupabaseLoanStore(settings.supabase).list(userId),
    createSupabaseBillStore(settings.supabase).list(userId),
  ]);
  const transactions=accounting.availability==="ready" ? projectAccountingTransactions(accounting.rawTransactions,accounting.state) : accounting.rawTransactions;
  const accountingView=buildAccountingView(accounting.state,profile.currency);
  bank.needsLabel=bank.needsLabel.filter((item) => accounting.state.movements.find((movement) => movement.id===`bank:${item.id}`)?.status==="review");
  const linkedLoans:LoanBalance[]=accountingView.loans.filter((loan) => loan.outstandingMinor>0).map((loan) => ({person:loan.description,personKey:`accounting:${loan.settlementId}`,currency:loan.currency,lent:(loan.principalMinor/100).toFixed(2),repaid:(loan.returnedMinor/100).toFixed(2),owed:(loan.outstandingMinor/100).toFixed(2),borrowed:"0.00",paidBack:"0.00",owe:"0.00",since:accounting.state.movements.find((movement) => movement.id===loan.originalMovementId)?.occurredAt ?? accounting.state.movements.find((movement) => movement.id===loan.originalMovementId)?.date ?? ""}));
  const today = zonedYmd(new Date(), profile.timezone);
  const monthStart = `${today.slice(0, 7)}-01`;
  const [year, month] = today.split("-").map(Number);
  const monthEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return {
    today,
    currency: profile.currency,
    rows: withLedgerReceipts(toLedgerRows(transactions), accounting.state, userId),
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
    owed: [...loanBalances(loans).filter((item) => Number(item.owed) > 0),...linkedLoans].sort((a,b) => Number(b.owed)-Number(a.owed)),
    owe: loanBalances(loans)
      .filter((item) => Number(item.owe) > 0)
      .sort((left, right) => Number(right.owe) - Number(left.owe)),
    bills,
    upcomingBills: upcomingBills(bills, today),
    renewalSuggestions: detectRenewalCandidates(transactions, bills, today, profile.currency),
    accounting:{availability:accounting.availability,revision:accounting.state.revision,balances:accountingView.balances,loans:accountingView.loans,issues:accountingView.settlementIssues.map((issue) => issue.reason)},
  };
}

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
       order by source, occurred_at desc, created_at desc`,
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
      label: sourceName(row.source),
      balance: Number(row.balance).toFixed(2),
      at: row.occurred_at.toISOString(),
    })),
  };
}
