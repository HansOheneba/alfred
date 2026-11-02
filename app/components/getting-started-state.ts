import type { Ledger } from "@/lib/web/ledger";

/** UI readiness only. An empty period or unavailable storage is not a new account. */
export function getGettingStartedState(ledger: Ledger) {
  const hasAccount = (ledger.accounting?.balances.accounts.length ?? 0) > 0;
  const hasTransaction = ledger.rows.length > 0;
  const hasBudget = ledger.budgets.length > 0;
  const hasOtherRecords = ledger.goals.length > 0 || ledger.owed.length > 0 || ledger.owe.length > 0 ||
    ledger.bank.needsLabel.length > 0 || ledger.bank.balances.length > 0 ||
    (ledger.bills?.length ?? 0) > 0 || (ledger.upcomingBills?.length ?? 0) > 0 ||
    (ledger.renewalSuggestions?.length ?? 0) > 0 || (ledger.accounting?.loans.length ?? 0) > 0 ||
    (ledger.accounting?.issues.length ?? 0) > 0;
  const canShowSetup = ledger.accounting?.availability === "ready" && !hasTransaction && !hasOtherRecords;
  return {
    hasAccount, hasTransaction, hasBudget, canShowSetup,
    isEmpty: canShowSetup && !hasAccount && !hasBudget,
    completedCount: Number(hasAccount) + Number(hasTransaction) + Number(hasBudget),
  };
}
