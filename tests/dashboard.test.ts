import { describe, expect, it } from "vitest";

import { buildDashboard } from "@/lib/finance/dashboard";
import type { BudgetRecord, SavingsGoalRecord, TransactionRecord } from "@/lib/finance/types";
import { expense } from "./helpers";

function record(overrides: Partial<TransactionRecord> = {}): TransactionRecord {
  return { ...expense(), rowNumber: 1, ...overrides };
}

function budget(overrides: Partial<BudgetRecord> = {}): BudgetRecord {
  return {
    budgetId: "budget-1",
    userId: "42",
    period: "2026-10",
    category: "Food",
    amount: "100.00",
    currency: "GHS",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    rowNumber: 1,
    ...overrides,
  };
}

function goal(overrides: Partial<SavingsGoalRecord> = {}): SavingsGoalRecord {
  return {
    goalId: "goal-1",
    userId: "42",
    name: "Trip",
    targetAmount: "100.00",
    currentAmount: "20.00",
    currency: "GHS",
    targetDate: "2026-12-01",
    status: "active",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    rowNumber: 1,
    ...overrides,
  };
}

describe("finance dashboard", () => {
  it("breaks this month into spending, income, days, and the latest transactions", () => {
    const snapshot = buildDashboard({
      userId: "42",
      currency: "GHS",
      today: "2026-10-11",
      transactions: [
        record(),
        record({
          transactionId: "transport",
          amount: "20.00",
          category: "Transport",
          description: "Trotro",
          createdAt: "2026-10-11T13:00:00.000Z",
          sourceUpdateId: "update:2",
        }),
        record({
          transactionId: "salary",
          type: "income",
          amount: "500.00",
          category: "Salary",
          description: "Pay",
          transactionDate: "2026-10-02",
          sourceUpdateId: "update:3",
        }),
        record({
          transactionId: "deleted",
          amount: "10.00",
          status: "deleted",
          sourceUpdateId: "update:4",
        }),
        record({
          transactionId: "other-user",
          userId: "99",
          amount: "80.00",
          sourceUpdateId: "update:5",
        }),
        record({
          transactionId: "september",
          amount: "15.00",
          transactionDate: "2026-09-30",
          description: "September lunch",
          createdAt: "2026-09-30T12:00:00.000Z",
          sourceUpdateId: "update:6",
        }),
        record({
          transactionId: "dollars",
          amount: "8.00",
          currency: "USD",
          description: "Coffee",
          createdAt: "2026-10-11T14:00:00.000Z",
          sourceUpdateId: "update:7",
        }),
      ],
      budgets: [budget(), budget({ budgetId: "old", period: "2026-09", category: "Transport" })],
      goals: [goal(), goal({ goalId: "gone", name: "Old", status: "deleted" })],
    });

    expect(snapshot.monthLabel).toBe("October 2026");
    expect(snapshot.spentMinor).toBe(6500);
    expect(snapshot.incomeMinor).toBe(50000);
    expect(snapshot.netMinor).toBe(43500);
    expect(snapshot.categories.map((item) => [item.category, item.minor])).toEqual([
      ["Food", 4500],
      ["Transport", 2000],
    ]);
    expect(snapshot.categories[0]?.share).toBeCloseTo(45 / 65);
    expect(snapshot.days).toHaveLength(11);
    expect(snapshot.days[1]).toMatchObject({ date: "2026-10-02", spentMinor: 0 });
    expect(snapshot.days[10]).toMatchObject({ date: "2026-10-11", spentMinor: 6500 });
    expect(snapshot.recent.map((item) => item.transactionId)).toEqual([
      "dollars",
      "transport",
      "3f2a1c4e-1111-4111-8111-111111111111",
      "salary",
      "september",
    ]);
    expect(snapshot.budgets).toEqual([
      { category: "Food", currency: "GHS", spentMinor: 4500, budgetMinor: 10000, remainingMinor: 5500 },
    ]);
    expect(snapshot.goals).toEqual([
      { name: "Trip", currency: "GHS", currentMinor: 2000, targetMinor: 10000, status: "active" },
    ]);
    expect(snapshot.otherCurrencies).toEqual([{ currency: "USD", spentMinor: 800, incomeMinor: 0 }]);
    expect(snapshot.hasActivity).toBe(true);
  });
});
