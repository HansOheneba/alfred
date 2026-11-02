import { describe, expect, it } from "vitest";
import { getGettingStartedState } from "@/app/components/getting-started-state";
import { buildAccountingView } from "@/lib/finance/accounting/view";
import { emptyAccountingState } from "@/lib/finance/accounting/types";
import type { Ledger } from "@/lib/web/ledger";

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
    expect(getGettingStartedState(ledger)).toMatchObject({ isEmpty: true, canShowSetup: true, completedCount: 0 });
    expect(ledger.accounting!.balances.totalMinor).toBeNull();
  });

  it("keeps partial setup progress based on saved accounts and budgets without inventing a balance", () => {
    const ledger = freshLedger();
    const state = emptyAccountingState("test-owner");
    state.accounts.push({ id: "cash", label: "Cash", provider: "Wallet", currency: "GHS", includeInCash: true, createdAt: "2026-11-02T10:00:00Z" });
    ledger.accounting!.balances = buildAccountingView(state, "GHS").balances;
    ledger.budgets.push({ budgetId: "food", period: "2026-11", category: "Food", amount: "100.00", currency: "GHS", budgetMinor: 10000, spentMinor: 0, remainingMinor: 10000 });
    expect(getGettingStartedState(ledger)).toMatchObject({ canShowSetup: true, isEmpty: false, hasAccount: true, hasBudget: true, completedCount: 2 });
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

  it("never disguises unavailable accounting or reconciliation issues as onboarding", () => {
    const unavailable = freshLedger();
    unavailable.accounting!.availability = "migration-required";
    expect(getGettingStartedState(unavailable).canShowSetup).toBe(false);
    unavailable.accounting = undefined;
    expect(getGettingStartedState(unavailable).isEmpty).toBe(false);
    const review = freshLedger();
    review.accounting!.issues.push("A saved return needs review.");
    expect(getGettingStartedState(review).canShowSetup).toBe(false);
  });
});
