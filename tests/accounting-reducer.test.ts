import { describe, expect, it } from "vitest";
import { applyAccountingAction, stableJson } from "@/lib/finance/accounting/reducer";
import { emptyAccountingState, type AccountingAction, type AccountingState, type CashMovement } from "@/lib/finance/accounting/types";

const NOW = "2026-10-24T12:00:00Z";
const account = { id: "cash", label: "Cash", provider: "Wallet", currency: "GHS", includeInCash: true, createdAt: NOW };
const source = (id = "source"): CashMovement => ({ id, ownerId: "owner", accountId: null, direction: "out", status: "review", sourceStatus: "review", amountMinor: 10000, feeMinor: 100, currency: "GHS", date: "2026-10-24", occurredAt: NOW, description: "Synthetic payment", category: "Uncategorized", sourceId: `raw:${id}`, sourceKind: "bank", sourceFingerprint: `fp:${id}`, legacyTransactionId: null, feeTransactionId: null, legacyClassification: null, reportedBalanceMinor: 42000, sourceText: "Synthetic source evidence" });
const state = (): AccountingState => ({ ...emptyAccountingState("owner"), accounts: [account], movements: [source()] });
const classify: AccountingAction = { type: "classify_movement", expectedRevision: 0, requestId: "confirm:1", movement: { movementId: "source", sourceFingerprint: "fp:source" }, status: "confirmed", category: "Food" };

describe("shared accounting revision and audit reducer", () => {
  it("records a mutation, its full before state, and an independent snapshot without changing the caller", () => {
    const original = state();
    const next = applyAccountingAction(original, classify, NOW);
    expect(next.revision).toBe(1);
    expect(next.audit).toHaveLength(1);
    expect(next.audit[0]).toMatchObject({ requestId: "confirm:1", action: "classify_movement", revision: 1, at: NOW });
    expect(next.audit[0].before.movements[0]).toMatchObject({ status: "review", category: "Uncategorized" });
    expect(original.movements[0].status).toBe("review");
    next.audit[0].before.movements[0].description = "tampered local object";
    expect(original.movements[0].description).toBe("Synthetic payment");
  });
  it("returns the same state on exact request retry despite its now-stale expected revision", () => {
    const next = applyAccountingAction(state(), classify, NOW);
    expect(applyAccountingAction(next, { ...classify }, "2026-10-24T13:00:00Z")).toBe(next);
    expect(next.audit).toHaveLength(1);
  });
  it("rejects request-ID reuse for changed content and stale concurrent edits", () => {
    const next = applyAccountingAction(state(), classify, NOW);
    expect(() => applyAccountingAction(next, { ...classify, category: "Travel" }, NOW)).toThrow(/request ID/);
    expect(() => applyAccountingAction(next, { ...classify, requestId: "concurrent", category: "Travel" }, NOW)).toThrow(/changed/);
    expect(next.movements[0].category).toBe("Food");
  });
  it("canonicalizes object property order in idempotent commands", () => {
    expect(stableJson({ b: 2, a: { z: 1, y: "value" } })).toBe(stableJson({ a: { y: "value", z: 1 }, b: 2 }));
  });
  it("undo restores editable fields but retains raw source facts and newly imported evidence", () => {
    const confirmed = applyAccountingAction(state(), classify, NOW);
    const newlyImported = source("new-import");
    confirmed.movements.push(newlyImported);
    const undone = applyAccountingAction(confirmed, { type: "undo", requestId: "undo:1", expectedRevision: 1 }, NOW);
    expect(undone.revision).toBe(2);
    expect(undone.movements[0]).toEqual(source());
    expect(undone.movements[1]).toEqual(newlyImported);
    expect(undone.audit.map((row) => row.action)).toEqual(["classify_movement", "undo"]);
  });
  it("will not undo over changed source evidence", () => {
    const confirmed = applyAccountingAction(state(), classify, NOW);
    confirmed.movements[0] = { ...confirmed.movements[0], sourceFingerprint: "new-source-fingerprint", amountMinor: 15000 };
    expect(() => applyAccountingAction(confirmed, { type: "undo", requestId: "undo:stale", expectedRevision: 1 }, NOW)).toThrow(/Source evidence changed/);
    expect(confirmed.movements[0].amountMinor).toBe(15000);
    expect(confirmed.revision).toBe(1);
  });
  it("undoes successive actions in order, never toggling an undo into a redo", () => {
    const first=applyAccountingAction(state(),classify,NOW);
    const second=applyAccountingAction(first,{...classify,requestId:"confirm:2",expectedRevision:1,category:"Travel"},NOW);
    const once=applyAccountingAction(second,{type:"undo",requestId:"undo:first",expectedRevision:2},NOW);
    expect(once.movements[0].category).toBe("Food");
    const twice=applyAccountingAction(once,{type:"undo",requestId:"undo:second",expectedRevision:3},NOW);
    expect(twice.movements[0]).toMatchObject({status:"review",category:"Uncategorized"});
    expect(() => applyAccountingAction(twice,{type:"undo",requestId:"undo:none-left",expectedRevision:4},NOW)).toThrow(/no financial change/);
  });
  it("retains immutable source snapshot evidence after undoing its account assignment", () => {
    const assigned = applyAccountingAction(state(), { type: "assign_movement", expectedRevision: 0, requestId: "assign", movement: { movementId: "source", sourceFingerprint: "fp:source" }, accountId: "cash" }, NOW);
    expect(assigned.snapshots).toHaveLength(1);
    const undone = applyAccountingAction(assigned, { type: "undo", requestId: "undo:assignment", expectedRevision: 1 }, NOW);
    expect(undone.movements[0].accountId).toBeNull();
    expect(undone.snapshots).toEqual(assigned.snapshots);
  });
  it("requires valid revision/request keys and an existing undo action", () => {
    expect(() => applyAccountingAction(state(), { ...classify, requestId: "" }, NOW)).toThrow(/request ID/);
    expect(() => applyAccountingAction(state(), { ...classify, expectedRevision: -1 }, NOW)).toThrow(/revision/);
    expect(() => applyAccountingAction(state(), { type: "undo", expectedRevision: 0, requestId: "undo:none" }, NOW)).toThrow(/no financial change/);
  });
});
