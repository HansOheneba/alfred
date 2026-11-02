import { describe, expect, it } from "vitest";
import type { BankMessage } from "@/lib/bank/store";
import { accountBalances } from "@/lib/finance/accounting/accounts";
import { hydrateAccountingSources, sourceMovements } from "@/lib/finance/accounting/sources";
import { validateSettlements } from "@/lib/finance/accounting/settlements";
import { emptyAccountingState, type AccountingState } from "@/lib/finance/accounting/types";
import { projectAccountingTransactions } from "@/lib/finance/accounting/view";
import type { TransactionRecord } from "@/lib/finance/types";

const NOW = "2026-11-02T12:00:00.000Z";
function transaction(id: string, changes: Partial<TransactionRecord> = {}): TransactionRecord {
  return {
    transactionId: id, createdAt: NOW, transactionDate: "2026-11-02", userId: "owner",
    type: "expense", amount: "100.00", currency: "GHS", category: "Food", description: id,
    paymentMethod: "GCB", notes: "", status: "active", updatedAt: NOW, sourceUpdateId: id, rowNumber: 1,
    ...changes,
  };
}
function bank(id: string, changes: Partial<BankMessage> = {}): BankMessage {
  return {
    id, ownerId: "owner", source: "gcb", channel: "manual", externalId: null,
    direction: "out", kind: "payment", amount: "100.00", fee: "1.50", currency: "GHS",
    counterparty: id, balance: "900.00", occurredAt: NOW, status: "recorded",
    transactionId: null, feeTransactionId: null, askedAt: null, raw: "Synthetic bank evidence", readBy: "rules",
    ...changes,
  };
}
function assignedState(messages = [bank("bank-a")]): AccountingState {
  const source = sourceMovements("owner", [], messages);
  return {
    ...emptyAccountingState("owner"),
    accounts: [{ id: "account-a", label: "Everyday", provider: "GCB", currency: "GHS", includeInCash: true, createdAt: NOW }],
    movements: source.map((movement) => ({ ...movement, accountId: "account-a" })),
  };
}

describe("owner-scoped source ingestion and hydration", () => {
  it("never groups true accounts or assigns a financial account by provider/payment label", () => {
    const rows = sourceMovements("owner", [transaction("manual")], [bank("bank-a"), bank("bank-b")]);
    expect(rows.map((row) => row.id)).toEqual(["bank:bank-a", "bank:bank-b", "transaction:manual"]);
    expect(rows.every((row) => row.accountId === null)).toBe(true);
    expect(rows[0].sourceId).not.toBe(rows[1].sourceId);
    expect(rows[0].sourceLabel).toBe("gcb");
  });

  it("retains reported balances and source evidence for unlabeled payments, without confirming them", () => {
    const rows = sourceMovements("owner", [], [bank("pending", { status: "needs_label" })]);
    expect(rows[0]).toMatchObject({
      status: "review", sourceStatus: "review", accountId: null, reportedBalanceMinor: 90_000,
      feeMinor: 150, amountMinor: 10_000, sourceText: "Synthetic bank evidence", occurredAt: NOW,
    });
  });

  it("deduplicates bank aliases by exact linked transaction ID and retains fees only once", () => {
    const raw = [transaction("principal"), transaction("fee", { amount: "1.50", category: "Fees" })];
    const rows = sourceMovements("owner", raw, [
      bank("b", { transactionId: "principal", feeTransactionId: "fee" }),
      bank("a", { transactionId: "principal", feeTransactionId: "fee" }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: "bank:a", status: "confirmed", legacyTransactionId: "principal", feeTransactionId: "fee" });
    expect(rows[1]).toMatchObject({ id: "bank:b", status: "duplicate", legacyTransactionId: null, feeTransactionId: null });
    expect(sourceMovements("owner", raw, [
      bank("a", { transactionId: "principal", feeTransactionId: "fee" }),
      bank("b", { transactionId: "principal", feeTransactionId: "fee" }),
    ])).toEqual(rows);
  });

  it("preserves old negative-expense refunds instead of silently linking or double reversing them", () => {
    const raw = [transaction("old-refund", { amount: "-25.00" })];
    const rows = sourceMovements("owner", raw, []);
    expect(rows[0]).toMatchObject({
      direction: "in", amountMinor: 2_500, feeMinor: 0, legacyClassification: "refund", legacyTransactionId: "old-refund", occurredAt: null,
    });
    expect(projectAccountingTransactions(raw, { ...emptyAccountingState("owner"), movements: rows })).toEqual(raw);
  });

  it.each(["lent", "repaid", "borrowed", "paid_back", "loan"] as const)("preserves legacy %s labels for explicit migration/undo", (status) => {
    expect(sourceMovements("owner", [], [bank("old-loan", { status })])[0].legacyClassification).toBe("loan");
  });

  it("does not import other owners or resolve this owner's bank messages using foreign transaction details", () => {
    const rows = sourceMovements("owner", [
      transaction("foreign", { userId: "other", description: "Other owner's private description", category: "Private" }),
    ], [
      bank("mine", { transactionId: "foreign", counterparty: "My source counterparty" }),
      bank("theirs", { ownerId: "other" }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toBe("My source counterparty");
    expect(rows[0].category).toBe("Uncategorized");
    expect(JSON.stringify(rows)).not.toContain("private description");
  });

  it("retains explicit account/status/category choices only while raw source fingerprints are current", () => {
    const state = assignedState();
    state.movements[0].status = "hold";
    state.movements[0].category = "Personal override";
    const unchanged = hydrateAccountingSources(state, sourceMovements("owner", [], [bank("bank-a")]));
    expect(unchanged.movements[0]).toMatchObject({ accountId: "account-a", status: "hold", category: "Personal override" });
    const changed = hydrateAccountingSources(state, sourceMovements("owner", [], [bank("bank-a", { amount: "101.00" })]));
    expect(changed.movements[0]).toMatchObject({ accountId: "account-a", status: "confirmed", category: "Uncategorized", amountMinor: 10_100 });
    expect(changed.movements[0].sourceFingerprint).not.toBe(state.movements[0].sourceFingerprint);
  });

  it("marks fingerprint-bound settlement links stale after a raw change", () => {
    const messages = [bank("original"), bank("return", { direction: "in", amount: "30.00" })];
    const state = assignedState(messages);
    state.settlements = [{
      id: "refund", kind: "refund", createdAt: NOW,
      original: { movementId: state.movements[0].id, sourceFingerprint: state.movements[0].sourceFingerprint },
      returns: [{ movementId: state.movements[1].id, sourceFingerprint: state.movements[1].sourceFingerprint, principalMinor: 3_000 }],
    }];
    expect(validateSettlements(state).valid).toHaveLength(1);
    const fresh = sourceMovements("owner", [], [messages[0], { ...messages[1], amount: "31.00" }]);
    const changed = hydrateAccountingSources(state, fresh);
    expect(validateSettlements(changed).valid).toHaveLength(0);
    expect(validateSettlements(changed).issues[0].code).toBe("stale");
  });

  it("adds immutable authoritative snapshots only after explicit assignment, including pending records", () => {
    const messages = [bank("bank-a", { status: "needs_label" })];
    const unassigned = { ...emptyAccountingState("owner"), movements: sourceMovements("owner", [], messages) };
    expect(hydrateAccountingSources(unassigned, sourceMovements("owner", [], messages)).snapshots).toEqual([]);
    const state = assignedState(messages);
    const fresh = sourceMovements("owner", [], messages);
    const hydrated = hydrateAccountingSources(state, fresh);
    expect(hydrated.snapshots).toHaveLength(1);
    expect(hydrated.snapshots[0]).toMatchObject({
      accountId: "account-a", balanceMinor: 90_000, occurredAt: NOW,
      sourceMovementId: "bank:bank-a", sourceFingerprint: fresh[0].sourceFingerprint,
    });
    expect(accountBalances(hydrated, "GHS")).toMatchObject({ totalMinor: 90_000, count: 1 });
    expect(hydrateAccountingSources(hydrated, fresh).snapshots).toHaveLength(1);
    expect(state.snapshots).toEqual([]);
  });

  it("retains changed and removed snapshot evidence but stops stale evidence contributing to current balances", () => {
    const state = hydrateAccountingSources(assignedState(), sourceMovements("owner", [], [bank("bank-a")]));
    const oldSnapshot = structuredClone(state.snapshots[0]);
    const changed = hydrateAccountingSources(state, sourceMovements("owner", [], [bank("bank-a", { balance: "800.00" })]));
    expect(changed.snapshots).toHaveLength(2);
    expect(changed.snapshots[0]).toEqual(oldSnapshot);
    expect(accountBalances(changed, "GHS").totalMinor).toBe(80_000);
    const removed = hydrateAccountingSources(changed, []);
    expect(removed.movements[0].status).toBe("excluded");
    expect(removed.snapshots).toHaveLength(2);
    expect(accountBalances(removed, "GHS")).toMatchObject({ totalMinor: null, count: 1, missingCount: 1 });
  });

  it("drops an account assignment when fresh evidence changes currency, rather than converting or guessing", () => {
    const changed = hydrateAccountingSources(assignedState(), sourceMovements("owner", [], [bank("bank-a", { currency: "USD" })]));
    expect(changed.movements[0].accountId).toBeNull();
    expect(changed.snapshots).toEqual([]);
  });

  it("projects exact source timestamps when stable movement IDs overlap as suffixes", () => {
    const state = emptyAccountingState("owner");
    state.movements = sourceMovements("owner", [], [
      bank("a", { occurredAt: "2026-11-02T09:00:00Z" }),
      bank("bank:a", { occurredAt: "2026-11-02T10:00:00Z" }),
    ]).map((movement) => ({ ...movement, sourceStatus: "review" as const }));
    const rows = projectAccountingTransactions([], state);
    expect(rows.find((row) => row.transactionId === "accounting:bank:a")?.createdAt).toBe("2026-11-02T09:00:00Z");
    expect(rows.find((row) => row.transactionId === "accounting:bank:bank:a")?.createdAt).toBe("2026-11-02T10:00:00Z");
  });
});
