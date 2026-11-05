import { z } from "zod";
import { getGettingStartedState } from "@/app/components/getting-started-state";
import { categoryTotals, dailySeries, inRows, presetRange, sumMinor } from "@/lib/finance/analytics";
import type { Ledger, LedgerBalance, LedgerBankItem, LedgerBudget } from "./ledger";

const minor = z.number().int().safe();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const currency = z.string().regex(/^[A-Z]{3}$/);
const budget = z.object({ budgetId: z.string(), period: z.string(), category: z.string(), amount: z.string(), currency, spentMinor: minor, budgetMinor: minor, remainingMinor: minor });
const bankBalance = z.object({ source: z.string(), label: z.string(), balance: z.string(), at: z.string() });
const label = z.object({ id: z.string(), direction: z.enum(["in", "out"]), amount: z.string(), currency, counterparty: z.string(), occurredAt: z.string(), question: z.string() });

/** Display-only month aggregates. No report rows, receipts, raw alerts or historical snapshots. */
export const chatContextSchema = z.object({
  today: day, currency,
  setup: z.object({ hasAccount: z.boolean(), hasTransaction: z.boolean(), hasBudget: z.boolean(), canShowSetup: z.boolean(), showBlockedSetup: z.boolean(), isEmpty: z.boolean(), completedCount: z.number().int().min(0).max(3) }),
  month: z.object({ start: day, end: day, spentMinor: minor, incomeMinor: minor, categories: z.array(z.object({ category: z.string(), minor, count: z.number().int().nonnegative() })).max(4), days: z.array(z.object({ date: day, label: z.string(), spent: minor, cumulative: minor })).max(31) }),
  budgets: z.array(budget), highlight: z.string().nullable(),
  balances: z.object({ availability: z.enum(["ready", "migration-required"]).nullable(), count: z.number().int().nonnegative(), totalMinor: minor.nullable(), missingCount: z.number().int().nonnegative(), accounts: z.array(z.object({ id: z.string(), label: z.string(), balanceMinor: minor.nullable(), occurredAt: z.string().nullable() })) }),
  bank: z.object({ balances: z.array(bankBalance), needsLabel: z.array(label).max(3), needsLabelCount: z.number().int().nonnegative() }),
});
export type ChatContext = Omit<z.infer<typeof chatContextSchema>, "budgets" | "bank"> & { budgets: LedgerBudget[]; bank: { balances: LedgerBalance[]; needsLabel: LedgerBankItem[]; needsLabelCount: number } };

/** Aggregate the complete coherent report snapshot before removing history from the response. */
export function buildChatContext(ledger: Ledger): ChatContext {
  const range = presetRange("this_month", ledger.today);
  const elapsed = { start: range.start, end: ledger.today < range.end ? ledger.today : range.end };
  const expenses = inRows(ledger.rows, range, ledger.currency, "expense");
  const balances = ledger.accounting?.balances;
  return {
    today: ledger.today, currency: ledger.currency, setup: getGettingStartedState(ledger),
    month: { ...range, spentMinor: sumMinor(expenses), incomeMinor: sumMinor(inRows(ledger.rows, range, ledger.currency, "income")), categories: categoryTotals(expenses).slice(0, 4), days: dailySeries(ledger.rows, elapsed, ledger.currency) },
    budgets: ledger.budgets.filter(item => item.period === ledger.today.slice(0, 7)),
    highlight: ledger.insights.find(line => line.startsWith("Repeated spend")) ?? ledger.insights.find(line => / budget (is over|has)/.test(line)) ?? ledger.insights.find(line => line.includes("moved the most")) ?? null,
    balances: { availability: ledger.accounting?.availability ?? null, count: balances?.count ?? 0, totalMinor: balances?.totalMinor ?? null, missingCount: balances?.missingCount ?? 0,
      accounts: (balances?.accounts ?? []).filter(item => item.account.includeInCash && item.account.currency === ledger.currency).map(({ account, snapshot }) => ({ id: account.id, label: account.label, balanceMinor: snapshot?.balanceMinor ?? null, occurredAt: snapshot?.occurredAt ?? null })) },
    bank: { balances: ledger.bank.balances, needsLabel: ledger.bank.needsLabel.slice(0, 3), needsLabelCount: ledger.bank.needsLabel.length },
  };
}
