import { describe, expect, it } from "vitest";
import { accountBalances, applyAccountAction, validateAccountData } from "@/lib/finance/accounting/accounts";
import { emptyAccountingState, type AccountingAction, type AccountingState, type BalanceSnapshot, type CashMovement, type FinancialAccount } from "@/lib/finance/accounting/types";

const NOW = "2026-10-24T12:00:00Z";
const account = (id: string, changes: Partial<FinancialAccount> = {}): FinancialAccount => ({ id, label: id, provider: "Same bank", currency: "GHS", includeInCash: true, createdAt: NOW, ...changes });
const movement = (id: string, changes: Partial<CashMovement> = {}): CashMovement => ({ id, ownerId: "owner-a", accountId: "checking", direction: "out", status: "confirmed", amountMinor: 1000, feeMinor: 25, currency: "GHS", date: "2026-10-22", occurredAt: "2026-10-22T12:00:00Z", description: id, category: "Food", sourceId: `source-${id}`, sourceKind: "bank", sourceFingerprint: `fingerprint-${id}`, legacyTransactionId: null, feeTransactionId: null, legacyClassification: null, ...changes });
const snapshot = (id: string, balanceMinor: number, occurredAt: string, accountId = "checking"): BalanceSnapshot => ({ id, accountId, balanceMinor, occurredAt, sourceId: id, sourceMovementId: null });
function state(changes: Partial<AccountingState> = {}): AccountingState {
  return { ...emptyAccountingState("owner-a"), accounts: [account("checking"), account("savings")], ...changes };
}
function command<T extends AccountingAction["type"]>(type: T, properties: Omit<Extract<AccountingAction, { type: T }>, "type" | "expectedRevision" | "requestId">): Extract<AccountingAction, { type: T }> {
  return { type, expectedRevision: 0, requestId: "request", ...properties } as Extract<AccountingAction, { type: T }>;
}
function pair(s: AccountingState) {
  return applyAccountAction(s, command("pair_transfer", { id: "transfer-1", outgoing: { movementId: "out", sourceFingerprint: "fingerprint-out" }, incoming: { movementId: "in", sourceFingerprint: "fingerprint-in" } }), NOW);
}
const transferState = () => state({ movements: [movement("out"), movement("in", { direction: "in", accountId: "savings", feeMinor: 5 })] });

describe("reported account balances", () => {
  it("keeps two true accounts from one provider separate, including signed balances", () => {
    const s = state({ snapshots: [snapshot("old", 9000, "2026-10-20T12:00:00Z"), snapshot("current", 10000, NOW), snapshot("saving-current", -500, NOW, "savings")] });
    const result = accountBalances(s, "GHS");
    expect(result.accounts.map((row) => row.account.id)).toEqual(["checking", "savings"]);
    expect(result.accounts[0].snapshot?.id).toBe("current");
    expect(result.totalMinor).toBe(9500);
    expect(result.count).toBe(2);
  });
  it("only sums selected same-currency reported accounts, and never substitutes zero for unknown balances", () => {
    const s = state({ accounts: [account("checking"), account("savings", { includeInCash: false }), account("usd", { currency: "USD" }), account("unknown")], snapshots: [snapshot("a", 5000, NOW), snapshot("b", 7000, NOW, "savings"), snapshot("c", 2000, NOW, "usd")] });
    expect(accountBalances(s, "GHS")).toMatchObject({ totalMinor: null, knownSubtotalMinor: 5000, count: 2, missingCount: 1, excludedCount: 2 });
    expect(accountBalances(state(), "GHS")).toMatchObject({ totalMinor: null, knownSubtotalMinor: null, count: 2, missingCount: 2, excludedCount: 0 });
    expect(accountBalances(state(), "GHS").accounts[0].reconciliation.status).toBe("unavailable");
  });
  it("never calls a known subtotal the total when another included account lacks current evidence", () => {
    const s = state({ snapshots: [snapshot("known", 5000, NOW)] });
    expect(accountBalances(s, "GHS")).toMatchObject({ totalMinor: null, knownSubtotalMinor: 5000, count: 2, missingCount: 1 });
    s.accounts[1] = { ...s.accounts[1], includeInCash: false };
    expect(accountBalances(s, "GHS")).toMatchObject({ totalMinor: 5000, knownSubtotalMinor: 5000, count: 1, missingCount: 0, excludedCount: 1 });
    s.accounts[0] = { ...s.accounts[0], includeInCash: false };
    expect(accountBalances(s, "GHS")).toMatchObject({ totalMinor: null, knownSubtotalMinor: null, count: 0, missingCount: 0, excludedCount: 2 });
  });
  it("uses append order for observations at the same instant without rewriting either snapshot", () => {
    const s = state({ snapshots: [snapshot("a", 5000, NOW), snapshot("b", 6000, NOW)] });
    expect(accountBalances(s, "GHS").accounts[0].snapshot?.id).toBe("b");
    expect(s.snapshots).toHaveLength(2);
  });
  it("reports single-snapshot reconciliation as incomplete", () => {
    expect(accountBalances(state({ snapshots: [snapshot("one", 5000, NOW)] }), "GHS").accounts[0].reconciliation).toMatchObject({ status: "incomplete", expectedMinor: null, differenceMinor: null });
  });
  it("reconciles exact time boundaries and fees while retaining transfers and excluded raw cash", () => {
    const s = state({
      snapshots: [snapshot("before", 10000, "2026-10-20T12:00:00Z"), snapshot("after", 9570, NOW)],
      movements: [
        movement("before", { occurredAt: "2026-10-20T12:00:00Z" }),
        movement("out", { amountMinor: 1000, feeMinor: 20 }),
        movement("in", { direction: "in", amountMinor: 700, feeMinor: 10, occurredAt: NOW }),
        movement("excluded", { status: "excluded", amountMinor: 100, feeMinor: 0 }),
        movement("after", { occurredAt: "2026-10-25T12:00:00Z" }),
      ],
    });
    expect(accountBalances(s, "GHS").accounts[0].reconciliation).toMatchObject({ status: "matched", expectedMinor: 9570, differenceMinor: 0 });
    expect(s.snapshots[1].balanceMinor).toBe(9570);
  });
  it("shows mismatch against the reported balance without overwriting it", () => {
    const s = state({ snapshots: [snapshot("before", 10000, "2026-10-20T12:00:00Z"), snapshot("after", 9000, NOW)], movements: [movement("out")] });
    const result = accountBalances(s, "GHS").accounts[0];
    expect(result.reconciliation).toMatchObject({ status: "mismatch", expectedMinor: 8975, differenceMinor: 25 });
    expect(result.snapshot?.balanceMinor).toBe(9000);
  });
  it.each([
    { id: "unknown-time", occurredAt: null },
    { id: "unassigned", accountId: null },
    { id: "review", status: "review" as const },
    { id: "hold", status: "hold" as const },
    { id: "unpaired-transfer", status: "transfer" as const },
  ])("does not claim reconciliation with unresolved $id evidence", (changes) => {
    const s = state({ snapshots: [snapshot("before", 10000, "2026-10-20T12:00:00Z"), snapshot("after", 8975, NOW)], movements: [movement(changes.id, changes)] });
    expect(accountBalances(s, "GHS").accounts[0].reconciliation.status).toBe("incomplete");
  });
  it("ignores explicitly resolved duplicates, but reports ambiguous duplicated source evidence", () => {
    const out = movement("out");
    const s = state({ snapshots: [snapshot("before", 10000, "2026-10-20T12:00:00Z"), snapshot("after", 8975, NOW)], movements: [out, { ...out, id: "copy", status: "duplicate" }] });
    expect(accountBalances(s, "GHS").accounts[0].reconciliation.status).toBe("matched");
    s.movements[1] = { ...s.movements[1], status: "confirmed" };
    expect(accountBalances(s, "GHS").accounts[0].reconciliation.status).toBe("incomplete");
  });
});

describe("account and source actions", () => {
  it("creates and updates metadata without merging accounts by provider", () => {
    const newAccount = { id: "another", label: "another", provider: "Same bank", currency: "GHS", includeInCash: true };
    const s = applyAccountAction(state(), command("create_account", { account: newAccount }), NOW);
    expect(s.accounts).toHaveLength(3);
    const updated = applyAccountAction(s, command("update_account", { accountId: "another", changes: { label: "Holiday", includeInCash: false } }), NOW);
    expect(updated.accounts[2]).toMatchObject({ label: "Holiday", includeInCash: false, provider: "Same bank" });
    expect(s.accounts[2].label).toBe("another");
  });
  it("preserves reported source evidence when assigning an account and creates an immutable observation", () => {
    const source = movement("pending", { accountId: null, reportedBalanceMinor: 12345, reportedBalanceBeforeMinor: 13370, sourceText: "synthetic original alert" });
    const s = state({ movements: [source] });
    const action = command("assign_movement", { movement: { movementId: source.id, sourceFingerprint: source.sourceFingerprint }, accountId: "checking" });
    const assigned = applyAccountAction(s, action, NOW);
    expect(assigned.movements[0]).toEqual({ ...source, accountId: "checking" });
    expect(assigned.snapshots[0]).toMatchObject({ balanceMinor: 12345, accountId: "checking", sourceMovementId: source.id, sourceFingerprint: source.sourceFingerprint });
    expect(applyAccountAction(assigned, action, NOW).snapshots).toHaveLength(1);
    const reassigned = applyAccountAction(assigned, { ...action, accountId: "savings" }, NOW);
    expect(reassigned.snapshots).toHaveLength(2);
    expect(accountBalances(reassigned, "GHS").accounts.map((row) => row.snapshot?.balanceMinor ?? null)).toEqual([null, 12345]);
  });
  it("retains unknown-time reported evidence without inventing a snapshot timestamp", () => {
    const source = movement("pending", { accountId: null, occurredAt: null, reportedBalanceMinor: 12345 });
    const s = applyAccountAction(state({ movements: [source] }), command("assign_movement", { movement: { movementId: source.id, sourceFingerprint: source.sourceFingerprint }, accountId: "checking" }), NOW);
    expect(s.snapshots).toHaveLength(0);
    expect(s.movements[0].reportedBalanceMinor).toBe(12345);
  });
  it("skips stale source snapshots while retaining their evidence", () => {
    const source = movement("m", { reportedBalanceMinor: 12345 });
    const s = state({ movements: [source], snapshots: [{ ...snapshot("observed", 12345, source.occurredAt!), sourceId: source.sourceId, sourceMovementId: source.id, sourceFingerprint: "old-fingerprint" }] });
    expect(accountBalances(s, "GHS").totalMinor).toBeNull();
    expect(s.snapshots).toHaveLength(1);
  });
  it("accepts exactly repeated snapshots but rejects changed historical observations", () => {
    const observed = snapshot("one", 1234, NOW);
    const s = state({ snapshots: [observed] });
    expect(applyAccountAction(s, command("record_snapshot", { snapshot: { ...observed } }), NOW)).toBe(s);
    expect(() => applyAccountAction(s, command("record_snapshot", { snapshot: { ...observed, balanceMinor: 999 } }), NOW)).toThrow(/immutable/);
  });
  it("requires source snapshot account, timestamp and reported balance to agree", () => {
    const source = movement("m", { reportedBalanceMinor: 12345 });
    const observed = { ...snapshot("observed", 12345, source.occurredAt!), sourceId: source.sourceId, sourceMovementId: source.id, sourceFingerprint: source.sourceFingerprint };
    const s = state({ movements: [source] });
    for (const change of [{ accountId: "savings" }, { balanceMinor: 777 }, { occurredAt: NOW }]) {
      expect(() => applyAccountAction(s, command("record_snapshot", { snapshot: { ...observed, ...change } }), NOW)).toThrow();
    }
  });
  it("guards ownership, source revision, currency and safe minor units", () => {
    const source = movement("m");
    expect(() => validateAccountData(state({ movements: [{ ...source, ownerId: "other" }] }))).toThrow(/owner/);
    expect(() => validateAccountData(state({ movements: [{ ...source, amountMinor: 0.5 }] }))).toThrow(/integer/);
    expect(() => validateAccountData(state({ movements: [{ ...source, amountMinor: Number.MAX_SAFE_INTEGER }] }))).toThrow(/integer/);
    expect(() => applyAccountAction(state({ movements: [source] }), command("assign_movement", { accountId: "checking", movement: { movementId: source.id, sourceFingerprint: "old" } }), NOW)).toThrow(/changed/);
    expect(() => applyAccountAction(state({ accounts: [account("usd", { currency: "USD" })], movements: [{ ...source, accountId: null }] }), command("assign_movement", { accountId: "usd", movement: { movementId: source.id, sourceFingerprint: source.sourceFingerprint } }), NOW)).toThrow(/currency/);
  });
});

describe("own account transfer links", () => {
  it("pairs exact principal, retains both fees and source evidence, and unpairs safely", () => {
    const original = transferState();
    const paired = pair(original);
    expect(paired.transfers).toHaveLength(1);
    expect(paired.movements.map((row) => [row.status, row.amountMinor, row.feeMinor])).toEqual([["transfer", 1000, 25], ["transfer", 1000, 5]]);
    expect(original.movements[0].status).toBe("confirmed");
    expect(pair(paired)).toBe(paired);
    const unpaired = applyAccountAction(paired, command("unpair_transfer", { transferId: "transfer-1" }), NOW);
    expect(unpaired.transfers).toHaveLength(0);
    expect(unpaired.movements.every((row) => row.status === "confirmed")).toBe(true);
  });
  it.each([
    { status: "review" as const }, { status: "hold" as const }, { status: "duplicate" as const },
    { direction: "out" as const }, { accountId: "checking" }, { accountId: null },
    { amountMinor: 1001 }, { currency: "USD" }, { ownerId: "other" }, { legacyClassification: "refund" as const },
  ])("rejects ambiguous or incompatible transfer input %j", (changes) => {
    const s = transferState();
    s.movements[1] = { ...s.movements[1], ...changes };
    expect(() => pair(s)).toThrow();
  });
  it("rejects stale fingerprints, existing settlements, and later edits to linked movements", () => {
    const stale = transferState();
    stale.movements[0].sourceFingerprint = "new-source";
    expect(() => pair(stale)).toThrow(/changed/);
    const s = transferState();
    s.settlements = [{ id: "refund", kind: "refund", original: { movementId: "out", sourceFingerprint: "fingerprint-out" }, returns: [], createdAt: NOW }];
    expect(() => pair(s)).toThrow(/already linked/);
    const paired = pair(transferState());
    expect(() => applyAccountAction(paired, command("classify_movement", { movement: { movementId: "out", sourceFingerprint: "fingerprint-out" }, status: "hold" }), NOW)).toThrow(/link/);
    expect(() => applyAccountAction(paired, command("assign_movement", { movement: { movementId: "out", sourceFingerprint: "fingerprint-out" }, accountId: "savings" }), NOW)).toThrow(/link/);
  });
  it("rejects repeated underlying evidence even when movement IDs and fingerprints differ", () => {
    const s = transferState();
    s.movements.push({ ...s.movements[0], id: "alias", sourceFingerprint: "other-revision" });
    expect(() => pair(s)).toThrow(/multiple active/);
    s.movements[2].status = "duplicate";
    expect(pair(s).transfers).toHaveLength(1);
  });
  it("allows removing stale transfer metadata without silently confirming changed source evidence", () => {
    const s = pair(transferState());
    s.movements[0] = { ...s.movements[0], sourceFingerprint: "changed", sourceStatus: "review" };
    const unpaired = applyAccountAction(s, command("unpair_transfer", { transferId: "transfer-1" }), NOW);
    expect(unpaired.transfers).toHaveLength(0);
    expect(unpaired.movements[0]).toMatchObject({ status: "review", sourceFingerprint: "changed", amountMinor: 1000, feeMinor: 25 });
    expect(unpaired.movements[1].status).toBe("confirmed");
    expect(s.transfers).toHaveLength(1);
  });
  it("leaves changed source transfer statuses needing review after unpairing", () => {
    const s = pair(transferState());
    s.movements[0] = { ...s.movements[0], sourceFingerprint: "changed", sourceStatus: "transfer" };
    const unpaired = applyAccountAction(s, command("unpair_transfer", { transferId: "transfer-1" }), NOW);
    expect(unpaired.movements[0].status).toBe("review");
  });
});
