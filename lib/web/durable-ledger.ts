import type { AccountingResult } from "@/lib/finance/accounting/persisted-store";
import type { DurableLedgerPayload, DurableModelRow } from "@/lib/finance/accounting/display-model";
import { projectAccountingTransactions } from "@/lib/finance/accounting/view";
import { withLedgerReceipts } from "@/lib/finance/accounting/receipts";
import { toLedgerRows } from "@/lib/finance/analytics";
import { displayRenewalGroup } from "@/lib/finance/display-insight-facts";
import { filterOverviewTransactions } from "./overview-transactions";

/** Worker-only: preserve the complete report oracle and both established traversal orders. */
export function buildDurableLedgerRows(result: AccountingResult): DurableModelRow[] {
  const transactions = result.availability === "ready" ? projectAccountingTransactions(result.rawTransactions, result.state) : result.rawTransactions;
  const transactionOrdinals = new Map(transactions.map((row, ordinal) => [row.transactionId, ordinal]));
  const rows = withLedgerReceipts(toLedgerRows(transactions), result.state, result.state.ownerId);
  const labels=[...new Set(rows.map(row=>row.description.trim()))].sort((a,b)=>a.localeCompare(b)),labelRanks=new Map<string,number>();
  let labelRank=0;
  labels.forEach((label,index)=>{if(index>0&&label.localeCompare(labels[index-1])!==0)labelRank++;labelRanks.set(label,labelRank);});
  const candidates = [...rows.filter(row => row.type === "expense"), ...rows.filter(row => row.type === "income")];
  const ranks = (sort: "date-asc" | "date-desc" | "amount-asc" | "amount-desc") => new Map(filterOverviewTransactions(candidates, { search: "", type: "all", category: "all", sort }).map((row, index) => [row.id, index]));
  const dateAsc = ranks("date-asc"), dateDesc = ranks("date-desc"), amountAsc = ranks("amount-asc"), amountDesc = ranks("amount-desc");
  return rows.map((row, ordinal) => ({
    kind: "ledger", id: row.id, ordinal, date: row.date, currency: row.currency, category: row.category,
    direction: row.type === "expense" ? "out" : "in", amountMinor: row.minor,
    searchText: `${row.description.toLowerCase()}\n${row.category.toLowerCase()}`,
    rankDateAsc: dateAsc.get(row.id)!, rankDateDesc: dateDesc.get(row.id)!, rankAmountAsc: amountAsc.get(row.id)!, rankAmountDesc: amountDesc.get(row.id)!,
    payload: { ...row, transactionOrdinal: transactionOrdinals.get(row.id)!, descriptionKey: row.description.trim().toLowerCase(), descriptionLabel: row.description.trim(), descriptionSearch: row.description.toLowerCase(), categorySearch: row.category.toLowerCase(), paymentLabel: row.paymentMethod.trim() || "Manual / cash", merchantKey:row.description.toLowerCase().replace(/\s+/g,' ').trim(),merchantLabelRank:labelRanks.get(row.description.trim())!,renewalGroup: displayRenewalGroup(row) } satisfies DurableLedgerPayload,
  }));
}
