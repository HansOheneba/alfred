import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyActivityFilters, filterActivityMovements } from "@/app/accounts/activity-tools";
import * as accounts from "@/lib/finance/accounting/accounts";
import { balanceForCurrency, buildAccountsModel, type AccountsModelEvidencePayload, type AccountsModelMovementPayload, type AccountsModelReturnPayload, type AccountsModelSettlementPayload, type AccountsModelTransferPayload } from "@/lib/finance/accounting/accounts-model";
import type { AccountingResult } from "@/lib/finance/accounting/persisted-store";
import { projectAccountsReadView } from "@/lib/finance/accounting/read-view";
import { AccountingError, emptyAccountingState, type AccountingState, type BalanceSnapshot, type CashMovement } from "@/lib/finance/accounting/types";
import { accountingReportRows } from "@/lib/finance/accounting/view";
import { accountingCpuFixture, accountingCpuVariant } from "./accounting-cpu-fixture";

const OWNER = "fictional-model-owner", AT = "2026-11-05T12:00:00.000Z";
function result(state: AccountingState, sourceVersion: string | null = "fictional-source"): AccountingResult { return { state, availability: "ready", sourceVersion, rawTransactions: [] }; }
function movement(index: number, changes: Partial<CashMovement> = {}): CashMovement {
  return { id: `fictional-movement:${index}`, ownerId: OWNER, accountId: "fictional-cash", direction: "out", status: "confirmed", amountMinor: 1000, feeMinor: 0, taxMinor: 0,
    currency: "GHS", date: "2026-11-05", occurredAt: AT, description: "Fictional payment", category: "Food", sourceCategory: "Food", sourceId: `fictional-source:${index}`, sourceKind: "manual", sourceFingerprint: `fictional-fingerprint:${index}`,
    legacyTransactionId: null, feeTransactionId: null, legacyClassification: null, sourceText: `Fictional raw evidence ${index}`, ...changes };
}
function fixture(): AccountingState {
  const state = emptyAccountingState(OWNER);
  state.accounts = ["fictional-cash", "fictional-reserve"].map(id => ({ id, label: id, provider: "Fictional", currency: "GHS", includeInCash: id === "fictional-cash", createdAt: AT }));
  state.movements = [movement(0, { direction: "out", amountMinor: 5000 }), movement(1, { accountId: "fictional-reserve", direction: "in", amountMinor: 5000 }),
    movement(2, { direction: "out", amountMinor: 10000 }), movement(3, { direction: "in", amountMinor: 3000 }), movement(4, { accountId: null, status: "review" }), movement(5, { accountId: null, status: "review" })];
  const ref = (index: number) => ({ movementId: state.movements[index].id, sourceFingerprint: state.movements[index].sourceFingerprint });
  state.transfers = [{ id: "fictional-transfer", outgoing: ref(0), incoming: ref(1), createdAt: AT }];
  state.settlements = [{ id: "fictional-refund", kind: "refund", original: ref(2), returns: [{ ...ref(3), principalMinor: 2000 }], createdAt: AT }];
  state.snapshots = [{ id: "fictional-opening", accountId: "fictional-cash", balanceMinor: 100000, occurredAt: AT, sourceId: "fictional-manual", sourceMovementId: null }];
  state.revision = 1;
  state.audit = [{ id: "fictional-audit", requestId: "fictional-request", revision: 1, at: AT, action: "update_account", actionFingerprint: "Fictional large action fingerprint", before: { accounts: state.accounts, movements: state.movements, snapshots: state.snapshots, transfers: state.transfers, settlements: state.settlements } }];
  return state;
}
afterEach(() => { vi.restoreAllMocks(); });

describe("canonical Accounts generation builder", () => {
  it("builds full facts once and matches existing DTO metadata while excluding raw evidence and audit bodies", () => {
    const state = fixture(), original = structuredClone(state), facts = vi.spyOn(accounts, "accountBalanceFacts");
    const { manifest, rows } = buildAccountsModel(result(state));
    expect(facts).toHaveBeenCalledOnce();
    for (const currency of ["GHS", "USD", "EUR"]) balanceForCurrency(manifest.accountFacts, currency);
    expect(facts).toHaveBeenCalledOnce();
    const view = projectAccountsReadView(result(state), { currency: "GHS", section: "activity", page: 0 });
    expect(manifest).toMatchObject({ kind: "accounts-model", schemaVersion: 1, ownerId: OWNER, revision: 1, sourceVersion: "fictional-source", availability: "ready",
      accounts: view.accounts, accountFacts: view.balances.accounts, counts: view.counts, attentionCounts: view.attentionCounts, attentionGroups: view.attentionGroups, audit: view.audit });
    expect(manifest.nextReviewIds).toEqual([state.movements[4].id, state.movements[5].id]);
    expect(manifest.facets).toEqual(view.facets);
    expect(JSON.stringify(manifest)).not.toContain("sourceText"); expect(JSON.stringify(manifest)).not.toContain("actionFingerprint");
    expect(JSON.stringify(rows.filter(row => row.kind !== "evidence"))).not.toContain("sourceText");
    expect(rows.filter(row => row.kind === "evidence").map(row => row.payload)).toEqual(state.movements.map(row => ({ id: row.id, sourceFingerprint: row.sourceFingerprint, sourceText: row.sourceText })));
    expect(state).toEqual(original);
    const compactRows = rows.filter(row => row.kind === "movement").sort((a, b) => a.rankDateDesc! - b.rankDateDesc!).map(row => (row.payload as AccountsModelMovementPayload).movement);
    expect(compactRows).toEqual(view.page.rows);
  });

  it("retains complete fictional source history rather than materializing a page as complete state", () => {
    const { state } = accountingCpuFixture();
    const { manifest, rows } = buildAccountsModel(result(state));
    expect(manifest.counts).toEqual({ movements: 2315, snapshots: 2277, transfers: 200, settlements: 0 });
    expect(rows).toHaveLength(7107);
    expect(rows.filter(row => row.kind === "movement")).toHaveLength(2315);
    expect(rows.filter(row => row.kind === "snapshot")).toHaveLength(2277);
    expect(rows.filter(row => row.kind === "evidence")).toHaveLength(2315);
    expect(new Set(rows.map(row => JSON.stringify([row.kind, row.id]))).size).toBe(rows.length);
    expect(rows.some(row => row.kind === "ledger")).toBe(false);
    expect(balanceForCurrency(manifest.accountFacts, "GHS")).toEqual(accounts.accountBalances(state, "GHS"));
    expect(rows.filter(row => row.kind === "movement").every(row => (row.payload as AccountsModelMovementPayload).reportMatches.length <= 3)).toBe(true);
  });

  it("preserves nullable/optional fields and detaches every exposed object from authoritative input", () => {
    const state = fixture(); delete state.movements[4].sourceText; delete state.movements[4].taxMinor;
    const built = buildAccountsModel(result(state, null));
    const compact = built.rows.find(row => row.kind === "movement" && row.id === state.movements[4].id)!.payload as AccountsModelMovementPayload;
    const evidence = built.rows.find(row => row.kind === "evidence" && row.id === state.movements[4].id)!.payload as AccountsModelEvidencePayload;
    expect(compact.movement).not.toHaveProperty("taxMinor"); expect(compact.movement.accountId).toBeNull(); expect(evidence.sourceText).toBeNull();
    expect(built.manifest.sourceVersion).toBeNull();
    built.manifest.accounts[0].label = "Changed display copy"; compact.movement.category = "Changed display category";
    const snapshot = built.rows.find(row => row.kind === "snapshot")!.payload as BalanceSnapshot; snapshot.balanceMinor = 1;
    const link = (built.rows.find(row => row.kind === "settlement")!.payload as AccountsModelSettlementPayload).link; link.returns[0].sourceFingerprint = "changed-display-reference";
    expect(state.accounts[0].label).toBe("fictional-cash"); expect(state.movements[4].category).toBe("Food");
    expect(state.snapshots[0].balanceMinor).toBe(100000); expect(state.settlements[0].returns[0].sourceFingerprint).toBe("fictional-fingerprint:3");
  });

  it("keeps saved link references and return ordinals without embedding current movements or original evidence", () => {
    const state = fixture(); state.movements[3].sourceFingerprint = "fictional-current-changed";
    const { rows } = buildAccountsModel(result(state));
    const transfer = rows.find(row => row.kind === "transfer")!;
    expect(transfer.ordinal).toBe(0); expect(transfer.payload as AccountsModelTransferPayload).toEqual({ link: state.transfers[0] });
    const settlement = rows.find(row => row.kind === "settlement")!, payload = settlement.payload as AccountsModelSettlementPayload;
    expect(settlement).toMatchObject({ ordinal: 0, relationId: state.movements[2].id, category: "refund" });
    expect(payload.link).toEqual(state.settlements[0]); expect(payload.summary).toMatchObject({ originalReference: state.settlements[0].original, returnedMinor: 2000, outstandingMinor: null, returnCount: 1, issue: expect.any(String) });
    expect(payload.summary).not.toHaveProperty("original");
    const returned = rows.find(row => row.kind === "return")!, returnPayload = returned.payload as AccountsModelReturnPayload;
    expect(returned).toMatchObject({ ordinal: 0, relationId: state.settlements[0].id, amountMinor: 2000 });
    expect(returnPayload).toEqual({ movementId: state.movements[3].id, reference: { movementId: state.movements[3].id, sourceFingerprint: "fictional-fingerprint:3" }, principalMinor: 2000 });
    expect(JSON.stringify([transfer, settlement, returned])).not.toContain("Fictional raw evidence");
  });

  it("does not turn ambiguous settlement plans into a generation-wide failure or drop their history", () => {
    const state = fixture(); state.settlements.push({ ...structuredClone(state.settlements[0]), id: "fictional-conflicting-refund" });
    const { rows } = buildAccountsModel(result(state));
    expect(rows.filter(row => row.kind === "settlement")).toHaveLength(2);
    expect(rows.filter(row => row.kind === "settlement").every(row => (row.payload as AccountsModelSettlementPayload).summary.outstandingMinor === null)).toBe(true);
    expect(rows.filter(row => row.kind === "return")).toHaveLength(2);
    expect(rows.filter(row => row.kind === "return").map(row => row.ordinal)).toEqual([0, 1]);
    expect(new Set(rows.map(row => JSON.stringify([row.kind, row.ordinal]))).size).toBe(rows.length);
    expect(new Set(rows.map(row => JSON.stringify([row.kind, row.id]))).size).toBe(rows.length);
    expect(() => projectAccountsReadView(result(state), { currency: "GHS", section: "settlement-plan", page: 0, movementId: state.movements[2].id, kind: "refund" })).toThrow(/saved return links need review/);
  });

  it("exposes only valid linked loans and preserves settlement issue order in the generation manifest", () => {
    const state = fixture();
    state.movements.push(movement(6, { direction: "out", amountMinor: 5000 }), movement(7, { direction: "in", amountMinor: 1000 }));
    state.settlements.push({ id: "fictional-loan", kind: "loan", createdAt: AT,
      original: { movementId: state.movements[6].id, sourceFingerprint: state.movements[6].sourceFingerprint },
      returns: [{ movementId: state.movements[7].id, sourceFingerprint: state.movements[7].sourceFingerprint, principalMinor: 500 }] });
    state.movements[3].sourceFingerprint = "fictional-stale-refund";
    const { manifest } = buildAccountsModel(result(state));
    expect(manifest.linkedLoans).toEqual([{ settlementId: "fictional-loan", originalMovementId: state.movements[6].id, description: state.movements[6].description,
      currency: "GHS", principalMinor: 5000, returnedMinor: 500, outstandingMinor: 4500 }]);
    expect(manifest.linkedLoanDates).toEqual({ [state.movements[6].id]: AT });
    expect(manifest.settlementIssues).toEqual(["A linked source record changed. Review it before linking again."]);
    state.movements[6].occurredAt = null;
    expect(buildAccountsModel(result(state)).manifest.linkedLoanDates).toEqual({ [state.movements[6].id]: state.movements[6].date });
  });

  it("keeps oversized saved return history visible so only its settlement plan fails closed", () => {
    const state = fixture(); state.settlements[0].returns = Array.from({ length: 101 }, () => ({ ...state.settlements[0].returns[0], principalMinor: 1 }));
    const { rows } = buildAccountsModel(result(state));
    expect(rows.filter(row => row.kind === "return")).toHaveLength(101);
    expect((rows.find(row => row.kind === "settlement")!.payload as AccountsModelSettlementPayload).summary).toMatchObject({ returnCount: 101, returnedMinor: 101, outstandingMinor: null });
    expect(() => projectAccountsReadView(result(state), { currency: "GHS", section: "settlement-plan", page: 0, movementId: state.movements[2].id, kind: "refund" })).toThrow(/saved return link needs review/);
  });
});

describe("canonical persisted filtering and ordering facts", () => {
  it("stores exact JS stable sort ranks rather than relying on database time or string collation", () => {
    const state = fixture(); state.transfers = []; state.settlements = []; state.snapshots = [];
    state.movements = [movement(0, { description: "İ 100%_Café", occurredAt: null, date: "2026-11-04", amountMinor: 200 }),
      movement(1, { occurredAt: "2026-11-05T12:00:00+01:00", amountMinor: 100 }), movement(2, { occurredAt: "2026-11-05T11:30:00Z", amountMinor: 100 }),
      movement(3, { occurredAt: AT, amountMinor: 100 }), movement(4, { occurredAt: AT, amountMinor: 200 })];
    const { rows } = buildAccountsModel(result(state)), movements = rows.filter(row => row.kind === "movement"), reports = accountingReportRows(state);
    const sorts = { "date-asc": "rankDateAsc", "date-desc": "rankDateDesc", "amount-asc": "rankAmountAsc", "amount-desc": "rankAmountDesc" } as const;
    for (const [sort, column] of Object.entries(sorts)) {
      const expected = filterActivityMovements(state, { ...emptyActivityFilters, sort: sort as keyof typeof sorts }, reports).map(row => row.id);
      expect([...movements].sort((a, b) => a[column]! - b[column]!).map(row => row.id)).toEqual(expected);
    }
    expect(movements[0].searchText).toBe(`${state.movements[0].description} ${state.movements[0].category} ${state.movements[0].sourceId}`.toLowerCase());
    expect(movements.map(row => row.ordinal)).toEqual([0, 1, 2, 3, 4]);
  });

  it("uses exact principal/fee/tax report matches, including fee-only and negative refund rows", () => {
    const state = fixture(); state.transfers = []; state.settlements = [];
    state.movements = [movement(0, { feeMinor: 25, taxMinor: 5 }), movement(1, { sourceKind: "bank", status: "review", feeMinor: 50, confirmedFeeMinor: 20, feeTransactionId: "fictional-fee" }),
      movement(2, { direction: "in", legacyClassification: "refund", category: "Refund" }), movement(3, { legacyClassification: "loan", feeMinor: 0 }), movement(4, { status: "excluded" })];
    const { rows } = buildAccountsModel(result(state)), expected = accountingReportRows(state);
    for (const row of rows.filter(row => row.kind === "movement")) {
      const payload = row.payload as AccountsModelMovementPayload;
      expect(payload.reportMatches).toEqual(expected.filter(report => report.id.replace(/^accounting(?:-fee|-tax)?:/, "") === row.id).map(report => ({ type: report.type, category: report.category, currency: report.currency, description: report.description, searchText: `${report.description} ${report.category}`.toLowerCase() })));
    }
    expect((rows.find(row => row.kind === "movement" && row.id === state.movements[0].id)!.payload as AccountsModelMovementPayload).reportMatches).toHaveLength(3);
    expect((rows.find(row => row.kind === "movement" && row.id === state.movements[1].id)!.payload as AccountsModelMovementPayload).reportMatches.map(row => row.category)).toEqual(["Fees"]);
    expect((rows.find(row => row.kind === "movement" && row.id === state.movements[3].id)!.payload as AccountsModelMovementPayload).reportMatches).toEqual([]);
  });

  it("retains stale snapshots in exact history order while cash uses only current source evidence", () => {
    const state = fixture();
    state.snapshots.push({ id: "fictional-stale", accountId: "fictional-cash", balanceMinor: 999999, occurredAt: "2026-11-06T12:00:00Z", sourceId: state.movements[0].sourceId, sourceMovementId: state.movements[0].id, sourceFingerprint: "fictional-stale" });
    state.snapshots.push({ id: "fictional-a", accountId: "fictional-cash", balanceMinor: 123, occurredAt: AT, sourceId: "manual", sourceMovementId: null });
    const { manifest, rows } = buildAccountsModel(result(state));
    const history = rows.filter(row => row.kind === "snapshot").sort((a, b) => a.rankDateDesc! - b.rankDateDesc!).map(row => row.payload);
    expect(history).toEqual(projectAccountsReadView(result(state), { currency: "GHS", section: "snapshots", page: 0 }).page.rows);
    expect(history[0]).toMatchObject({ id: "fictional-stale" });
    expect(manifest.accountFacts[0].snapshot?.id).toBe("fictional-a");
    expect(balanceForCurrency(manifest.accountFacts, "GHS").totalMinor).toBe(123);
  });

  it.each([0, 1, 2, 7, 11, 19, 31])("matches full-source canonical view facts for seeded fictional graph %s", seed => {
    const { state } = accountingCpuVariant(seed), input = result(state), { manifest, rows } = buildAccountsModel(input);
    const view = projectAccountsReadView(input, { currency: "GHS", section: "activity", page: 0 });
    expect(balanceForCurrency(manifest.accountFacts, "GHS")).toEqual(view.balances);
    expect(manifest.attentionCounts).toEqual(view.attentionCounts); expect(manifest.attentionGroups).toEqual(view.attentionGroups);
    expect(manifest.facets).toEqual(view.facets);
    expect(rows.filter(row => row.kind === "movement").sort((a, b) => a.rankDateDesc! - b.rankDateDesc!).slice(0, 25).map(row => (row.payload as AccountsModelMovementPayload).movement)).toEqual(view.page.rows);
  });
});

describe("precomputed cash currency selection", () => {
  it("preserves complete, missing, excluded and foreign-currency totals without rerunning reconciliation", () => {
    const state = fixture();
    state.accounts.push({ ...state.accounts[0], id: "fictional-usd", currency: "USD" }, { ...state.accounts[0], id: "fictional-missing" });
    state.snapshots.push({ id: "fictional-usd-opening", accountId: "fictional-usd", balanceMinor: 500, occurredAt: AT, sourceId: "manual-usd", sourceMovementId: null });
    const { manifest } = buildAccountsModel(result(state));
    expect(balanceForCurrency(manifest.accountFacts, "GHS")).toEqual(accounts.accountBalances(state, "GHS"));
    expect(balanceForCurrency(manifest.accountFacts, "GHS")).toMatchObject({ totalMinor: null, knownSubtotalMinor: 100000, count: 2, missingCount: 1, excludedCount: 2 });
    expect(balanceForCurrency(manifest.accountFacts, "USD")).toMatchObject({ totalMinor: 500, knownSubtotalMinor: 500, count: 1, missingCount: 0, excludedCount: 3 });
    expect(balanceForCurrency(manifest.accountFacts, "EUR")).toMatchObject({ totalMinor: null, knownSubtotalMinor: null, count: 0, missingCount: 0, excludedCount: 4 });
    expect(manifest.facets.currencies).toEqual(["GHS", "USD"]);
    expect(() => balanceForCurrency(manifest.accountFacts, "ghs")).toThrow(/three-letter uppercase/);
  });

  it("does not fail a generation merely because an unselected currency subtotal would overflow", () => {
    const state = emptyAccountingState(OWNER);
    state.accounts = ["a", "b"].map(id => ({ id, label: id, provider: "Fictional", currency: "GHS", includeInCash: true, createdAt: AT }));
    state.snapshots = state.accounts.map(account => ({ id: `opening:${account.id}`, accountId: account.id, balanceMinor: Number.MAX_SAFE_INTEGER, occurredAt: AT, sourceId: "manual", sourceMovementId: null }));
    const { manifest } = buildAccountsModel(result(state));
    expect(balanceForCurrency(manifest.accountFacts, "USD")).toEqual(accounts.accountBalances(state, "USD"));
    expect(() => balanceForCurrency(manifest.accountFacts, "GHS")).toThrow(/safe integer/);
    expect(() => accounts.accountBalances(state, "GHS")).toThrow(/safe integer/);
  });

  it("fails closed on foreign-owner source rows or unsafe saved return totals", () => {
    const state = fixture(); state.movements[0].ownerId = "fictional-other-owner";
    expect(() => buildAccountsModel(result(state))).toThrow(AccountingError);
    state.movements[0].ownerId = OWNER;
    state.settlements[0].returns = [{ ...state.settlements[0].returns[0], principalMinor: Number.MAX_SAFE_INTEGER }, { ...state.settlements[0].returns[0], principalMinor: Number.MAX_SAFE_INTEGER }];
    expect(() => buildAccountsModel(result(state))).toThrow(/return records could not be displayed safely/);
  });
});
