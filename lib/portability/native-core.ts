import {applyAccountRules} from "@/lib/account-rules/matcher";
import {emptyAccountRuleState,type AccountRuleState} from "@/lib/account-rules/types";
import { validateDatasets, type Datasets } from "../../portability/archive.mjs";
import type { BankMessage } from "@/lib/bank/store";
import { hydrateAccountingSources, sourceMovements } from "@/lib/finance/accounting/sources";
import { emptyAccountingState, type AccountingState, type CashMovement } from "@/lib/finance/accounting/types";
import { toMinor } from "@/lib/finance/money";
import type { TransactionRecord } from "@/lib/finance/types";
import type { AlfredNativeExport, ExportCoverage } from "./export";
import { CORE_DOMAINS, type Domain } from "./model";

const iso = (value: unknown) => new Date(String(value)).toISOString();

/** Imported source adapters intentionally do not retain live bank foreign keys.
 * Preserve a positively recorded fee on an otherwise excluded/review movement
 * as its own ordinary expense, without asking the destination to trust a live
 * bank-link claim or counting that fee again if the principal is later edited. */
export function splitConfirmedBankFeesForPortability(state: AccountingState, transactions: TransactionRecord[], messages: BankMessage[]): AccountingState {
  const byTransaction = new Map(transactions.filter(row => row.userId === state.ownerId).map(row => [row.transactionId, row]));
  const byMessage = new Map(messages.filter(row => row.ownerId === state.ownerId).map(row => [row.id, row]));
  const sourceCounts = new Map<string, number>();
  for (const movement of state.movements) {
    const identity = `${movement.sourceKind}:${movement.sourceId}`;
    sourceCounts.set(identity, (sourceCounts.get(identity) ?? 0) + 1);
  }
  const children: CashMovement[] = [];
  const movements = state.movements.map(movement => {
    if (movement.ownerId !== state.ownerId || movement.sourceKind !== "bank" || movement.sourceMissing ||
      !["excluded", "review"].includes(movement.status) || sourceCounts.get(`bank:${movement.sourceId}`) !== 1 ||
      !movement.feeTransactionId || !Number.isSafeInteger(movement.confirmedFeeMinor) || (movement.confirmedFeeMinor ?? 0) <= 0 || movement.confirmedFeeMinor !== movement.feeMinor) return movement;
    const message = byMessage.get(movement.sourceId), fee = byTransaction.get(movement.feeTransactionId);
    if (!message || !fee || message.feeTransactionId !== fee.transactionId || fee.status !== "active" || fee.type !== "expense" || fee.category !== "Fees" ||
      fee.currency !== movement.currency || message.currency !== movement.currency || fee.sourceUpdateId !== `bank:${message.id}:fee`) return movement;
    try { if (toMinor(fee.amount) !== movement.confirmedFeeMinor || toMinor(message.fee) !== movement.confirmedFeeMinor) return movement; }
    catch { return movement; }
    const child = sourceMovements(state.ownerId, [fee], [])[0];
    if (!child || state.movements.some(row => row.id === child.id) || children.some(row => row.id === child.id)) return movement;
    children.push({ ...child, accountId: movement.accountId, occurredAt: movement.occurredAt, sourceLabel: movement.sourceLabel });
    // Full original amounts/fees, raw SMS and proof remain in alfred.native.
    return { ...movement, feeMinor: 0, confirmedFeeMinor: 0, feeTransactionId: null };
  });
  return children.length ? { ...state, movements: [...movements, ...children] } : state;
}

/** Reconstruct the exact source adapter input from the same owner-scoped SQL snapshot. */
export function accountingCoreFromNative(native: AlfredNativeExport, ownerId: string, namespace: string) {
  const raw = native.tables.transactions.map((row): TransactionRecord => ({
    transactionId: String(row.transaction_id), createdAt: iso(row.created_at), transactionDate: String(row.transaction_date), userId: ownerId,
    type: row.type as TransactionRecord["type"], amount: String(row.amount), currency: String(row.currency).trim(), category: String(row.category), description: String(row.description),
    paymentMethod: String(row.payment_method), notes: String(row.notes), status: row.status as TransactionRecord["status"], updatedAt: iso(row.updated_at), sourceUpdateId: String(row.source_update_id), rowNumber: Number(row.id),
  }));
  const bank = native.tables.bankMessages.map((row): BankMessage => ({
    id: String(row.id), ownerId, source: row.source as BankMessage["source"], channel: row.channel as BankMessage["channel"], externalId: row.external_id === null ? null : String(row.external_id),
    direction: row.direction as BankMessage["direction"], kind: row.kind as BankMessage["kind"], amount: Number(row.amount).toFixed(2), fee: Number(row.fee).toFixed(2), currency: String(row.currency).trim(), counterparty: String(row.counterparty),
    balance: row.balance === null ? null : Number(row.balance).toFixed(2), occurredAt: iso(row.occurred_at), status: row.status as BankMessage["status"], transactionId: row.transaction_id === null ? null : String(row.transaction_id),
    feeTransactionId: row.fee_transaction_id === null ? null : String(row.fee_transaction_id), askedAt: row.asked_at === null ? null : iso(row.asked_at), raw: String(row.raw), readBy: (row.read_by ?? "rules") as BankMessage["readBy"],
  }));
  const stored = native.tables.accountingStates[0]?.state as AccountingState | undefined;
  const base = stored ? { ...structuredClone(stored), ownerId, movements: stored.movements.map((row) => ({ ...row, ownerId })) } : emptyAccountingState(ownerId);
  const imported = (native.tables.importedSources ?? []).map((row) => ({ ...(row.movement as CashMovement), ownerId }));
  const ruleDocument=native.tables.accountRuleStates?.[0]?.state as AccountRuleState|undefined;
  const rules=ruleDocument?{...ruleDocument,ownerId}:emptyAccountRuleState(ownerId);
  const bound=applyAccountRules({...base,movements:[...sourceMovements(ownerId,raw,bank),...imported]},rules);
  const state=splitConfirmedBankFeesForPortability(applyAccountRules(hydrateAccountingSources(base,bound.movements),rules),raw,bank);
  const rawCore = JSON.parse(JSON.stringify(Object.fromEntries(CORE_DOMAINS.map((domain) => [domain, state[domain].map((row) => {
    const { ownerId: _owner, ...portable } = row as unknown as Record<string, unknown>; // Destination ownership always comes from its own session.
    void _owner;
    const sourced = { ...portable, importProvenance: portable.importProvenance ?? { namespace, sourceId: row.id } };
    return domain === "movements" ? { ...sourced, taxMinor: (row as CashMovement).taxMinor ?? 0 } : sourced;
  })])))) as Datasets;
  return selectPortableCore(rawCore);
}

/** Stale and unsupported native evidence stays lossless in alfred.native, never becomes fresh cash. */
export function selectPortableCore(raw: Datasets): { datasets: Datasets; coverage: ExportCoverage[] } {
  try {
    if (!(raw.movements as Record<string, unknown>[]).some((row) => row.sourceMissing === true)) {
      validateDatasets(raw); return { datasets: raw, coverage: [] };
    }
  } catch { /* Validate independent records below; full native evidence remains untouched. */ }
  const datasets = { accounts: [], movements: [], snapshots: [], transfers: [], settlements: [] } as Datasets;
  const dropped = Object.fromEntries(CORE_DOMAINS.map((domain) => [domain, 0])) as Record<Domain, number>;
  const accounts = new Map<string, Record<string, unknown>>();
  const movements = new Map<string, Record<string, unknown>>();
  const reserved = new Set<string>();
  for (const domain of CORE_DOMAINS) {
    const seen = new Set<string>();
    for (const row of raw[domain] as Record<string, unknown>[]) {
      const id = String(row.id);
      if (seen.has(id) || domain === "movements" && row.sourceMissing === true) { dropped[domain]++; continue; }
      seen.add(id);
      // Bound each validation graph by one row and its direct references (at most 101
      // settlement movements). The final whole-graph validation is linear, not per-row.
      const candidate = { accounts: [], movements: [], snapshots: [], transfers: [], settlements: [] } as Datasets;
      let references: string[] = [];
      if (domain === "movements") candidate.movements = [row];
      else if (domain === "snapshots") references = row.sourceMovementId === null ? [] : [String(row.sourceMovementId)];
      else if (domain === "transfers") references = [String((row.outgoing as {movementId:string}).movementId), String((row.incoming as {movementId:string}).movementId)];
      else if (domain === "settlements") references = [String((row.original as {movementId:string}).movementId), ...(row.returns as {movementId:string}[]).map((item) => String(item.movementId))];
      if (domain !== "movements") candidate.movements = references.map((key) => movements.get(key)).filter((item) => item !== undefined);
      const accountIds = new Set((candidate.movements as Record<string, unknown>[]).flatMap((item) => item.accountId === null ? [] : [String(item.accountId)]));
      if (domain === "snapshots") accountIds.add(String(row.accountId));
      candidate.accounts = [...accountIds].map((key) => accounts.get(key)).filter((item) => item !== undefined);
      candidate[domain] = [row];
      try {
        if ((domain === "transfers" || domain === "settlements") && references.some((key) => reserved.has(key))) throw new Error("Already linked");
        validateDatasets(candidate); datasets[domain].push(row);
        if (domain === "accounts") accounts.set(id, row);
        if (domain === "movements") movements.set(id, row);
        if (domain === "transfers" || domain === "settlements") references.forEach((key) => reserved.add(key));
      } catch { dropped[domain]++; }
    }
  }
  // Match the existing report adapter: a stale formerly-paired transfer reverts to its current
  // source classification. The discarded link remains in native audit evidence.
  const linked = new Set((datasets.transfers as {outgoing:{movementId:string};incoming:{movementId:string}}[]).flatMap((row) => [row.outgoing.movementId,row.incoming.movementId]));
  const originallyLinked = new Set((raw.transfers as {outgoing:{movementId:string};incoming:{movementId:string}}[]).flatMap((row) => [row.outgoing.movementId,row.incoming.movementId]));
  datasets.movements = (datasets.movements as Record<string, unknown>[]).map((row) => row.status === "transfer" && row.sourceStatus !== "transfer" && originallyLinked.has(String(row.id)) && !linked.has(String(row.id)) ? { ...row, status: row.sourceStatus ?? "review" } : row);
  validateDatasets(datasets);
  const coverage: ExportCoverage[] = CORE_DOMAINS.filter((domain) => dropped[domain]).map((domain) => ({ dataset: `alfred.native.unsupportedCore.${domain}`, status: "preserved", count: dropped[domain], reason: "Stale, missing-source or unsupported native accounting evidence remains in the full native snapshot; it is not imported as fresh supported accounting data." }));
  return { datasets, coverage };
}
