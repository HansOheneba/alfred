import { categoryTotals } from "@/lib/finance/analytics";
import { buildAccountingView } from "@/lib/finance/accounting/view";
import type { AccountingState } from "@/lib/finance/accounting/types";
import type { Ledger } from "@/lib/web/ledger";
import { previewLedger, type PreviewAccount } from "./fixture";

/** Project the same synthetic workspace used by Accounts into every finance view. */
export function buildPreviewLedger(state: AccountingState): Ledger {
  const view = buildAccountingView(state, previewLedger.currency);
  const rows = view.reportRows.map((row) => ({ ...row, occurredAt: state.movements.find((movement) => row.id === `accounting:${movement.id}` || row.id === `accounting-fee:${movement.id}`)?.occurredAt ?? null }));
  const monthRows = rows.filter((row) => row.currency === previewLedger.currency && row.date.startsWith(previewLedger.today.slice(0, 7)));
  const expenses = monthRows.filter((row) => row.type === "expense");
  const spent = expenses.reduce((sum, row) => sum + row.minor, 0);
  const income = monthRows.filter((row) => row.type === "income").reduce((sum, row) => sum + row.minor, 0);
  const budgets = previewLedger.budgets.map((budget) => {
    const spentMinor = rows.filter((row) => row.currency === budget.currency && row.date.startsWith(budget.period) && row.type === "expense" && row.category === budget.category).reduce((sum, row) => sum + row.minor, 0);
    return { ...budget, spentMinor, remainingMinor: budget.budgetMinor - spentMinor };
  });
  const food = budgets.find((budget) => budget.category === "Food" && budget.period === previewLedger.today.slice(0, 7));
  const top = categoryTotals(expenses)[0];
  const insights = [
    income > 0 ? `You've kept ${Math.round((income - spent) / income * 100)}% of your recorded income this month.` : "Your confirmed activity is reflected in this overview.",
    food && food.budgetMinor > 0 ? `Food has used ${Math.round(food.spentMinor / food.budgetMinor * 100)}% of its monthly budget.` : "Set a category budget to track your progress.",
    top ? `${top.category} is your largest spending category this month.` : "No confirmed spending is recorded this month.",
  ];
  const needsLabel = state.movements.filter((movement) => movement.status === "review" || movement.status === "hold").map((movement) => ({
    id: movement.id, direction: movement.direction === "in" ? "in" as const : "out" as const, amount: (movement.amountMinor / 100).toFixed(2), currency: movement.currency, counterparty: movement.description, occurredAt: movement.occurredAt ?? `${movement.date}T00:00:00Z`, question: "Choose a category in Accounts.",
  }));
  const owed = [...previewLedger.owed, ...view.loans.filter((loan) => loan.outstandingMinor > 0).map((loan) => ({
    person: loan.description, personKey: `accounting:${loan.settlementId}`, lent: (loan.principalMinor / 100).toFixed(2), repaid: (loan.returnedMinor / 100).toFixed(2), owed: (loan.outstandingMinor / 100).toFixed(2), borrowed: "0.00", paidBack: "0.00", owe: "0.00", currency: loan.currency, since: state.movements.find((movement) => movement.id === loan.originalMovementId)?.occurredAt ?? "",
  }))];
  return { ...previewLedger, rows, budgets, insights, bank: { ...previewLedger.bank, needsLabel }, owed };
}

export function previewBalanceAccounts(state: AccountingState): PreviewAccount[] {
  return buildAccountingView(state, previewLedger.currency).balances.accounts.flatMap(({ account, snapshot }) => snapshot ? [{
    id: account.id, label: account.label, balance: (snapshot.balanceMinor / 100).toFixed(2), currency: account.currency, reportedAt: snapshot.occurredAt, included: account.includeInCash,
  }] : []);
}
