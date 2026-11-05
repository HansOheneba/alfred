import { attentionGroupKey, emptyActivityFilters, filterActivityMovements } from "@/app/accounts/activity-tools";
import type { LedgerRow } from "../analytics";
import { displayRenewalGroup } from "../display-insight-facts";
import { accountBalanceFacts, accountBalances, type AccountBalanceRow } from "./accounts";
import type { DurableModelRow } from "./display-model";
import type { AccountingResult } from "./persisted-store";
import { AccountsReadViewError, type AccountsReadAttentionGroup, type AccountsReadEvidence, type AccountsReadMovement, type AccountsReadSettlement } from "./read-view";
import { validateSettlements } from "./settlements";
import { AccountingError, attentionSummary, needsAttention, type AccountingAudit, type FinancialAccount, type MovementReference, type SettlementLink, type TransferLink } from "./types";
import { accountingReportRows } from "./view";

export type AccountsModelManifest = {
  kind: "accounts-model";
  schemaVersion: 1;
  subscriptionFactsVersion: 1;
  ownerId: string;
  revision: number;
  sourceVersion: string | null;
  availability: AccountingResult["availability"];
  accounts: FinancialAccount[];
  accountFacts: AccountBalanceRow[];
  counts: { movements: number; snapshots: number; transfers: number; settlements: number };
  attentionCounts: ReturnType<typeof attentionSummary>;
  attentionGroups: AccountsReadAttentionGroup[];
  /** First two eligible entries in full source order, independent of activity filters. */
  nextReviewIds: string[];
  linkedLoans: AccountsModelLinkedLoan[];
  linkedLoanDates: Record<string, string>;
  settlementIssues: string[];
  /** The selected display currency is added when assembling a response. */
  facets: { currencies: string[]; categories: string[] };
  audit: Omit<AccountingAudit, "before" | "actionFingerprint">[];
};
export type AccountsModelLinkedLoan = { settlementId: string; originalMovementId: string; description: string; currency: string; principalMinor: number; returnedMinor: number; outstandingMinor: number };
export type AccountsModelReportMatch = Pick<LedgerRow, "type" | "category" | "currency" | "description"> & { searchText: string };
export type AccountsModelMovementPayload = { movement: AccountsReadMovement; reportMatches: AccountsModelReportMatch[]; subscriptionReport: LedgerRow | null; subscriptionReportOrdinal: number | null; subscriptionRenewalGroup: ReturnType<typeof displayRenewalGroup> };
export type AccountsModelTransferPayload = { link: TransferLink };
export type AccountsModelSettlementPayload = { summary: Omit<AccountsReadSettlement, "original">; link: SettlementLink };
export type AccountsModelReturnPayload = { movementId: string; reference: MovementReference; principalMinor: number };
export type AccountsModelEvidencePayload = AccountsReadEvidence;

/** Reconciliation is precomputed once; currency selection performs only the original cash aggregation. */
export function balanceForCurrency(accountFacts: readonly AccountBalanceRow[], currency: string): ReturnType<typeof accountBalances> {
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) throw new AccountingError("Currency must be a three-letter uppercase code.");
  const included = accountFacts.filter(row => row.account.includeInCash && row.account.currency === currency);
  const known = included.filter(row => row.snapshot !== null);
  const missingCount = included.length - known.length;
  const knownSubtotalMinor = known.length ? known.reduce((sum, row) => sum + row.snapshot!.balanceMinor, 0) : null;
  if (knownSubtotalMinor !== null && !Number.isSafeInteger(knownSubtotalMinor)) throw new AccountingError("Known account subtotal must be a safe integer in minor units.");
  return { accounts: [...accountFacts], totalMinor: included.length > 0 && missingCount === 0 ? knownSubtotalMinor : null,
    knownSubtotalMinor, count: included.length, missingCount, excludedCount: accountFacts.length - included.length };
}

/** Build from one complete source-coherent result. These rows are display facts, never a replacement AccountingState. */
export function buildAccountsModel(result: AccountingResult): { manifest: AccountsModelManifest; rows: DurableModelRow[] } {
  const { state } = result;
  const accountFacts = accountBalanceFacts(state);
  const linked = new Set<string>(), returnedPrincipal = new Map<string, number>();
  for (const link of state.transfers) { linked.add(link.outgoing.movementId); linked.add(link.incoming.movementId); }
  for (const link of state.settlements) {
    linked.add(link.original.movementId);
    let total = returnedPrincipal.get(link.original.movementId) ?? 0;
    for (const entry of link.returns) { linked.add(entry.movementId); total += entry.principalMinor; }
    if (!Number.isSafeInteger(total)) throw new AccountsReadViewError("The saved return records could not be displayed safely.");
    returnedPrincipal.set(link.original.movementId, total);
  }
  const attention = state.movements.filter(needsAttention), groups = new Map<string, AccountsReadAttentionGroup>();
  for (const movement of attention) {
    const key = attentionGroupKey(movement), prior = groups.get(key);
    if (prior) prior.total += 1;
    else groups.set(key, { key, description: movement.description, accountId: movement.accountId, currency: movement.currency, direction: movement.direction, total: 1 });
  }
  const nextReviewIds = attention.filter(movement => !linked.has(movement.id)).slice(0, 2).map(movement => movement.id);
  const reportRows = accountingReportRows(state), reportMatches = new Map<string, AccountsModelReportMatch[]>();
  for (const report of reportRows) {
    const movementId = report.id.replace(/^accounting(?:-fee|-tax)?:/, "");
    const entries = reportMatches.get(movementId) ?? [];
    entries.push({ type: report.type, category: report.category, currency: report.currency, description: report.description, searchText: `${report.description} ${report.category}`.toLowerCase() });
    reportMatches.set(movementId, entries);
  }
  const subscriptionReports = new Map(reportRows.filter(row => !row.id.startsWith("accounting-fee:") && !row.id.startsWith("accounting-tax:")).map((row, ordinal) => [row.id.replace(/^accounting:/, ""), { row, ordinal }]));
  const ranks = (sort: "date-asc" | "date-desc" | "amount-asc" | "amount-desc") => new Map(filterActivityMovements(state, { ...emptyActivityFilters, sort }, reportRows).map((movement, rank) => [movement.id, rank]));
  const dateAsc = ranks("date-asc"), dateDesc = ranks("date-desc"), amountAsc = ranks("amount-asc"), amountDesc = ranks("amount-desc");
  const rows: DurableModelRow[] = [];
  for (const [ordinal, movement] of state.movements.entries()) {
    const { sourceText, ...source } = movement;
    const nextReviewId = nextReviewIds.find(id => id !== movement.id);
    const compact: AccountsReadMovement = { ...source, linked: linked.has(movement.id), ...(nextReviewId ? { nextReviewId } : {}),
      ...(returnedPrincipal.has(movement.id) ? { returnedPrincipalMinor: returnedPrincipal.get(movement.id)! } : {}) };
    const matches = reportMatches.get(movement.id) ?? [];
    if (matches.length > 3) throw new AccountsReadViewError("The payment's report facts could not be displayed safely.");
    const subscription = subscriptionReports.get(movement.id);
    const payload: AccountsModelMovementPayload = { movement: compact, reportMatches: matches, subscriptionReport: subscription?.row ?? null, subscriptionReportOrdinal: subscription?.ordinal ?? null, subscriptionRenewalGroup: subscription ? displayRenewalGroup(subscription.row) : null };
    rows.push({ id: movement.id, kind: "movement", ordinal, accountId: movement.accountId, date: movement.date, currency: movement.currency,
      category: movement.category, direction: movement.direction, status: movement.status, amountMinor: movement.amountMinor,
      searchText: `${movement.description} ${movement.category} ${movement.sourceId}`.toLowerCase(),
      rankDateAsc: dateAsc.get(movement.id)!, rankDateDesc: dateDesc.get(movement.id)!, rankAmountAsc: amountAsc.get(movement.id)!, rankAmountDesc: amountDesc.get(movement.id)!,
      needsAttention: needsAttention(movement), groupKey: attentionGroupKey(movement), payload });
    const evidence: AccountsModelEvidencePayload = { id: movement.id, sourceFingerprint: movement.sourceFingerprint, sourceText: sourceText ?? null };
    rows.push({ id: movement.id, kind: "evidence", ordinal, searchText: "", payload: evidence });
  }
  const snapshotRanks = new Map([...state.snapshots].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id)).map((snapshot, rank) => [snapshot.id, rank]));
  for (const [ordinal, snapshot] of state.snapshots.entries()) rows.push({ id: snapshot.id, kind: "snapshot", ordinal, accountId: snapshot.accountId,
    date: snapshot.occurredAt, rankDateDesc: snapshotRanks.get(snapshot.id)!, searchText: "", payload: snapshot });
  for (const [ordinal, link] of state.transfers.entries()) {
    const payload: AccountsModelTransferPayload = { link };
    rows.push({ id: link.id, kind: "transfer", ordinal, date: link.createdAt, searchText: "", payload });
  }
  const resolved = validateSettlements(state), valid = new Map(resolved.valid.map(entry => [entry.link.id, entry]));
  const issues = new Map(resolved.issues.map(entry => [entry.link.id, entry.reason]));
  let globalReturnOrdinal = 0;
  for (const [ordinal, link] of state.settlements.entries()) {
    const returnedMinor = link.returns.reduce((sum, entry) => sum + entry.principalMinor, 0);
    if (!Number.isSafeInteger(returnedMinor)) throw new AccountsReadViewError("The saved return records could not be displayed safely.");
    const payload: AccountsModelSettlementPayload = { link, summary: { id: link.id, kind: link.kind, createdAt: link.createdAt,
      originalReference: link.original, returnedMinor, outstandingMinor: valid.get(link.id)?.outstandingMinor ?? null, returnCount: link.returns.length, issue: issues.get(link.id) ?? null } };
    rows.push({ id: link.id, kind: "settlement", ordinal, relationId: link.original.movementId, category: link.kind, date: link.createdAt, searchText: "", payload });
    for (const [returnOrdinal, entry] of link.returns.entries()) {
      const reference: MovementReference = { movementId: entry.movementId, sourceFingerprint: entry.sourceFingerprint };
      const returnPayload: AccountsModelReturnPayload = { movementId: entry.movementId, reference, principalMinor: entry.principalMinor };
      rows.push({ id: JSON.stringify([link.id, returnOrdinal]), kind: "return", ordinal: globalReturnOrdinal++, relationId: link.id, amountMinor: entry.principalMinor, searchText: "", payload: returnPayload });
    }
  }
  const manifest: AccountsModelManifest = { kind: "accounts-model", schemaVersion: 1, subscriptionFactsVersion: 1, ownerId: state.ownerId, revision: state.revision, sourceVersion: result.sourceVersion,
    availability: result.availability, accounts: state.accounts, accountFacts,
    counts: { movements: state.movements.length, snapshots: state.snapshots.length, transfers: state.transfers.length, settlements: state.settlements.length },
    attentionCounts: attentionSummary(state.movements), attentionGroups: [...groups.values()].filter(group => group.total > 1).sort((a, b) => b.total - a.total).slice(0, 6), nextReviewIds,
    linkedLoans: resolved.valid.filter(entry => entry.link.kind === "loan").map(entry => ({ settlementId: entry.link.id, originalMovementId: entry.original.id,
      description: entry.original.description, currency: entry.original.currency, principalMinor: entry.original.amountMinor, returnedMinor: entry.returnedMinor, outstandingMinor: entry.outstandingMinor })),
    linkedLoanDates: Object.fromEntries(resolved.valid.filter(entry => entry.link.kind === "loan").map(entry => [entry.original.id, entry.original.occurredAt ?? entry.original.date])),
    settlementIssues: resolved.issues.map(entry => entry.reason),
    facets: { currencies: [...new Set([...state.accounts.map(account => account.currency), ...state.movements.map(movement => movement.currency)])].sort(),
      categories: [...new Set([...state.movements.map(movement => movement.category), ...reportRows.map(report => report.category)])].filter(Boolean).sort() },
    audit: state.audit.slice(-50).map(({ id, requestId, action, at, revision }) => ({ id, requestId, action, at, revision })) };
  // Do not expose references through which a display consumer could mutate the authoritative input.
  return structuredClone({ manifest, rows });
}
