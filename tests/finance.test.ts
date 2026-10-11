import { describe, expect, it } from "vitest";

import { handleAction } from "@/lib/finance/action-router";
import { budgetMath } from "@/lib/finance/budgets";
import { MemoryFinanceStore } from "@/lib/finance/memory-store";
import { inRange, netByCurrency, totalsByCurrency } from "@/lib/finance/summaries";
import { writeTransactions } from "@/lib/finance/transactions";
import { claimUpdate, completeUpdate } from "@/lib/security/idempotency";
import { expense, NOW, settings } from "./helpers";

const profile = {
  telegramUserId: 42,
  spreadsheetId: "sheet-configured-on-the-server-001",
  currency: "GHS",
  timezone: "Africa/Accra",
};

describe("summaries and budgets", () => {
  it("excludes deleted rows and other users, and reports budget overage", async () => {
    const store = new MemoryFinanceStore();
    await store.appendTransaction(expense());
    await store.appendTransaction(
      expense({
        transactionId: "3f2a1c4e-1111-4111-8111-111111111112",
        amount: "10.00",
        status: "deleted",
        description: "Old lunch",
        sourceUpdateId: "update:2:0",
      }),
    );
    await store.appendTransaction(
      expense({
        transactionId: "3f2a1c4e-1111-4111-8111-111111111113",
        userId: "99",
        amount: "80.00",
        description: "Someone else",
        sourceUpdateId: "update:3:0",
      }),
    );
    await store.appendTransaction(
      expense({
        transactionId: "3f2a1c4e-1111-4111-8111-111111111114",
        type: "income",
        amount: "500.00",
        category: "Salary",
        description: "Pay",
        sourceUpdateId: "update:4:0",
      }),
    );
    const own = await store.listTransactions("42");
    const spent = inRange(own, {
      userId: "42",
      range: { start: "2026-10-01", end: "2026-10-31" },
      type: "expense",
      category: "Food",
    });
    expect(totalsByCurrency(spent)).toEqual([{ currency: "GHS", minor: 4500 }]);
    const budget = await store.saveBudget({
      budgetId: "3f2a1c4e-1111-4111-8111-111111111115",
      userId: "42",
      period: "2026-10",
      category: "Food",
      amount: "40.00",
      currency: "GHS",
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    const math = budgetMath(budget, own);
    expect(math.remainingMinor).toBe(-500);
    const reply = await handleAction(
      { type: "get_budget_status", category: "Food", period: "2026-10" },
      {
        profile,
        store,
        now: NOW,
        updateId: 8,
        chatId: 100,
        confirmTransactions: "auto",
        pendingTtlMs: 60_000,
        createId: () => "3f2a1c4e-1111-4111-8111-111111111116",
        createActionId: () => "actionid1234",
      },
    );
    expect(reply.kind === "text" && reply.text).toContain("GH₵5.00 over");
    expect(reply.kind === "text" && reply.text).toContain("not a bank balance");
    const income = totalsByCurrency(inRange(own, { userId: "42", range: { start: "2026-10-01", end: "2026-10-31" }, type: "income" }));
    expect(netByCurrency(income, totalsByCurrency(spent))[0]?.minor).toBe(45500);
  });
});

describe("writes", () => {
  it("reports a failed sheet write without claiming success", async () => {
    const store = new MemoryFinanceStore();
    store.failNextTransactionAppends(1);
    const result = await writeTransactions({
      store,
      userId: "42",
      drafts: [
        {
          transactionType: "expense",
          amount: "45.00",
          currency: "GHS",
          category: "Food",
          description: "Lunch",
          date: "2026-10-11",
          paymentMethod: "",
          notes: "",
        },
      ],
      sourcePrefix: "update:9",
      createId: () => "3f2a1c4e-1111-4111-8111-111111111117",
      now: NOW,
    });
    expect(result.succeeded).toHaveLength(0);
    expect(result.failed[0]?.description).toBe("Lunch");
    expect(await store.listTransactions("42")).toHaveLength(0);
  });

  it("reports a partial batch without saying every item was recorded", async () => {
    const store = new MemoryFinanceStore();
    store.failDescriptions.add("Taxi");
    const result = await writeTransactions({
      store,
      userId: "42",
      drafts: [
        {
          transactionType: "expense",
          amount: "45.00",
          currency: "GHS",
          category: "Food",
          description: "Lunch",
          date: "2026-10-11",
          paymentMethod: "",
          notes: "",
        },
        {
          transactionType: "expense",
          amount: "20.00",
          currency: "GHS",
          category: "Transport",
          description: "Taxi",
          date: "2026-10-11",
          paymentMethod: "",
          notes: "",
        },
      ],
      sourcePrefix: "update:10",
      createId: (() => {
        let n = 20;
        return () => `3f2a1c4e-1111-4111-8111-${String(n++).padStart(12, "0")}`;
      })(),
      now: NOW,
    });
    expect(result.succeeded.map((item) => item.description)).toEqual(["Lunch"]);
    expect(result.failed.map((item) => item.description)).toEqual(["Taxi"]);
    const reply = await handleAction(
      {
        type: "create_transaction",
        explicit: true,
        transactions: [
          {
            transaction_type: "expense",
            amount: "45.00",
            currency: "GHS",
            category: "Food",
            description: "Lunch",
            date: "2026-10-11",
          },
        ],
      },
      {
        profile,
        store: new MemoryFinanceStore(),
        now: NOW,
        updateId: 11,
        chatId: 100,
        confirmTransactions: "auto",
        pendingTtlMs: 60_000,
        createId: () => "3f2a1c4e-1111-4111-8111-111111111130",
        createActionId: () => "actionid1234",
      },
    );
    expect(reply).toEqual({
      kind: "text",
      text: "Logged GH₵45.00 Lunch (Food) for today.\nYou've spent GH₵45.00 so far this month.",
    });
  });
});

describe("idempotency", () => {
  it("replays a completed update and does not claim a fresh in-progress update", async () => {
    const store = new MemoryFinanceStore();
    const first = await claimUpdate(store, { updateId: 5, userId: "42", now: NOW, staleMs: 45_000 });
    expect(first.kind).toBe("claimed");
    if (first.kind !== "claimed") return;
    await completeUpdate(store, first.rowNumber, { reply: "Recorded: GH₵45.00", transactionIds: ["abc"] }, NOW);
    const second = await claimUpdate(store, { updateId: 5, userId: "42", now: NOW, staleMs: 45_000 });
    expect(second).toMatchObject({ kind: "replay", reply: "Recorded: GH₵45.00" });

    const other = new MemoryFinanceStore();
    await claimUpdate(other, { updateId: 6, userId: "42", now: NOW, staleMs: 45_000 });
    const busy = await claimUpdate(other, { updateId: 6, userId: "42", now: NOW, staleMs: 45_000 });
    expect(busy.kind).toBe("in_progress");
  });
});

describe("settings used by tests", () => {
  it("keeps the default currency on the fixture", () => {
    expect(settings().currency).toBe("GHS");
  });
});
