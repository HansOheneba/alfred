import { attentionGroupKey, emptyActivityFilters, filterActivityMovements, type ActivityFilters } from "@/app/accounts/activity-tools";
import { isRealDate } from "../dates";
import { accountBalances } from "./accounts";
import type { AccountingResult } from "./persisted-store";
import { validateSettlements } from "./settlements";
import { attentionSummary, needsAttention, type AccountingAudit, type BalanceSnapshot, type CashMovement, type FinancialAccount, type MovementReference, type SettlementReturn, type TransferLink } from "./types";
import { accountingReportRows } from "./view";

export const ACCOUNTS_READ_PAGE_SIZE = 25;
export type AccountsReadSection = "activity" | "attention" | "movement" | "similar" | "snapshots" | "transfers" | "settlements" | "settlement-plan" | "returns" | "targets" | "evidence";
export type AccountsReadQuery = {
  currency: string;
  section: AccountsReadSection;
  page: number;
  filters?: ActivityFilters;
  accountId?: string;
  direction?: "in" | "out";
  search?: string;
  movementId?: string;
  fingerprint?: string;
  settlementId?: string;
  groupKey?: string;
  kind?: "refund" | "loan";
  expectedRevision?: number;
  expectedSourceVersion?: string | null;
};
export type AccountsReadMovement = Omit<CashMovement, "sourceText"> & { linked: boolean; nextReviewId?: string; returnedPrincipalMinor?: number };
export type AccountsReadSnapshot = BalanceSnapshot;
export type AccountsReadTransfer = { link: TransferLink; outgoing: AccountsReadMovement | null; incoming: AccountsReadMovement | null };
export type AccountsReadSettlement = {
  id: string; kind: "refund" | "loan"; createdAt: string; original: AccountsReadMovement | null; originalReference: MovementReference;
  returnedMinor: number; outstandingMinor: number | null; returnCount: number; issue: string | null;
};
export type AccountsReadReturn = { movement: AccountsReadMovement | null; reference: MovementReference; principalMinor: number };
export type AccountsReadSettlementPlan = {
  existing: { id: string; kind: "refund" | "loan"; original: MovementReference; returns: SettlementReturn[] } | null;
  usedPrincipalMinor: number;
};
export type AccountsReadEvidence = { id: string; sourceFingerprint: string; sourceText: string | null };
export type AccountsReadAttentionGroup = { key: string; description: string; accountId: string | null; currency: string; direction: CashMovement["direction"]; total: number };
type Page<T, S extends AccountsReadSection> = { section: S; page: number; pageSize: 25; total: number; rows: T[] };
export type AccountsReadPage = Page<AccountsReadMovement, "activity" | "attention" | "movement" | "similar" | "targets">
  | Page<AccountsReadSnapshot, "snapshots"> | Page<AccountsReadTransfer, "transfers">
  | Page<AccountsReadSettlement, "settlements"> | Page<AccountsReadSettlementPlan, "settlement-plan">
  | Page<AccountsReadReturn, "returns"> | Page<AccountsReadEvidence, "evidence">;
/** A display projection, deliberately distinct from the authoritative AccountingState. */
export type AccountsReadView = {
  kind: "accounts-read"; ownerId: string; revision: number; sourceVersion: string | null;
  availability: AccountingResult["availability"]; currency: string; accounts: FinancialAccount[];
  balances: ReturnType<typeof accountBalances>;
  attentionCounts: ReturnType<typeof attentionSummary>;
  attentionGroups: AccountsReadAttentionGroup[];
  counts: { movements: number; snapshots: number; transfers: number; settlements: number };
  audit: Omit<AccountingAudit, "before" | "actionFingerprint">[];
  page: AccountsReadPage;
  facets: { currencies: string[]; categories: string[] };
};

export class AccountsReadViewError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 409 = 400) { super(message); this.name = "AccountsReadViewError"; }
}

const sections: readonly string[] = ["activity", "attention", "movement", "similar", "snapshots", "transfers", "settlements", "settlement-plan", "returns", "targets", "evidence"];
const statuses: readonly string[] = ["confirmed", "review", "hold", "transfer", "duplicate", "excluded"];
const sorts: readonly string[] = ["date-desc", "date-asc", "amount-desc", "amount-asc"];
function badQuery(): never { throw new AccountsReadViewError("Check the account view options and try again."); }
function text(params: URLSearchParams, key: string, max: number, fallback = ""): string {
  const value = params.get(key) ?? fallback;
  if (value.length > max || /[\u0000-\u001f]/.test(value)) badQuery();
  return value.trim();
}
function safeInteger(raw: string): number {
  if (!/^\d+$/.test(raw)) badQuery();
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) badQuery();
  return value;
}

/** Bounded selection parameters only. Identity always comes from the signed-in owner. */
export function parseAccountsReadQuery(params: URLSearchParams): AccountsReadQuery {
  const currency = text(params, "currency", 3, "GHS");
  if (!/^[A-Z]{3}$/.test(currency)) badQuery();
  const section = text(params, "section", 20, "activity");
  if (!sections.includes(section)) badQuery();
  const page = safeInteger(text(params, "page", 16, "0"));
  const accountId = text(params, "accountId", 200), movementId = text(params, "movementId", 200);
  const fingerprint = text(params, "fingerprint", 500), settlementId = text(params, "settlementId", 200);
  const groupKey = text(params, "groupKey", 2000);
  const kind = text(params, "kind", 6);
  if (kind && kind !== "refund" && kind !== "loan") badQuery();
  const direction = text(params, "direction", 3);
  if (direction && direction !== "in" && direction !== "out") badQuery();
  if (section === "evidence" && (!movementId || !fingerprint)) badQuery();
  if (section === "movement" && !movementId) badQuery();
  if (section === "similar" && !groupKey) badQuery();
  if (section === "settlement-plan" && (!movementId || !kind)) badQuery();
  if (section === "returns" && !settlementId) badQuery();
  const search = text(params, "search", 200, params.get("q") ?? "");
  const start = text(params, "from", 10, params.get("start") ?? ""), end = text(params, "to", 10, params.get("end") ?? "");
  if ((start && !isRealDate(start)) || (end && !isRealDate(end)) || (start && end && start > end)) badQuery();
  const status = text(params, "status", 20), type = text(params, "type", 7, "all"), sort = text(params, "sort", 11, "date-desc");
  const filterCurrency = text(params, "filterCurrency", 3);
  if ((status && !statuses.includes(status)) || !["all", "expense", "income"].includes(type) || !sorts.includes(sort)
    || (filterCurrency && !/^[A-Z]{3}$/.test(filterCurrency))) badQuery();
  const filters: ActivityFilters = {
    ...emptyActivityFilters, search, start, end, status, type: type as ActivityFilters["type"], sort: sort as ActivityFilters["sort"],
    account: text(params, "account", 200), category: text(params, "category", 40), currency: filterCurrency,
  };
  const hasRevision = params.has("expectedRevision"), hasSource = params.has("expectedSourceVersion");
  if (hasRevision !== hasSource) badQuery();
  const cursor = hasRevision ? {
    expectedRevision: safeInteger(text(params, "expectedRevision", 16)),
    expectedSourceVersion: text(params, "expectedSourceVersion", 500) || null,
  } : {};
  return { currency, section: section as AccountsReadSection, page, filters, ...cursor,
    ...(accountId ? { accountId } : {}), ...(movementId ? { movementId } : {}), ...(fingerprint ? { fingerprint } : {}),
    ...(settlementId ? { settlementId } : {}), ...(direction ? { direction: direction as "in" | "out" } : {}), ...(search ? { search } : {}),
    ...(groupKey ? { groupKey } : {}),
    ...(kind ? { kind: kind as "refund" | "loan" } : {}),
  };
}

function pageRows<T, S extends AccountsReadSection>(section: S, rows: readonly T[], requestedPage: number): Page<T, S> {
  const page = Math.min(Math.max(0, requestedPage), Math.max(0, Math.ceil(rows.length / ACCOUNTS_READ_PAGE_SIZE) - 1));
  return { section, page, pageSize: ACCOUNTS_READ_PAGE_SIZE, total: rows.length, rows: rows.slice(page * ACCOUNTS_READ_PAGE_SIZE, (page + 1) * ACCOUNTS_READ_PAGE_SIZE) };
}

/** Compute on the complete, source-coherent server model. No sliced state is used for accounting math or writes. */
export function projectAccountsReadView(result: AccountingResult, query: AccountsReadQuery): AccountsReadView {
  const { state } = result;
  if (query.expectedRevision !== undefined || query.expectedSourceVersion !== undefined) {
    if (query.expectedRevision === undefined || query.expectedSourceVersion === undefined) badQuery();
    if (query.expectedRevision !== state.revision || query.expectedSourceVersion !== result.sourceVersion) {
      throw new AccountsReadViewError("Financial records or source evidence changed. Reload the latest account view.", 409);
    }
  }
  if (!Number.isSafeInteger(query.page) || query.page < 0 || !sections.includes(query.section)) badQuery();
  const balances = accountBalances(state, query.currency);
  const linked = new Set<string>();
  const returnedPrincipal = new Map<string, number>();
  for (const link of state.transfers) { linked.add(link.outgoing.movementId); linked.add(link.incoming.movementId); }
  for (const link of state.settlements) {
    linked.add(link.original.movementId);
    let total = returnedPrincipal.get(link.original.movementId) ?? 0;
    for (const item of link.returns) { linked.add(item.movementId); total += item.principalMinor; }
    if (!Number.isSafeInteger(total)) throw new AccountsReadViewError("The saved return records could not be displayed safely.");
    returnedPrincipal.set(link.original.movementId, total);
  }
  const attention = state.movements.filter(needsAttention);
  const groups = new Map<string, AccountsReadAttentionGroup>();
  for (const row of attention) {
    const key = attentionGroupKey(row), group = groups.get(key);
    if (group) group.total += 1;
    else groups.set(key, { key, description: row.description, accountId: row.accountId, currency: row.currency, direction: row.direction, total: 1 });
  }
  const nextReview = attention.filter(row => !linked.has(row.id)).slice(0, 2);
  const compact = (row: CashMovement): AccountsReadMovement => {
    const { sourceText: _sourceText, ...value } = row;
    void _sourceText;
    const nextReviewId = nextReview.find(item => item.id !== row.id)?.id;
    return { ...value, linked: linked.has(row.id), ...(nextReviewId ? { nextReviewId } : {}),
      ...(returnedPrincipal.has(row.id) ? { returnedPrincipalMinor: returnedPrincipal.get(row.id)! } : {}) };
  };
  const movements = new Map(state.movements.map(row => [row.id, row]));
  const findCompact = (id: string) => { const row = movements.get(id); return row ? compact(row) : null; };
  const reportRows = accountingReportRows(state);
  let page: AccountsReadPage;
  switch (query.section) {
    case "activity":
    case "attention": {
      const filtered = filterActivityMovements(state, query.filters ?? emptyActivityFilters, reportRows);
      const rows = query.section === "attention" ? filtered.filter(needsAttention) : filtered;
      const selected = pageRows(query.section, rows, query.page);
      page = { ...selected, rows: selected.rows.map(compact) };
      break;
    }
    case "movement": {
      if (!query.movementId) badQuery();
      const row = movements.get(query.movementId);
      page = pageRows("movement", row ? [compact(row)] : [], 0);
      break;
    }
    case "similar": {
      if (!query.groupKey) badQuery();
      const selected = pageRows("similar", attention.filter(row => attentionGroupKey(row) === query.groupKey && row.status !== "transfer" && !linked.has(row.id)), query.page);
      page = { ...selected, rows: selected.rows.map(compact) };
      break;
    }
    case "snapshots":
      page = pageRows("snapshots", state.snapshots.filter(row => !query.accountId || row.accountId === query.accountId)
        .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id)), query.page);
      break;
    case "transfers": {
      const selected = pageRows("transfers", state.transfers, query.page);
      page = { ...selected, rows: selected.rows.map(link => ({ link, outgoing: findCompact(link.outgoing.movementId), incoming: findCompact(link.incoming.movementId) })) };
      break;
    }
    case "settlements": {
      const resolved = validateSettlements(state);
      const valid = new Map(resolved.valid.map(row => [row.link.id, row]));
      const issues = new Map(resolved.issues.map(row => [row.link.id, row.reason]));
      const selected = pageRows("settlements", state.settlements, query.page);
      page = { ...selected, rows: selected.rows.map(link => {
        const current = valid.get(link.id), returnedMinor = link.returns.reduce((sum, row) => sum + row.principalMinor, 0);
        if (!Number.isSafeInteger(returnedMinor)) throw new AccountsReadViewError("The saved return records could not be displayed safely.");
        return { id: link.id, kind: link.kind, createdAt: link.createdAt, original: findCompact(link.original.movementId), originalReference: link.original,
          returnedMinor, outstandingMinor: current?.outstandingMinor ?? null, returnCount: link.returns.length, issue: issues.get(link.id) ?? null };
      }) };
      break;
    }
    case "returns": {
      if (!query.settlementId) badQuery();
      const link = state.settlements.find(row => row.id === query.settlementId);
      const selected = pageRows("returns", link?.returns ?? [], query.page);
      page = { ...selected, rows: selected.rows.map(row => ({ movement: findCompact(row.movementId), reference: { movementId: row.movementId, sourceFingerprint: row.sourceFingerprint }, principalMinor: row.principalMinor })) };
      break;
    }
    case "settlement-plan": {
      if (!query.movementId || !query.kind) badQuery();
      const matches = state.settlements.filter(link => link.original.movementId === query.movementId && link.kind === query.kind);
      if (matches.length > 1) throw new AccountsReadViewError("The saved return links need review before adding another return.", 409);
      const existing = matches[0];
      if (existing && existing.returns.length > 100) throw new AccountsReadViewError("The saved return link needs review before adding another return.", 409);
      // These are the exact saved references, not references reconstructed from current evidence.
      const plan: AccountsReadSettlementPlan = { existing: existing ? { id: existing.id, kind: existing.kind, original: { ...existing.original }, returns: existing.returns.map(row => ({ ...row })) } : null,
        usedPrincipalMinor: returnedPrincipal.get(query.movementId) ?? 0 };
      page = pageRows("settlement-plan", [plan], 0);
      break;
    }
    case "targets": {
      const needle = query.search?.trim().toLowerCase();
      const targets = state.movements.filter(row => row.status === "confirmed" && (!query.direction || row.direction === query.direction)
        && (!query.accountId || row.accountId === query.accountId)
        && (!needle || `${row.description} ${row.category} ${row.sourceId}`.toLowerCase().includes(needle)));
      const selected = pageRows("targets", targets, query.page);
      page = { ...selected, rows: selected.rows.map(compact) };
      break;
    }
    case "evidence": {
      if (!query.movementId || !query.fingerprint) badQuery();
      const row = movements.get(query.movementId);
      if (!row) throw new AccountsReadViewError("That payment is unavailable in your account.");
      if (row.sourceFingerprint !== query.fingerprint) throw new AccountsReadViewError("The payment's source evidence changed. Reload its latest details.", 409);
      page = pageRows("evidence", [{ id: row.id, sourceFingerprint: row.sourceFingerprint, sourceText: row.sourceText ?? null }], 0);
      break;
    }
  }
  return {
    kind: "accounts-read", ownerId: state.ownerId, revision: state.revision, sourceVersion: result.sourceVersion,
    availability: result.availability, currency: query.currency, accounts: state.accounts, balances,
    attentionCounts: attentionSummary(state.movements), attentionGroups: [...groups.values()].filter(group => group.total > 1).sort((a, b) => b.total - a.total).slice(0, 6),
    counts: { movements: state.movements.length, snapshots: state.snapshots.length, transfers: state.transfers.length, settlements: state.settlements.length },
    audit: state.audit.slice(-50).map(({ id, requestId, action, at, revision }) => ({ id, requestId, action, at, revision })),
    page, facets: { currencies: [...new Set([query.currency, ...state.accounts.map(row => row.currency), ...state.movements.map(row => row.currency)])].sort(),
      categories: [...new Set([...state.movements.map(row => row.category), ...reportRows.map(row => row.category)])].filter(Boolean).sort() },
  };
}
