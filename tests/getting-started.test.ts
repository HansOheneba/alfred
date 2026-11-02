import { describe, expect, it } from "vitest";
import { getGettingStartedState } from "@/app/components/getting-started-state";
import { buildAccountingView } from "@/lib/finance/accounting/view";
import { emptyAccountingState } from "@/lib/finance/accounting/types";
import type { Ledger } from "@/lib/web/ledger";
import type { BillRecord } from "@/lib/finance/bills";

function freshLedger(): Ledger {
  const view = buildAccountingView(emptyAccountingState("test-owner"), "GHS");
  return {
    today: "2026-11-02", currency: "GHS", rows: [], budgets: [], goals: [], insights: [], owed: [], owe: [], bills: [], upcomingBills: [], renewalSuggestions: [],
    bank: { connected: false, lastUsedAt: null, lastEmptyAt: null, accountNames: [], needsLabel: [], balances: [] },
    accounting: { availability: "ready", revision: 0, balances: view.balances, loans: [], issues: [] },
  };
}

describe("first-use UI readiness", () => {
  it("offers the checklist only for an available account with no financial records", () => {
    const ledger = freshLedger();
    expect(getGettingStartedState(ledger)).toMatchObject({ isEmpty: true, canShowSetup: true, showBlockedSetup: false, completedCount: 0 });
    expect(ledger.accounting!.balances.totalMinor).toBeNull();
  });

  it("keeps partial setup progress based on saved accounts and budgets without inventing a balance", () => {
    const ledger = freshLedger();
    const state = emptyAccountingState("test-owner");
    state.accounts.push({ id: "cash", label: "Cash", provider: "Wallet", currency: "GHS", includeInCash: true, createdAt: "2026-11-02T10:00:00Z" });
    ledger.accounting!.balances = buildAccountingView(state, "GHS").balances;
    ledger.budgets.push({ budgetId: "food", period: "2026-11", category: "Food", amount: "100.00", currency: "GHS", budgetMinor: 10000, spentMinor: 0, remainingMinor: 10000 });
    expect(getGettingStartedState(ledger)).toMatchObject({ canShowSetup: true, showBlockedSetup: false, isEmpty: false, hasAccount: true, hasBudget: true, completedCount: 2 });
    expect(ledger.accounting!.balances.totalMinor).toBeNull();
  });

  it("does not mistake a quiet month or another currency for a blank account", () => {
    const ledger = freshLedger();
    ledger.rows.push({ id: "old", date: "2025-01-01", type: "expense", minor: 100, amount: "1.00", currency: "USD", category: "Food", description: "Earlier transaction", paymentMethod: "Cash" });
    expect(getGettingStartedState(ledger)).toMatchObject({ isEmpty: false, canShowSetup: false, hasTransaction: true });
  });

  it("keeps imported payments and existing goals visible before the first confirmed transaction", () => {
    const imported = freshLedger();
    imported.bank.needsLabel.push({ id: "pending", direction: "out", amount: "20.00", currency: "GHS", counterparty: "Shop", occurredAt: "2026-11-02T10:00:00Z", question: "Choose a category" });
    expect(getGettingStartedState(imported).canShowSetup).toBe(false);
    const withGoal = freshLedger();
    withGoal.goals.push({ goalId: "trip", name: "Trip", targetAmount: "100.00", currentAmount: "0.00", currency: "GHS", targetDate: "2027-01-01", status: "active" });
    expect(getGettingStartedState(withGoal).canShowSetup).toBe(false);
  });

  it("preserves the ready-only Chat flags while exposing a separate blocked-empty dashboard state", () => {
    const unavailable = freshLedger();
    unavailable.accounting!.availability = "migration-required";
    expect(getGettingStartedState(unavailable)).toMatchObject({ canShowSetup: false, isEmpty: false, showBlockedSetup: true, completedCount: 0 });
    unavailable.accounting = undefined;
    expect(getGettingStartedState(unavailable)).toMatchObject({ canShowSetup: false, isEmpty: false, showBlockedSetup: false });
    const review = freshLedger();
    review.accounting!.issues.push("A saved return needs review.");
    expect(getGettingStartedState(review)).toMatchObject({ canShowSetup: false, isEmpty: false, showBlockedSetup: false });
  });

  const bill: BillRecord = { id: "synthetic-bill", ownerId: "test-owner", name: "Fictional bill", nextDate: "2026-11-20", amount: "10.00", currency: "GHS", cadence: "monthly", active: false, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" };
  const loan = { person: "Fictional person", personKey: "fictional", currency: "GHS", lent: "10.00", repaid: "0.00", owed: "10.00", borrowed: "0.00", paidBack: "0.00", owe: "0.00", since: "2026-11-01T00:00:00Z" };
  const records: [string, (ledger: Ledger) => void][] = [
    ["an earlier transaction in another currency", (ledger) => ledger.rows.push({ id: "old-usd", date: "2024-01-01", type: "expense", minor: 100, amount: "1.00", currency: "USD", category: "Food", description: "Fictional previous expense", paymentMethod: "Cash" })],
    ["a zero-progress goal", (ledger) => ledger.goals.push({ goalId: "goal", name: "Fictional goal", targetAmount: "100.00", currentAmount: "0.00", currency: "GHS", targetDate: "2027-01-01", status: "active" })],
    ["money owed to the user", (ledger) => ledger.owed.push({ ...loan })],
    ["money owed by the user", (ledger) => ledger.owe.push({ ...loan, lent: "0.00", owed: "0.00", borrowed: "10.00", owe: "10.00" })],
    ["a bank payment needing review", (ledger) => ledger.bank.needsLabel.push({ id: "pending", direction: "out", amount: "20.00", currency: "GHS", counterparty: "Fictional shop", occurredAt: "2026-11-01T00:00:00Z", question: "Choose a category" })],
    ["a zero bank balance", (ledger) => ledger.bank.balances.push({ source: "momo", label: "Fictional wallet", balance: "0.00", at: "2025-01-01T00:00:00Z" })],
    ["a paused bill", (ledger) => ledger.bills!.push({ ...bill })],
    ["an upcoming bill", (ledger) => ledger.upcomingBills!.push({ ...bill, active: true, renewalDate: "2026-11-20" })],
    ["a renewal suggestion", (ledger) => ledger.renewalSuggestions!.push({ id: "renewal", name: "Fictional subscription", paymentCount: 3, lastDate: "2026-10-20", lastAmount: "10.00", currency: "GHS", expectedDate: "2026-11-20", cadence: "monthly", expectedAmount: "10.00", variableAmount: false, basis: "Three saved monthly payments" })],
    ["a fully repaid accounting loan", (ledger) => ledger.accounting!.loans.push({ settlementId: "settlement", originalMovementId: "payment", description: "Fictional repaid loan", currency: "GHS", principalMinor: 1000, returnedMinor: 1000, outstandingMinor: 0 })],
    ["a reconciliation issue", (ledger) => ledger.accounting!.issues.push("A saved return needs review.")],
  ];

  describe.each(["ready", "migration-required"] as const)("existing records with %s account storage", (availability) => {
    it.each(records)("retains the overview for %s", (_name, populate) => {
      const ledger = freshLedger(); ledger.accounting!.availability = availability; populate(ledger);
      const before = structuredClone(ledger);
      expect(getGettingStartedState(ledger)).toMatchObject({ canShowSetup: false, isEmpty: false, showBlockedSetup: false });
      expect(ledger).toEqual(before);
    });
  });

  it.each(["account", "budget"])("does not hide a saved %s behind a blocked-empty checklist", (kind) => {
    const ledger = freshLedger(); ledger.accounting!.availability = "migration-required";
    if (kind === "account") {
      const state = emptyAccountingState("test-owner");
      state.accounts.push({ id: "cash", label: "Fictional cash", provider: "Wallet", currency: "GHS", includeInCash: true, createdAt: "2026-11-02T10:00:00Z" });
      ledger.accounting!.balances = buildAccountingView(state, "GHS").balances;
    } else ledger.budgets.push({ budgetId: "food", period: "2025-01", category: "Food", amount: "100.00", currency: "USD", budgetMinor: 10000, spentMinor: 0, remainingMinor: 10000 });
    expect(getGettingStartedState(ledger)).toMatchObject({ canShowSetup: false, isEmpty: false, showBlockedSetup: false, completedCount: 1 });
  });

});
