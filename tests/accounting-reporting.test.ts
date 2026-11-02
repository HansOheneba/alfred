import { describe, expect, it } from "vitest";
import { accountingReportRows, buildAccountingView, projectAccountingTransactions } from "@/lib/finance/accounting/view";
import { applyAccountingAction } from "@/lib/finance/accounting/reducer";
import { emptyAccountingState, type AccountingState, type CashMovement } from "@/lib/finance/accounting/types";
import type { TransactionRecord } from "@/lib/finance/types";

const NOW = "2026-10-24T12:00:00Z";
const movement = (id: string, changes: Partial<CashMovement> = {}): CashMovement => ({ id, ownerId: "owner", accountId: "cash", direction: "out", status: "confirmed", sourceStatus: "confirmed", amountMinor: 10000, feeMinor: 100, currency: "GHS", date: "2026-09-20", occurredAt: "2026-09-20T12:00:00Z", description: `Synthetic ${id}`, category: "Shopping", sourceId: `source:${id}`, sourceKind: "bank", sourceFingerprint: `fp:${id}`, legacyTransactionId: `raw:${id}`, feeTransactionId: `fee:${id}`, legacyClassification: null, ...changes });
const raw = (id: string, changes: Partial<TransactionRecord> = {}): TransactionRecord => ({ transactionId: id, createdAt: NOW, transactionDate: "2026-10-24", userId: "owner", type: "expense", amount: "100.00", currency: "GHS", category: "Shopping", description: id, paymentMethod: "Cash", notes: "", status: "active", updatedAt: NOW, sourceUpdateId: id, rowNumber: 0, ...changes });
function state(movements: CashMovement[]): AccountingState {
  return { ...emptyAccountingState("owner"), accounts: [{ id: "cash", label: "Cash", provider: "Wallet", currency: "GHS", includeInCash: true, createdAt: NOW }, { id: "bank", label: "Bank", provider: "Bank", currency: "GHS", includeInCash: true, createdAt: NOW }], movements };
}
function linked(kind: "refund" | "loan", principalMinor = 4000, incomingMinor = 4500) {
  const s = state([movement("purchase"), movement("return", { direction: "in", amountMinor: incomingMinor, feeMinor: 50, date: "2026-10-24", occurredAt: NOW, category: "Other income" })]);
  return applyAccountingAction(s, { type: "save_settlement", expectedRevision: 0, requestId: `link:${kind}`, settlement: { id: `settlement:${kind}`, kind, original: { movementId: "purchase", sourceFingerprint: "fp:purchase" }, returns: [{ movementId: "return", sourceFingerprint: "fp:return", principalMinor }] } }, NOW);
}

describe("shared personal financial reporting", () => {
  it("restates a partial refund on the original purchase month, with excess incoming money remaining income", () => {
    const s = linked("refund");
    const rows = accountingReportRows(s);
    expect(rows.find((row) => row.id === "accounting:purchase")).toMatchObject({ date: "2026-09-20", type: "expense", minor: 6000 });
    expect(rows.find((row) => row.id === "accounting:return")).toMatchObject({ date: "2026-10-24", type: "income", minor: 500 });
    expect(rows.filter((row) => row.type === "expense" && row.date.startsWith("2026-10")).reduce((sum, row) => sum + row.minor, 0)).toBe(50);
    expect(s.movements[0].amountMinor).toBe(10000);
    expect(s.movements[1].amountMinor).toBe(4500);
  });
  it("excludes all linked loan principal out and allocated repayments in, while preserving excess as income", () => {
    const view = buildAccountingView(linked("loan"), "GHS");
    expect(view.reportRows.some((row) => row.id === "accounting:purchase")).toBe(false);
    expect(view.totals).toEqual({ incomeMinor: 500, spentMinor: 150 });
    expect(view.loans).toEqual([{ settlementId: "settlement:loan", originalMovementId: "purchase", description: "Synthetic purchase", currency: "GHS", principalMinor: 10000, returnedMinor: 4000, outstandingMinor: 6000 }]);
  });
  it("retains original and incoming fees for a fully refunded purchase", () => {
    const rows = accountingReportRows(linked("refund", 10000, 10000));
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => [row.category, row.minor]).sort()).toEqual([["Fees", 50], ["Fees", 100]].sort());
  });
  it("excludes paired transfer principal from income/spending while retaining both legs' fees", () => {
    const s = state([movement("out"), movement("in", { direction: "in", accountId: "bank", feeMinor: 25 })]);
    const paired = applyAccountingAction(s, { type: "pair_transfer", id: "transfer", expectedRevision: 0, requestId: "pair", outgoing: { movementId: "out", sourceFingerprint: "fp:out" }, incoming: { movementId: "in", sourceFingerprint: "fp:in" } }, NOW);
    expect(buildAccountingView(paired, "GHS").totals).toEqual({ incomeMinor: 0, spentMinor: 125 });
    expect(accountingReportRows(paired).every((row) => row.category === "Fees")).toBe(true);
  });
  it("counts recorded holds by the personal spending rule while keeping unresolved review/duplicates excluded", () => {
    const s = state([movement("hold", { status: "hold" }), movement("review", { status: "review" }), movement("duplicate", { status: "duplicate" })]);
    expect(buildAccountingView(s, "GHS").totals).toEqual({ incomeMinor: 0, spentMinor: 10100 });
  });
  it("does not treat an incoming hold as confirmed income", () => {
    const s = state([movement("incoming-hold", { status: "hold", direction: "in", feeMinor: 0 })]);
    expect(buildAccountingView(s, "GHS").totals).toEqual({ incomeMinor: 0, spentMinor: 0 });
  });
  it("does not apply stale settlement offsets and reports the issue", () => {
    const s = linked("refund");
    s.movements[1] = { ...s.movements[1], sourceFingerprint: "changed" };
    const view = buildAccountingView(s, "GHS");
    expect(view.settlementIssues).toHaveLength(1);
    expect(view.totals).toEqual({ incomeMinor: 4500, spentMinor: 10150 });
  });
  it("replaces principal and fee rows exactly once and restores pre-link reporting after undo", () => {
    const s = linked("refund");
    const input = [raw("raw:purchase"), raw("fee:purchase", { amount: "1.00", category: "Fees" }), raw("raw:return", { type: "income", amount: "45.00" }), raw("fee:return", { amount: "0.50", category: "Fees" }), raw("unrelated", { amount: "2.00" })];
    const projection = projectAccountingTransactions(input, s);
    expect(projection.map((row) => row.transactionId).sort()).toEqual(["accounting:purchase", "accounting-fee:purchase", "accounting:return", "accounting-fee:return", "unrelated"].sort());
    expect(projection.find((row) => row.transactionId === "accounting:purchase")).toMatchObject({ amount: "60.00", transactionDate: "2026-09-20", createdAt: "2026-09-20T12:00:00Z" });
    const undone = applyAccountingAction(s, { type: "undo", expectedRevision: 1, requestId: "undo:refund" }, NOW);
    const before = { ...s, ...s.audit[0].before, revision: 0, audit: [] };
    expect(projectAccountingTransactions(input, undone)).toEqual(projectAccountingTransactions(input, before));
    expect(projectAccountingTransactions(input, undone).find((row) => row.transactionId === "accounting:purchase" || row.transactionId === "raw:purchase")?.amount).toBe("100.00");
  });
  it("preserves unmanaged historical negative-expense refunds and loan classifications without double counting", () => {
    const s = state([movement("legacy-refund", { direction: "in", amountMinor: 2500, legacyClassification: "refund" }), movement("legacy-loan", { legacyClassification: "loan" })]);
    const input = [raw("raw:legacy-refund", { type: "expense", amount: "-25.00" }), raw("fee:legacy-refund", { amount: "1.00", category: "Fees" }), raw("raw:legacy-loan", { type: "expense", category: "Loans", amount: "100.00" })];
    expect(projectAccountingTransactions(input, s)).toEqual(input);
    expect(projectAccountingTransactions(input, emptyAccountingState("owner"))).toEqual(input);
  });
  it("reflects explicit exclusion in existing raw-ledger reports without mutating raw records", () => {
    const original = state([movement("exclude", { sourceStatus: "confirmed" })]);
    const excluded = applyAccountingAction(original, { type: "classify_movement", expectedRevision: 0, requestId: "exclude", movement: { movementId: "exclude", sourceFingerprint: "fp:exclude" }, status: "excluded" }, NOW);
    const input = [raw("raw:exclude"), raw("fee:exclude", { amount: "1.00", category: "Fees" })];
    const projection = projectAccountingTransactions(input, excluded);
    expect(projection).toHaveLength(0);
    expect(input).toHaveLength(2);
    expect(excluded.movements[0].feeMinor).toBe(100);
  });
});
