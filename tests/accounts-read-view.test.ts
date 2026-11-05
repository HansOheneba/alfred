import { describe, expect, it } from "vitest";
import { attentionGroupKey, emptyActivityFilters, filterActivityMovements } from "@/app/accounts/activity-tools";
import { accountBalances } from "@/lib/finance/accounting/accounts";
import { browserAccountingState } from "@/lib/finance/accounting/browser-state";
import type { AccountingResult } from "@/lib/finance/accounting/persisted-store";
import { parseAccountsReadQuery, projectAccountsReadView, type AccountsReadQuery } from "@/lib/finance/accounting/read-view";
import { attentionSummary, emptyAccountingState, type AccountingState, type CashMovement } from "@/lib/finance/accounting/types";
import { accountingReportRows } from "@/lib/finance/accounting/view";

const AT = "2026-11-01T00:00:00.000Z", OWNER = "fictional-owner";
const query = (value: Partial<AccountsReadQuery> = {}): AccountsReadQuery => ({ currency: "GHS", section: "activity", page: 0, ...value });
const result = (state: AccountingState, sourceVersion: string | null = "fictional-version"): AccountingResult => ({ state, sourceVersion, availability: "ready", rawTransactions: [] });
function movement(index: number, overrides: Partial<CashMovement> = {}): CashMovement {
  const occurredAt = new Date(Date.parse(AT) + index * 60_000).toISOString();
  return { id: `fictional-payment:${index}`, ownerId: OWNER, accountId: "fictional-cash", direction: "out", status: "confirmed", amountMinor: 100, feeMinor: 0, taxMinor: 0,
    currency: "GHS", date: occurredAt.slice(0, 10), occurredAt, description: "Fictional merchant", category: `Fictional category ${index % 17}`,
    sourceId: `fictional-source:${index}`, sourceKind: "bank", sourceFingerprint: `fictional-fingerprint:${index}`, legacyTransactionId: null, feeTransactionId: null, legacyClassification: null,
    sourceText: "Fictional alert evidence only. ".repeat(40), ...overrides };
}
function fixture(count = 2315): AccountingState {
  const state = emptyAccountingState(OWNER);
  state.accounts = ["fictional-cash", "fictional-reserve"].map(id => ({ id, label: id, provider: "Fictional provider", currency: "GHS", includeInCash: id === "fictional-cash", createdAt: AT }));
  state.movements = Array.from({ length: count }, (_, index) => movement(index, index % 100 === 0 ? { status: "review", accountId: null } : {}));
  state.snapshots = Array.from({ length: Math.min(2277, count) }, (_, index) => ({ id: `fictional-snapshot:${index}`, accountId: "fictional-cash", balanceMinor: 1_000_000 - (index + 1) * 100,
    occurredAt: new Date(Date.parse(AT) + index * 60_000).toISOString(), sourceId: `fictional-statement:${index}`, sourceMovementId: null }));
  state.audit = [{ id: "fictional-audit", requestId: "fictional-request", action: "update_account", actionFingerprint: "fictional-action", at: AT, revision: 1,
    before: { accounts: state.accounts, movements: state.movements, snapshots: state.snapshots, transfers: [], settlements: [] } }];
  state.revision = 1;
  return state;
}

describe("bounded Accounts read projection", () => {
  it("ships 25 compact rows from 2,315 fictional movements and 2,277 snapshots, preserving full accounting math", () => {
    const state = fixture(), original = JSON.stringify(state);
    const view = projectAccountsReadView(result(state), query());
    expect(view.kind).toBe("accounts-read");
    expect(view.counts).toEqual({ movements: 2315, snapshots: 2277, transfers: 0, settlements: 0 });
    expect(view.page).toMatchObject({ section: "activity", page: 0, pageSize: 25, total: 2315 });
    expect(view.page.rows).toHaveLength(25);
    expect(view.page.rows[0]).toMatchObject({ id: "fictional-payment:2314" });
    expect(view.balances).toEqual(accountBalances(state, "GHS"));
    expect(view.balances.totalMinor).toBe(772300);
    expect(view.balances.accounts[0].reconciliation.status).toBe("matched");
    expect(view.attentionCounts).toEqual(attentionSummary(state.movements));
    expect(view.facets.categories).toHaveLength(17);
    expect(view.audit[0]).not.toHaveProperty("before");
    expect(view.audit[0]).not.toHaveProperty("actionFingerprint");
    expect(JSON.stringify(view)).not.toContain("sourceText");
    expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThan(40_000);
    expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThan(Buffer.byteLength(JSON.stringify(browserAccountingState(state))) / 80);
    expect(JSON.stringify(state)).toBe(original);
  });

  it("paginates the entire movement and snapshot history without dropping old records", () => {
    const state = fixture(63), found: string[] = [];
    for (let page = 0; page < 3; page += 1) {
      const view = projectAccountsReadView(result(state), query({ page }));
      expect(view.page.rows.length).toBeLessThanOrEqual(25);
      found.push(...view.page.rows.map(row => "id" in row ? row.id : ""));
    }
    expect(new Set(found)).toEqual(new Set(state.movements.map(row => row.id)));
    const snapshots = projectAccountsReadView(result(state), query({ section: "snapshots", accountId: "fictional-cash", page: 2 }));
    expect(snapshots.page.total).toBe(63); expect(snapshots.page.rows).toHaveLength(13);
    expect(snapshots.page.rows.at(-1)).toMatchObject({ id: "fictional-snapshot:0" });
    const outOfRange = projectAccountsReadView(result(state), query({ page: Number.MAX_SAFE_INTEGER }));
    expect(outOfRange.page.page).toBe(2); expect(outOfRange.page.rows).toHaveLength(13);
  });

  it("matches existing full-model category, fee, type and activity-filter semantics before paging", () => {
    const state = fixture(70);
    state.movements[1].feeMinor = 25;
    const filters = { ...emptyActivityFilters, category: "Fees", type: "expense" as const, sort: "amount-asc" as const };
    const expected = filterActivityMovements(state, filters, accountingReportRows(state));
    const view = projectAccountsReadView(result(state), query({ filters }));
    expect(view.page.total).toBe(expected.length);
    expect(view.page.rows.map(row => "id" in row ? row.id : "")).toEqual(expected.map(row => row.id));
    expect(view.page.rows[0]).toMatchObject({ id: state.movements[1].id, amountMinor: 100, feeMinor: 25 });
    expect(view.facets.categories).toContain("Fees");
  });

  it("keeps full attention counts and groups while bounding attention/similar/target rows", () => {
    const state = fixture(80);
    state.movements = state.movements.map((row, index) => ({ ...row, accountId: null, status: index === 0 ? "transfer" : "review", category: "Other" }));
    const header = projectAccountsReadView(result(state), query({ section: "attention" }));
    expect(header.attentionCounts.total).toBe(80); expect(header.attentionGroups).toHaveLength(1);
    expect(header.attentionGroups[0].total).toBe(80); expect(header.page.rows).toHaveLength(25);
    const similar = projectAccountsReadView(result(state), query({ section: "similar", groupKey: attentionGroupKey(state.movements[0]), page: 1 }));
    expect(similar.page.total).toBe(79); expect(similar.page.rows).toHaveLength(25);
    expect(similar.page.rows.every(row => "status" in row && row.status !== "transfer")).toBe(true);
    state.movements = state.movements.map((row, index) => ({ ...row, status: "confirmed", direction: index % 2 ? "out" : "in", accountId: "fictional-cash" }));
    const targets = projectAccountsReadView(result(state), query({ section: "targets", direction: "out", accountId: "fictional-cash", search: "merchant", page: 1 }));
    expect(targets.page.total).toBe(40); expect(targets.page.rows).toHaveLength(15);
    const single = projectAccountsReadView(result(state), query({ section: "movement", movementId: state.movements[79].id }));
    expect(single.page.rows).toHaveLength(1); expect(single.page.rows[0]).toMatchObject({ id: state.movements[79].id });
  });

  it("keeps link summaries compact, paginates return details and withholds stale settlement math", () => {
    const state = fixture(40);
    state.movements = state.movements.map((row, index) => ({ ...row, accountId: index === 1 ? "fictional-reserve" : "fictional-cash", status: "confirmed", direction: index === 1 || index > 2 ? "in" : "out", amountMinor: index === 2 ? 10000 : 100 }));
    const ref = (index: number) => ({ movementId: state.movements[index].id, sourceFingerprint: state.movements[index].sourceFingerprint });
    state.transfers = [{ id: "fictional-transfer", outgoing: ref(0), incoming: ref(1), createdAt: AT }];
    state.settlements = [{ id: "fictional-settlement", kind: "refund", original: ref(2), returns: state.movements.slice(3).map((row) => ({ movementId: row.id, sourceFingerprint: row.sourceFingerprint, principalMinor: 100 })), createdAt: AT }];
    const transfers = projectAccountsReadView(result(state), query({ section: "transfers" }));
    expect(transfers.page.rows[0]).toMatchObject({ outgoing: { linked: true }, incoming: { linked: true } });
    const settlements = projectAccountsReadView(result(state), query({ section: "settlements" }));
    expect(settlements.page.rows[0]).toMatchObject({ returnedMinor: 3700, outstandingMinor: 6300, returnCount: 37, issue: null });
    expect(settlements.page.rows[0]).not.toHaveProperty("returns");
    const returns = projectAccountsReadView(result(state), query({ section: "returns", settlementId: "fictional-settlement", page: 1 }));
    expect(returns.page.total).toBe(37); expect(returns.page.rows).toHaveLength(12);
    expect(returns.page.rows[0]).toMatchObject({ movement: { linked: true }, principalMinor: 100 });
    state.movements[3].sourceFingerprint = "fictional-changed";
    const stale = projectAccountsReadView(result(state), query({ section: "settlements" }));
    expect(stale.page.rows[0]).toMatchObject({ outstandingMinor: null });
    expect("issue" in stale.page.rows[0] && stale.page.rows[0].issue).toBeTruthy();
    expect(JSON.stringify([transfers, settlements, returns, stale])).not.toContain("sourceText");
  });

  it("fetches exactly one owner-scoped evidence body and rejects changed fingerprint, revision or sources", () => {
    const state = fixture(3), row = state.movements[1];
    const selected = query({ section: "evidence", movementId: row.id, fingerprint: row.sourceFingerprint, expectedRevision: 1, expectedSourceVersion: "fictional-version" });
    const view = projectAccountsReadView(result(state), selected);
    expect(view.page.rows).toEqual([{ id: row.id, sourceFingerprint: row.sourceFingerprint, sourceText: row.sourceText }]);
    expect(() => projectAccountsReadView(result(state), { ...selected, fingerprint: "fictional-other" })).toThrow(/source evidence changed/);
    expect(() => projectAccountsReadView(result(state), { ...selected, expectedRevision: 0 })).toThrow(/records or source evidence changed/);
    expect(() => projectAccountsReadView(result(state, "fictional-new-version"), selected)).toThrow(/records or source evidence changed/);
    expect(() => projectAccountsReadView(result(state), { ...selected, movementId: "other-owner-payment" })).toThrow(/unavailable in your account/);
    state.movements[0].ownerId = "fictional-other-owner";
    expect(() => projectAccountsReadView(result(state), query())).toThrow(/another owner/);
  });

  it("plans an append from every saved return reference without silently reconfirming changed evidence", () => {
    const state = fixture(41), original = state.movements[0];
    state.settlements = [{ id: "fictional-existing-loan", kind: "loan", original: { movementId: original.id, sourceFingerprint: "fictional-saved-original" },
      returns: state.movements.slice(1).map(row => ({ movementId: row.id, sourceFingerprint: `saved:${row.id}`, principalMinor: 1 })), createdAt: AT }];
    const plan = projectAccountsReadView(result(state), query({ section: "settlement-plan", movementId: original.id, kind: "loan", expectedRevision: 1, expectedSourceVersion: "fictional-version" }));
    expect(plan.page.rows).toEqual([{ existing: { id: state.settlements[0].id, kind: "loan", original: state.settlements[0].original, returns: state.settlements[0].returns }, usedPrincipalMinor: 40 }]);
    expect("existing" in plan.page.rows[0] && plan.page.rows[0].existing?.returns).toHaveLength(40);
    expect(JSON.stringify(plan)).not.toContain("sourceText");
    const fresh = projectAccountsReadView(result(state), query({ section: "settlement-plan", movementId: "fictional-new-original", kind: "loan" }));
    expect(fresh.page.rows).toEqual([{ existing: null, usedPrincipalMinor: 0 }]);
    state.settlements.push({ ...state.settlements[0], id: "fictional-conflicting-loan" });
    expect(() => projectAccountsReadView(result(state), query({ section: "settlement-plan", movementId: original.id, kind: "loan" }))).toThrow(/saved return links need review/);
  });
});

describe("Accounts read selection validation", () => {
  it("parses defaults, activity filters, target selectors and explicit null source cursors", () => {
    expect(parseAccountsReadQuery(new URLSearchParams())).toMatchObject({ currency: "GHS", section: "activity", page: 0, filters: emptyActivityFilters });
    const parsed = parseAccountsReadQuery(new URLSearchParams({ currency: "USD", section: "targets", page: "2", accountId: "fictional-cash", direction: "out", search: "fictional", filterCurrency: "GHS", category: "Fees", type: "expense", from: "2026-11-01", to: "2026-11-05", expectedRevision: "0", expectedSourceVersion: "" }));
    expect(parsed).toMatchObject({ currency: "USD", section: "targets", page: 2, accountId: "fictional-cash", direction: "out", search: "fictional", expectedRevision: 0, expectedSourceVersion: null,
      filters: { search: "fictional", currency: "GHS", category: "Fees", type: "expense", start: "2026-11-01", end: "2026-11-05" } });
    expect(projectAccountsReadView(result(emptyAccountingState(OWNER), null), parsed).sourceVersion).toBeNull();
  });
  it.each([
    { section: "unknown" }, { page: "-1" }, { page: "NaN" }, { page: "9007199254740992" }, { currency: "ghs" }, { search: "x".repeat(201) },
    { accountId: "x".repeat(201) }, { direction: "internal" }, { from: "2026-02-30" }, { from: "2026-11-05", to: "2026-11-01" },
    { status: "unknown" }, { type: "transfer" }, { sort: "unknown" }, { filterCurrency: "bad" }, { category: "x".repeat(41) },
    { expectedRevision: "1" }, { expectedSourceVersion: "fictional-only" }, { section: "evidence" }, { section: "returns" }, { section: "movement" }, { section: "similar" }, { section: "settlement-plan" }, { kind: "invalid" },
  ])("rejects invalid or unbounded selection %j", value => {
    const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
    expect(() => parseAccountsReadQuery(new URLSearchParams(entries))).toThrow(/view options/);
  });
});
