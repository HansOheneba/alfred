import type { AccountingState } from "@/lib/finance/accounting/types";
import { accountingReportRows } from "@/lib/finance/accounting/view";
import { detectRenewalCandidates } from "@/lib/finance/bill-renewals";
import { upcomingBills } from "@/lib/finance/bill-schedule";
import type { TransactionRecord } from "@/lib/finance/types";
import type { SubscriptionBillsData, SubscriptionsData } from "./subscriptions-actions";

/** Recompute from the exact current accounting state; never keep a stale initial projection. */
export function subscriptionsData(facts: SubscriptionBillsData, state: AccountingState): SubscriptionsData {
  const transactions = accountingReportRows(state)
    // A service's separate fee/tax remains an expense, not a second renewal payment.
    .filter((row) => !row.id.startsWith("accounting-fee:") && !row.id.startsWith("accounting-tax:"))
    .map((row): TransactionRecord => ({ transactionId: row.id, userId: state.ownerId, createdAt: `${row.date}T00:00:00.000Z`, updatedAt: `${row.date}T00:00:00.000Z`, transactionDate: row.date, type: row.type, amount: row.amount, currency: row.currency, category: row.category, description: row.description, paymentMethod: row.paymentMethod, notes: "", status: "active", sourceUpdateId: row.id, rowNumber: 0 }));
  return { ...facts, upcoming: upcomingBills(facts.bills, facts.today), suggestions: detectRenewalCandidates(transactions, facts.bills, facts.today, facts.currency) };
}
