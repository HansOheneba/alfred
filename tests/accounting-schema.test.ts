import { describe, expect, it } from "vitest";
import { accountingActionSchema, MAX_ACCOUNTING_COMMAND_BYTES } from "@/lib/finance/accounting/schema";
import type { AccountingAction } from "@/lib/finance/accounting/types";

const command = { expectedRevision: 2, requestId: "request-123" };
const reference = { movementId: "movement-123", sourceFingerprint: "unchanged-source-fingerprint" };
const commands: AccountingAction[] = [
  { ...command, type: "create_account", account: {
    id: "account-123", label: "Everyday cash", provider: "GCB", currency: "GHS", includeInCash: true,
  } },
  { ...command, type: "update_account", accountId: "account-123", changes: { includeInCash: false } },
  { ...command, type: "assign_movement", accountId: "account-123", movement: reference },
  { ...command, type: "classify_movement", movement: reference, status: "hold", category: "Food" },
  { ...command, type: "record_snapshot", snapshot: {
    id: "snapshot-123", accountId: "account-123", balanceMinor: -12_345,
    occurredAt: "2026-11-02T12:30:00Z", sourceId: "statement-123", sourceMovementId: null,
  } },
  { ...command, type: "pair_transfer", id: "transfer-123", outgoing: reference,
    incoming: { movementId: "movement-456", sourceFingerprint: "incoming-fingerprint" } },
  { ...command, type: "unpair_transfer", transferId: "transfer-123" },
  { ...command, type: "save_settlement", settlement: {
    id: "settlement-123", kind: "refund", original: reference,
    returns: [{ movementId: "movement-456", sourceFingerprint: "incoming-fingerprint", principalMinor: 1_000 }],
  } },
  { ...command, type: "delete_settlement", settlementId: "settlement-123" },
  { ...command, type: "undo" },
];

describe("accounting command boundary", () => {
  it.each(commands)("accepts the exact $type command and retains its source evidence", (action) => {
    expect(accountingActionSchema.parse(action)).toEqual(action);
  });

  it("rejects replacement state and caller-selected ownership on every action", () => {
    expect(accountingActionSchema.safeParse({ ...command, type: "replace_state", state: {} }).success).toBe(false);
    for (const action of commands) {
      expect(accountingActionSchema.safeParse({ ...action, ownerId: "some-other-user" }).success).toBe(false);
      expect(accountingActionSchema.safeParse({ ...action, state: { movements: [] } }).success).toBe(false);
    }
  });

  it("rejects unknown nested fields rather than stripping financial values", () => {
    const account = commands[0];
    if (account.type !== "create_account") throw new Error("fixture");
    expect(accountingActionSchema.safeParse({ ...account,
      account: { ...account.account, balanceMinor: 99_999, ownerId: "other" },
    }).success).toBe(false);
    expect(accountingActionSchema.safeParse({ ...command, type: "assign_movement", accountId: "account",
      movement: { ...reference, amountMinor: 10, ownerId: "other" },
    }).success).toBe(false);
    expect(accountingActionSchema.safeParse({ ...command, type: "save_settlement", settlement: {
      id: "settlement", kind: "loan", original: reference,
      returns: [{ ...reference, principalMinor: 1, receivedOffsetMinor: 999 }],
    } }).success).toBe(false);
  });

  it.each([-1, 0.1, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, "2", null])("rejects invalid expected revision %s", (expectedRevision) => {
    expect(accountingActionSchema.safeParse({ ...command, type: "undo", expectedRevision }).success).toBe(false);
  });

  it.each(["", " ", "x".repeat(201), 123])("rejects invalid stable IDs %s", (requestId) => {
    expect(accountingActionSchema.safeParse({ ...command, type: "undo", requestId }).success).toBe(false);
  });

  it("preserves IDs and fingerprints exactly; validation never silently trims source evidence", () => {
    const action = { ...command, type: "assign_movement", accountId: "account", movement: {
      movementId: " id-with-spaces ", sourceFingerprint: " exact-evidence ",
    } };
    expect(accountingActionSchema.parse(action)).toEqual(action);
    expect(accountingActionSchema.safeParse({ ...action, movement: {
      movementId: "movement", sourceFingerprint: "x".repeat(501),
    } }).success).toBe(false);
  });

  it.each([0, -1, 1.1, Number.MAX_SAFE_INTEGER + 1, Infinity, "1000"])("rejects invalid principal %s", (principalMinor) => {
    expect(accountingActionSchema.safeParse({ ...command, type: "save_settlement", settlement: {
      id: "settlement", kind: "refund", original: reference,
      returns: [{ ...reference, principalMinor }],
    } }).success).toBe(false);
  });

  it("limits returns to 100 and caps the complete UTF-8 command payload", () => {
    const action = { ...command, type: "save_settlement", settlement: {
      id: "settlement", kind: "loan", original: reference,
      returns: Array.from({ length: 101 }, (_, index) => ({
        movementId: `movement-${index}`, sourceFingerprint: "hash", principalMinor: 1,
      })),
    } };
    expect(accountingActionSchema.safeParse(action).success).toBe(false);
    const oversized = { ...action, settlement: { ...action.settlement,
      returns: Array.from({ length: 100 }, (_, index) => ({
        movementId: `movement-${index}`, sourceFingerprint: "💰".repeat(250), principalMinor: 1,
      })),
    } };
    expect(new TextEncoder().encode(JSON.stringify(oversized)).byteLength).toBeGreaterThan(MAX_ACCOUNTING_COMMAND_BYTES);
    const result = accountingActionSchema.safeParse(oversized);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some((issue) => issue.message.includes("64 KiB"))).toBe(true);
  });

  it("permits signed authoritative balance snapshots, while rejecting fractions and invalid timestamps", () => {
    const action = commands[4];
    if (action.type !== "record_snapshot") throw new Error("fixture");
    expect(accountingActionSchema.safeParse({ ...action, snapshot: { ...action.snapshot, balanceMinor: 0 } }).success).toBe(true);
    expect(accountingActionSchema.safeParse({ ...action, snapshot: { ...action.snapshot, balanceMinor: 1.1 } }).success).toBe(false);
    for (const occurredAt of ["2026-11-02", "2026-02-30T12:00:00Z", "2026-11-02T12:00:00"]) {
      expect(accountingActionSchema.safeParse({ ...action, snapshot: { ...action.snapshot, occurredAt } }).success).toBe(false);
    }
  });

  it("does not permit account identity/currency edits, transfer status shortcuts or empty edits", () => {
    for (const changes of [{}, { label: undefined }, { id: "new-account" }, { currency: "USD" }, { ownerId: "other" }]) {
      expect(accountingActionSchema.safeParse({ ...command, type: "update_account", accountId: "account", changes }).success).toBe(false);
    }
    expect(accountingActionSchema.safeParse({ ...command, type: "classify_movement", movement: reference, status: "transfer" }).success).toBe(false);
  });

  it("bounds category/account labels and requires explicit account inclusion booleans/currency codes", () => {
    const action = commands[0];
    if (action.type !== "create_account") throw new Error("fixture");
    for (const changes of [{ label: "x".repeat(121) }, { provider: " " }, { currency: "ghs" }, { includeInCash: "true" }]) {
      expect(accountingActionSchema.safeParse({ ...action, account: { ...action.account, ...changes } }).success).toBe(false);
    }
    expect(accountingActionSchema.safeParse({ ...command, type: "classify_movement", movement: reference,
      status: "confirmed", category: "x".repeat(121),
    }).success).toBe(false);
  });
});
