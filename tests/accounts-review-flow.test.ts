import { describe, expect, it, vi } from "vitest";
import { applyAccountingAction } from "@/lib/finance/accounting/reducer";
import { buildAccountingView } from "@/lib/finance/accounting/view";
import { emptyAccountingState, type AccountingAction, type AccountingState, type CashMovement } from "@/lib/finance/accounting/types";
import { canUndoReceipt, emptyActivityFilters, executeAccountReview, filterActivityMovements, groupAttention, movementDayGroups, nextReviewMovement, prepareMovementReview, prepareSimilarReview, readableMovementDay, undoAccountReceipt } from "@/app/accounts/activity-tools";

const NOW = "2026-11-05T10:00:00Z";
function row(id: string, patch: Partial<CashMovement> = {}): CashMovement { return { id, ownerId: "owner", accountId: null, direction: "out", status: "review", amountMinor: 150000, feeMinor: 1500, taxMinor: 10, currency: "GHS", date: "2026-11-01", occurredAt: "2026-11-01T06:33:00Z", description: "Sample ePayment", category: "Investments", sourceId: `source:${id}`, sourceKind: "manual", sourceFingerprint: `fp:${id}`, legacyTransactionId: null, feeTransactionId: null, legacyClassification: null, reportedBalanceMinor: 17940, ...patch }; }
function sample(): AccountingState { return { ...emptyAccountingState("owner"), accounts: [{ id: "cash", label: "Sample wallet", provider: "Sample", currency: "GHS", includeInCash: true, createdAt: NOW }], movements: [row("one"), row("two"), row("other", { description: "Other merchant" })] }; }
function transport(initial: AccountingState) {
  let state = initial, sequence = 0;
  return { get state() { return state; }, createId: () => `sample:${++sequence}`, dispatch: vi.fn(async (action: AccountingAction) => { state = applyAccountingAction(state, action, NOW); return state; }) };
}
describe("reviewed account changes", () => {
  it("protects an existing loan or refund from category changes while allowing account assignment", () => {
    for (const legacyClassification of ["loan", "refund"] as const) {
      const state = sample();
      state.movements[0] = row("one", { status: "confirmed", category: "Uncategorized", legacyClassification });
      expect(() => prepareMovementReview(state, "one", { accountId: "cash", category: "Subscriptions", status: "confirmed" })).toThrow(/existing loan or refund/);
      expect(() => prepareSimilarReview(state, ["one"], "Subscriptions")).toThrow(/protected classification/);
      const review = prepareMovementReview(state, "one", { accountId: "cash", category: "Uncategorized", status: "confirmed" });
      expect(review.commands.map(command => command.type)).toEqual(["assign_movement"]);
      const next = applyAccountingAction(state, { ...review.commands[0], expectedRevision: 0, requestId: `assign:${legacyClassification}` } as AccountingAction, NOW);
      expect(next.movements[0]).toMatchObject({ accountId: "cash", category: "Uncategorized", legacyClassification, amountMinor: 150000 });
    }
  });
  it("preserves an unchanged historical category during protected account assignment", () => {
    const state = sample(), category = "Historical category whose original name exceeds forty characters";
    state.movements[0] = row("one", { category, status: "confirmed", legacyClassification: "loan" });
    const review = prepareMovementReview(state, "one", { accountId: "cash", category, status: "confirmed" });
    expect(review.commands).toEqual([{ type: "assign_movement", movement: { movementId: "one", sourceFingerprint: "fp:one" }, accountId: "cash" }]);
    expect(review.movements[0].after.category).toBe(category);
  });
  it("advances only to another editable payment needing attention and finishes the queue", () => {
    const state = sample();
    state.movements.push(row("done", { accountId: "cash", status: "confirmed" }));
    state.transfers = [{ id: "protected", outgoing: { movementId: "two", sourceFingerprint: "fp:two" }, incoming: { movementId: "done", sourceFingerprint: "fp:done" }, createdAt: NOW }];
    expect(nextReviewMovement(state, "one")?.id).toBe("other");
    state.movements[2] = { ...state.movements[2], accountId: "cash", status: "confirmed" };
    expect(nextReviewMovement(state, "one")).toBeUndefined();
  });
  it("prepares exact account/category/status changes without changing source amounts or writing", () => {
    const state = sample(), before = structuredClone(state);
    const review = prepareMovementReview(state, "one", { accountId: "cash", category: "Rent & home", status: "confirmed" });
    expect(review.movements[0]).toMatchObject({ description: "Sample ePayment", date: "2026-11-01", amountMinor: 150000, before: { accountId: null, category: "Investments", status: "review" }, after: { accountId: "cash", category: "Rent & home", status: "confirmed" } });
    expect(review.commands.map(command => command.type)).toEqual(["assign_movement", "classify_movement"]);
    expect(state).toEqual(before);
  });
  it("executes reviewed steps with successive revisions and undoes precisely that receipt", async () => {
    const state = sample(), server = transport(state);
    const review = prepareMovementReview(state, "one", { accountId: "cash", category: "Rent & home", status: "confirmed" });
    const result = await executeAccountReview(review, state, server.dispatch, server.createId);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(server.dispatch.mock.calls.map(([action]) => action.expectedRevision)).toEqual([0, 1]);
    expect(result.state.movements[0]).toMatchObject({ accountId: "cash", category: "Rent & home", status: "confirmed", amountMinor: 150000, feeMinor: 1500, taxMinor: 10, reportedBalanceMinor: 17940 });
    expect(canUndoReceipt(server.state, result.receipt)).toBe(true);
    expect(await undoAccountReceipt(result.receipt, server.state, server.dispatch, server.createId)).toEqual({ ok: true, confirmed: 2 });
    expect(server.state.movements[0]).toMatchObject({ accountId: null, category: "Investments", status: "review", amountMinor: 150000, feeMinor: 1500, reportedBalanceMinor: 17940 });
  });
  it("refuses stale review and never calls the write transport", async () => {
    const state = sample(), review = prepareMovementReview(state, "one", { accountId: null, category: "Rent & home", status: "confirmed" }), dispatch = vi.fn();
    const result = await executeAccountReview(review, { ...state, revision: 1 }, dispatch, () => "unused");
    expect(result).toMatchObject({ ok: false, confirmed: 0 }); expect(dispatch).not.toHaveBeenCalled();
  });
  it("does not claim success from an unconfirmed or foreign response", async () => {
    const state = sample(), review = prepareSimilarReview(state, ["one", "two"], "Rent & home");
    const missing = vi.fn(async () => undefined);
    expect(await executeAccountReview(review, state, missing, () => "request")).toMatchObject({ ok: false, confirmed: 0, total: 2 });
    expect(missing).toHaveBeenCalledTimes(1);
    const foreign = vi.fn(async () => ({ ...state, ownerId: "someone-else", revision: 1 }));
    expect(await executeAccountReview(review, state, foreign, () => "request")).toMatchObject({ ok: false, confirmed: 0 });
  });
  it("stops a reviewed batch on its first failed confirmation and reports only confirmed writes", async () => {
    const state = sample(), review = prepareSimilarReview(state, ["one", "two"], "Rent & home"), server = transport(state);
    const dispatch = vi.fn(async (action: AccountingAction) => { if (action.expectedRevision === 1) throw new Error("A concurrent edit needs review."); return server.dispatch(action); });
    expect(await executeAccountReview(review, state, dispatch, server.createId)).toMatchObject({ ok: false, confirmed: 1, total: 2 });
    expect(dispatch).toHaveBeenCalledTimes(2); expect(server.state.movements[0].category).toBe("Rent & home"); expect(server.state.movements[1].category).toBe("Investments");
  });
  it("will not undo a later unrelated account change", async () => {
    const state = sample(), server = transport(state), review = prepareSimilarReview(state, ["one"], "Rent & home");
    const result = await executeAccountReview(review, state, server.dispatch, server.createId); if (!result.ok) throw new Error("Fixture failed");
    await server.dispatch({ type: "classify_movement", expectedRevision: server.state.revision, requestId: "unrelated", movement: { movementId: "other", sourceFingerprint: "fp:other" }, category: "Food", status: "confirmed" });
    expect(canUndoReceipt(server.state, result.receipt)).toBe(false);
    const dispatch = vi.fn(); expect(await undoAccountReceipt(result.receipt, server.state, dispatch, server.createId)).toMatchObject({ ok: false, confirmed: 0 }); expect(dispatch).not.toHaveBeenCalled();
  });
  it("keeps the server revision guard if another change races an undo", async () => {
    const state = sample(), server = transport(state), result = await executeAccountReview(prepareSimilarReview(state, ["one"], "Rent & home"), state, server.dispatch, server.createId); if (!result.ok) throw new Error("Fixture failed");
    const displayed = server.state;
    await server.dispatch({ type: "classify_movement", expectedRevision: displayed.revision, requestId: "racing", movement: { movementId: "other", sourceFingerprint: "fp:other" }, category: "Food", status: "confirmed" });
    expect(await undoAccountReceipt(result.receipt, displayed, server.dispatch, server.createId)).toMatchObject({ ok: false, confirmed: 0 });
    expect(server.state.movements[2].category).toBe("Food");
  });
  it("only includes explicitly selected matching payments and preserves their statuses", () => {
    const state = sample(), review = prepareSimilarReview(state, ["two"], "Rent & home");
    expect(review.movements.map(item => item.id)).toEqual(["two"]); expect(review.commands[0]).toMatchObject({ type: "classify_movement", status: "review" });
    expect(() => prepareSimilarReview(state, ["one", "other"], "Food")).toThrow(/matching merchant/);
    const changed = sample(); changed.movements[1].currency = "USD"; expect(() => prepareSimilarReview(changed, ["one", "two"], "Food")).toThrow(/matching merchant/);
    state.transfers = [{ id: "protected", outgoing: { movementId: "one", sourceFingerprint: "fp:one" }, incoming: { movementId: "other", sourceFingerprint: "fp:other" }, createdAt: NOW }];
    expect(() => prepareSimilarReview(state, ["one"], "Food")).toThrow(/protected/);
  });
});
describe("activity context and readable day groups", () => {
  it("keeps fee/tax drilldowns attached to their source payment and filters currency/date/type", () => {
    const state = sample(); state.movements = [row("payment", { status: "confirmed", accountId: "cash" }), row("usd", { status: "confirmed", currency: "USD" })];
    const report = buildAccountingView(state, "GHS").reportRows;
    const filters = { ...emptyActivityFilters, category: "Fees", type: "expense" as const, currency: "GHS", start: "2026-11-01", end: "2026-11-01" };
    expect(filterActivityMovements(state, filters, report).map(item => item.id)).toEqual(["payment"]);
    expect(filterActivityMovements(state, { ...filters, category: "Taxes" }, report).map(item => item.id)).toEqual(["payment"]);
    expect(filterActivityMovements(state, { ...filters, start: "2026-11-02" }, report)).toEqual([]);
    expect(state.movements[0].amountMinor).toBe(150000);
  });
  it("keeps search/account/status filters independent of report projections", () => {
    const state = sample(), before = structuredClone(state);
    expect(filterActivityMovements(state, { ...emptyActivityFilters, search: "  EPAYMENT ", account: "unassigned", status: "review" }, []).map(item => item.id)).toEqual(["one", "two"]);
    expect(state).toEqual(before);
  });
  it("retains fee and tax searches handed off from the projected Overview rows", () => {
    const state = sample(); state.movements = [row("payment", { status: "confirmed", accountId: "cash" }), row("other", { status: "confirmed", feeMinor: 0, taxMinor: 0 })];
    const report = buildAccountingView(state, "GHS").reportRows;
    expect(filterActivityMovements(state, { ...emptyActivityFilters, search: "fee" }, report).map(item => item.id)).toEqual(["payment"]);
    expect(filterActivityMovements(state, { ...emptyActivityFilters, search: "tax", type: "expense", category: "Taxes" }, report).map(item => item.id)).toEqual(["payment"]);
    expect(filterActivityMovements(state, { ...emptyActivityFilters, search: "Investments", category: "Fees", type: "expense" }, report)).toEqual([]);
    expect(filterActivityMovements(state, { ...emptyActivityFilters, search: "source:other" }, report).map(item => item.id)).toEqual(["other"]);
  });
  it("groups only exact matching descriptions, accounts, currency and direction", () => {
    const state = sample(); state.movements.push(row("assigned", { accountId: "cash" }), row("incoming", { direction: "in" }));
    expect(groupAttention(state.movements).map(group => group.rows.length)).toEqual([2, 1, 1, 1]);
  });
  it("groups consecutive days without changing an amount-sorted order or inventing timestamps", () => {
    const rows = [row("a"), row("b", { date: "2026-11-02" }), row("c")];
    expect(movementDayGroups(rows).flatMap(([, items]) => items.map(item => item.id))).toEqual(["a", "b", "c"]);
    expect(movementDayGroups(rows)).toHaveLength(3); expect(readableMovementDay("2026-11-01")).toBe("1 Nov 2026"); expect(readableMovementDay("Unknown date")).toBe("Unknown date");
  });
});
