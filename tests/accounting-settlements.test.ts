import { describe, expect, it } from "vitest";
import {
  applySettlementAction,
  settlementEffects,
  validateSettlements,
} from "@/lib/finance/accounting/settlements";
import {
  AccountingError,
  emptyAccountingState,
  type AccountingAction,
  type AccountingState,
  type CashMovement,
  type SettlementLink,
} from "@/lib/finance/accounting/types";

const NOW = "2026-11-02T10:00:00.000Z";
function movement(id: string, changes: Partial<CashMovement> = {}): CashMovement {
  return {
    id, ownerId: "owner", accountId: null, direction: "in", status: "confirmed",
    amountMinor: 4_000, feeMinor: 0, currency: "GHS", date: "2026-11-01",
    occurredAt: "2026-11-01T11:00:00.000Z", description: id, category: "Other",
    sourceId: `source-${id}`, sourceKind: "bank", sourceFingerprint: `hash-${id}`,
    legacyTransactionId: null, feeTransactionId: null, legacyClassification: null,
    ...changes,
  };
}
function fixture(): AccountingState {
  return {
    ...emptyAccountingState("owner"),
    movements: [
      movement("purchase", {
        direction: "out", amountMinor: 10_000, feeMinor: 150,
        date: "2026-10-15", occurredAt: "2026-10-15T12:00:00.000Z",
      }),
      movement("return", { feeMinor: 20 }),
      movement("second", { amountMinor: 7_000 }),
    ],
  };
}
function link(changes: Partial<SettlementLink> = {}): SettlementLink {
  return {
    id: "settlement", kind: "refund",
    original: { movementId: "purchase", sourceFingerprint: "hash-purchase" },
    returns: [{ movementId: "return", sourceFingerprint: "hash-return", principalMinor: 4_000 }],
    createdAt: NOW,
    ...changes,
  };
}
function command(settlement = link()): AccountingAction {
  return { type: "save_settlement", settlement, expectedRevision: 0, requestId: "request" };
}
function expectInvalid(state: AccountingState, settlement: SettlementLink, code?: AccountingError["code"]) {
  expect(() => applySettlementAction(state, command(settlement), NOW)).toThrow(AccountingError);
  try {
    applySettlementAction(state, command(settlement), NOW);
  } catch (error) {
    if (code) expect((error as AccountingError).code).toBe(code);
  }
}

describe("linked refunds and loan repayments", () => {
  it("restates a partial refund on the original purchase date, without rewriting cash evidence or fees", () => {
    const state = fixture();
    const original = structuredClone(state);
    const saved = applySettlementAction(state, command(), NOW);
    const effects = settlementEffects(saved);
    expect(effects.get("purchase")).toMatchObject({
      role: "original", kind: "refund", originalDate: "2026-10-15",
      spendingOffsetMinor: 4_000, principalMinor: 10_000, returnedMinor: 4_000,
      outstandingMinor: 6_000, receivedOffsetMinor: 0,
    });
    expect(effects.get("return")).toMatchObject({ receivedOffsetMinor: 4_000, extraIncomeMinor: 0 });
    expect(saved.movements).toBe(state.movements);
    expect(saved.snapshots).toBe(state.snapshots);
    expect(state).toEqual(original);
    expect(saved.movements[0].feeMinor).toBe(150);
    expect(saved.movements[1].feeMinor).toBe(20);
    expect(saved.revision).toBe(0); // Parent reducer alone controls revision/audit.
  });

  it("excludes the full loan principal from spending and only allocated repayments from income", () => {
    const state = applySettlementAction(fixture(), command(link({ kind: "loan", returns: [] })), NOW);
    expect(settlementEffects(state).get("purchase")).toMatchObject({
      spendingOffsetMinor: 10_000, outstandingMinor: 10_000, returnedMinor: 0,
    });
    const repaid = applySettlementAction(state, command(link({
      kind: "loan",
      returns: [{ movementId: "second", sourceFingerprint: "hash-second", principalMinor: 6_000 }],
    })), NOW);
    expect(settlementEffects(repaid).get("purchase")).toMatchObject({
      spendingOffsetMinor: 10_000, outstandingMinor: 4_000, returnedMinor: 6_000,
    });
    expect(settlementEffects(repaid).get("second")).toMatchObject({
      receivedOffsetMinor: 6_000, extraIncomeMinor: 1_000, principalMinor: 6_000,
    });
  });

  it("allows partial returns to be updated without self-conflict and preserves creation time", () => {
    const saved = applySettlementAction(fixture(), command(), NOW);
    const updated = applySettlementAction(saved, command(link({ returns: [
      { movementId: "return", sourceFingerprint: "hash-return", principalMinor: 3_000 },
      { movementId: "second", sourceFingerprint: "hash-second", principalMinor: 7_000 },
    ] })), "2026-11-03T10:00:00Z");
    expect(updated.settlements[0].createdAt).toBe(NOW);
    expect(settlementEffects(updated).get("purchase")?.outstandingMinor).toBe(0);
    expect(settlementEffects(updated).get("return")?.extraIncomeMinor).toBe(1_000);
    expect(saved.settlements[0].returns).toHaveLength(1);
  });

  it("requires a return for a refund, while an unpaid loan may have none", () => {
    expectInvalid(fixture(), link({ returns: [] }));
    expect(validateSettlements({ ...fixture(), settlements: [link({ kind: "loan", returns: [] })] }).valid).toHaveLength(1);
  });

  it.each([0, -1, 1.1, Number.MAX_SAFE_INTEGER + 1, 4_001])("rejects invalid return allocation %s", (principalMinor) => {
    expectInvalid(fixture(), link({ returns: [
      { movementId: "return", sourceFingerprint: "hash-return", principalMinor },
    ] }));
  });

  it("rejects aggregate over-allocation even when each return has enough capacity", () => {
    expectInvalid(fixture(), link({ returns: [
      { movementId: "return", sourceFingerprint: "hash-return", principalMinor: 4_000 },
      { movementId: "second", sourceFingerprint: "hash-second", principalMinor: 7_000 },
    ] }));
  });

  it.each(["hold", "transfer", "review", "duplicate", "excluded"] as const)("rejects %s source records", (status) => {
    const state = fixture();
    state.movements[1].status = status;
    expectInvalid(state, link());
  });

  it("requires confirmed outflow original and inflow return", () => {
    const wrongOriginal = fixture();
    wrongOriginal.movements[0].direction = "in";
    expectInvalid(wrongOriginal, link());
    const wrongReturn = fixture();
    wrongReturn.movements[1].direction = "internal";
    expectInvalid(wrongReturn, link());
  });

  it("rejects cross-owner and currency mismatches", () => {
    const owner = fixture();
    owner.movements[1].ownerId = "another-owner";
    expectInvalid(owner, link(), "ownership");
    const currency = fixture();
    currency.movements[1].currency = "USD";
    expectInvalid(currency, link());
  });

  it("invalidates stale fingerprints rather than silently matching a changed source", () => {
    const state = fixture();
    state.movements[1].sourceFingerprint = "new-fingerprint";
    expectInvalid(state, link(), "stale");
    const validation = validateSettlements({ ...state, settlements: [link()] });
    expect(validation.valid).toHaveLength(0);
    expect(validation.issues[0].code).toBe("stale");
    expect(settlementEffects({ ...state, settlements: [link()] }).size).toBe(0);
  });

  it.each(["refund", "loan"] as const)("rejects legacy %s classification until it has been undone", (legacyClassification) => {
    const state = fixture();
    state.movements[0].legacyClassification = legacyClassification;
    expectInvalid(state, link(), "conflict");
    state.movements[0].legacyClassification = null;
    state.movements[1].legacyClassification = legacyClassification;
    expectInvalid(state, link(), "conflict");
  });

  it("compares known occurrence timestamps, and uses date precision when one timestamp is unknown", () => {
    const state = fixture();
    state.movements[1].date = "2026-10-15";
    state.movements[1].occurredAt = "2026-10-15T11:59:00Z";
    expectInvalid(state, link());
    state.movements[1].occurredAt = null;
    expect(validateSettlements({ ...state, settlements: [link()] }).valid).toHaveLength(1);
    state.movements[1].date = "2026-10-14";
    expectInvalid(state, link());
  });

  it("rejects nonexistent and invalid-calendar source evidence", () => {
    const missing = link({ original: { movementId: "missing", sourceFingerprint: "hash" } });
    expectInvalid(fixture(), missing, "not_found");
    const state = fixture();
    state.movements[1].date = "2026-02-30";
    expectInvalid(state, link());
    state.movements[1].date = "2026-11-01";
    state.movements[1].occurredAt = "2026-02-30T12:00:00Z";
    expectInvalid(state, link());
  });

  it("rejects duplicate return usage, duplicate movement IDs and duplicate source identities", () => {
    const repeated = link();
    repeated.returns.push({ ...repeated.returns[0] });
    expectInvalid(fixture(), repeated, "conflict");
    const duplicateId = fixture();
    duplicateId.movements.push({ ...duplicateId.movements[1] });
    expectInvalid(duplicateId, link(), "conflict");
    const duplicateSource = fixture();
    duplicateSource.movements.push({ ...duplicateSource.movements[1], id: "copy" });
    expectInvalid(duplicateSource, link(), "conflict");
  });

  it("reserves sources globally across refund/loan links and existing transfer links", () => {
    const state = applySettlementAction(fixture(), command(), NOW);
    expectInvalid(state, link({ id: "loan", kind: "loan", returns: [] }), "conflict");
    const transfer = fixture();
    transfer.transfers = [{ id: "transfer", createdAt: NOW,
      outgoing: { movementId: "purchase", sourceFingerprint: "hash-purchase" },
      incoming: { movementId: "return", sourceFingerprint: "hash-return" } }];
    expectInvalid(transfer, link(), "conflict");
  });

  it("allows resolved duplicate aliases without allowing the alias itself to be linked", () => {
    const state = fixture();
    state.movements.push({ ...state.movements[1], id: "duplicate-alias", status: "duplicate" });
    expect(validateSettlements({ ...state, settlements: [link()] }).valid).toHaveLength(1);
    expectInvalid(state, link({ returns: [{
      movementId: "duplicate-alias", sourceFingerprint: "hash-return", principalMinor: 1_000,
    }] }));
  });

  it("fails all conflicting persisted links closed, independent of their order", () => {
    const links = [link(), link({ id: "loan", kind: "loan", returns: [] })];
    for (const settlements of [links, [...links].reverse()]) {
      const state = { ...fixture(), settlements };
      expect(validateSettlements(state).issues).toHaveLength(2);
      expect(settlementEffects(state).size).toBe(0);
    }
  });

  it("deleting a stale link restores ordinary reporting without modifying source records", () => {
    const saved = applySettlementAction(fixture(), command(), NOW);
    saved.movements[1].sourceFingerprint = "changed";
    const deleted = applySettlementAction(saved, {
      type: "delete_settlement", settlementId: "settlement", expectedRevision: 0, requestId: "delete",
    }, NOW);
    expect(deleted.settlements).toEqual([]);
    expect(settlementEffects(deleted).size).toBe(0);
    expect(deleted.movements).toBe(saved.movements);
    expect(saved.settlements).toHaveLength(1);
    expect(() => applySettlementAction(deleted, {
      type: "delete_settlement", settlementId: "settlement", expectedRevision: 0, requestId: "delete",
    }, NOW)).toThrow("Settlement not found");
  });

  it("detaches command metadata so changing a form after saving cannot mutate state", () => {
    const settlement = link();
    const saved = applySettlementAction(fixture(), command(settlement), NOW);
    settlement.original.sourceFingerprint = "changed";
    settlement.returns[0].principalMinor = 1;
    expect(saved.settlements[0].original.sourceFingerprint).toBe("hash-purchase");
    expect(saved.settlements[0].returns[0].principalMinor).toBe(4_000);
  });
});
