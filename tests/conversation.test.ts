import { MemoryMessageLog } from "@/lib/accounts/messages";
import { describe, expect, it } from "vitest";

import { handleAction } from "@/lib/finance/action-router";
import type { FinanceAction } from "@/lib/finance/schemas";
import { WELCOME_TEXT, CAPABILITY_TEXT } from "@/lib/telegram/messages";
import { AiError } from "@/lib/errors";
import { expense, harness, runUpdate, settings, textUpdate, NOW } from "./helpers";

const profile = {
  profileId: "42",
  telegramUserId: 42,
  spreadsheetId: "sheet-configured-on-the-server-001",
  currency: "GHS",
  timezone: "Africa/Accra",
  preferredName: "",
  communicationPreference: "concise" as const,
};

describe("Alfred conversation", () => {
  it("sends the short welcome from /start and does not create records", async () => {
    const { deps, store, telegram, interpret } = harness();
    await runUpdate(textUpdate(1, 42, "/start"), deps);
    await runUpdate(textUpdate(2, 42, "/help"), deps);
    for (const sent of telegram.sent) {
      expect(sent.text).toContain("Alfred. I keep track of your money from your MoMo and bank texts");
      expect(sent.text).toContain("connect your texts in Settings → Bank messages");
    }
    expect(telegram.sent).toHaveLength(2);
    expect(interpret.calls).toBe(0);
    expect(await store.listTransactions("42")).toHaveLength(0);
    expect(await store.listProcessedUpdates()).toHaveLength(0);
    expect(await store.listBudgets("42")).toHaveLength(0);
    expect(await store.listPendingActions("42")).toHaveLength(0);
  });

  it("welcomes someone saying hello for the first time", async () => {
    const { deps, telegram, interpret } = harness({ messages: new MemoryMessageLog() });
    await runUpdate(textUpdate(49, 42, "Hi"), deps);
    expect(telegram.sent[0].text).toContain("I keep track of your money");
    expect(interpret.calls).toBe(0);
  });

  it("lets Alfred answer a greeting and counts off-topic turns", async () => {
    const messages = new MemoryMessageLog();
    // Not their first message, so a greeting gets an ordinary reply rather than the welcome.
    await messages.append({ ownerId: "42", role: "assistant", body: "Filed GH₵20.00 under Food.", channel: "telegram", intent: "create_transaction" });
    const turns: number[] = [];
    const { deps, store, telegram } = harness({
      messages,
      interpret: async () => ({ type: "chat", message: "Hello.", topic: "other" }),
      voice: async (request) => {
        turns.push(request.cue?.offTopicTurn ?? 0);
        return `Reply ${["one", "two", "three", "four", "five"][turns.length - 1]}`;
      },
    });
    await runUpdate(textUpdate(50, 42, "Hi"), deps);
    await runUpdate(textUpdate(53, 42, "how's your day"), deps);
    await runUpdate(textUpdate(54, 42, "seen any good films"), deps);
    expect(turns).toEqual([1, 2, 3]);
    expect(telegram.sent.map((message) => message.text)).toEqual(["Reply one", "Reply two", "Reply three"]);
    expect(await store.listTransactions("42")).toHaveLength(0);

    deps.interpret = async () => ({ type: "get_spending_summary", period: "today", detail: "total" });
    await runUpdate(textUpdate(55, 42, "how much today"), deps);
    deps.interpret = async () => ({ type: "chat", message: "Ha.", topic: "other" });
    await runUpdate(textUpdate(56, 42, "lol"), deps);
    expect(turns.at(-1)).toBe(1);
  });

  it("answers what Alfred can do from a chat reply", async () => {
    const { deps, store, telegram } = harness();
    deps.interpret = async () => ({
      type: "chat",
      message: CAPABILITY_TEXT,
    });
    await runUpdate(textUpdate(51, 42, "So you can't do anything except money?"), deps);
    expect(telegram.sent[0]?.text).toBe(CAPABILITY_TEXT);
    expect(await store.listTransactions("42")).toHaveLength(0);
  });

  it("does not ask for an amount when a non-finance message cannot be parsed", async () => {
    const { deps, telegram } = harness();
    deps.interpret = async () => {
      throw new AiError("invalid", "bad json");
    };
    await runUpdate(textUpdate(52, 42, "So you can't do anything except money?"), deps);
    expect(telegram.sent[0]?.text).toBe(CAPABILITY_TEXT);
    expect(telegram.sent[0]?.text).not.toContain("amount");
  });

  it("asks for an amount when a transaction cannot be parsed", async () => {
    const { deps, telegram } = harness();
    deps.interpret = async () => {
      throw new AiError("invalid", "bad json");
    };
    await runUpdate(textUpdate(53, 42, "I spent something on lunch"), deps);
    expect(telegram.sent[0]?.text).toContain("amount");
  });

  it("confirms an expense from the stored total, and income without that total", async () => {
    const { deps, telegram } = harness();
    deps.interpret = async () => ({
      type: "create_transaction",
      explicit: true,
      transactions: [
        {
          transaction_type: "expense",
          amount: "200.00",
          currency: "GHS",
          category: "Food",
          description: "Food",
          date: "2026-10-10",
        },
      ],
    });
    await runUpdate(textUpdate(3, 42, "I spent 200 on food yesterday"), deps);
    expect(telegram.sent[0]?.text).toBe(
      "Recorded: GH₵200.00 — Food\nYesterday · Expense\n\nYour spending for the month is now GH₵200.00.",
    );

    deps.interpret = async () => ({
      type: "create_transaction",
      explicit: true,
      transactions: [
        {
          transaction_type: "income",
          amount: "500.00",
          currency: "GHS",
          category: "Salary",
          description: "Salary",
          date: null,
        },
      ],
    });
    await runUpdate(textUpdate(4, 42, "I received 500 salary"), deps);
    expect(telegram.sent[1]?.text).toBe("Recorded: GH₵500.00 — Salary\nIncome · Today");
  });

  it("breaks the previous period into categories instead of repeating the total", async () => {
    const { deps, store, telegram } = harness({
      settings: settings({ authorizedUserIds: [42, 77] }),
    });
    await store.appendTransaction(expense({ transactionDate: "2026-09-02", amount: "31.00", description: "Waakye", sourceUpdateId: "seed:1" }));
    await store.appendTransaction(
      expense({
        transactionId: "3f2a1c4e-1111-4111-8111-111111111112",
        transactionDate: "2026-09-03",
        amount: "20.00",
        category: "Transport",
        description: "Trotro",
        sourceUpdateId: "seed:2",
      }),
    );
    await store.appendTransaction(
      expense({
        transactionId: "3f2a1c4e-1111-4111-8111-111111111113",
        transactionDate: "2026-10-11",
        amount: "45.00",
        description: "Lunch",
        sourceUpdateId: "seed:3",
      }),
    );

    const contexts: unknown[] = [];
    deps.interpret = async (request) => {
      contexts.push(request.context ?? null);
      const total: FinanceAction = { type: "get_spending_summary", period: "this_month", detail: "total" };
      if (contexts.length === 1) return { type: "get_spending_summary", period: "last_month", detail: "total" };
      return total;
    };

    await runUpdate(textUpdate(5, 42, "How much have I spent last month?"), deps);
    await runUpdate(textUpdate(6, 42, "What else have I spent money on?"), deps);
    const total = telegram.sent[0]?.text ?? "";
    const breakdown = telegram.sent[1]?.text ?? "";
    expect(total).toBe("You've spent GH₵51.00 in September.");
    expect(breakdown).not.toBe(total);
    expect(breakdown).toContain("Food: GH₵31.00");
    expect(breakdown).toContain("Transport: GH₵20.00");
    expect(breakdown).not.toContain("45.00");
    expect(breakdown).not.toContain("You've spent GH₵51.00");
    expect(contexts[1]).toMatchObject({ rangeStart: "2026-09-01", rangeEnd: "2026-09-30" });

    await runUpdate(textUpdate(7, 77, "What else have I spent money on?"), deps);
    expect(telegram.sent[2]?.text).toBe("You haven't recorded any spending this month.");
    expect(telegram.sent[2]?.text).not.toContain("Waakye");
    expect(contexts[2]).toBeNull();
  });

  it("does not invent a category total when nothing was recorded", async () => {
    const { deps, telegram } = harness();
    deps.interpret = async () => ({
      type: "get_spending_summary",
      period: "this_month",
      detail: "total",
      category: "Transport",
    });
    await runUpdate(textUpdate(8, 42, "How much have I spent on transport this month?"), deps);
    expect(telegram.sent[0]?.text).toBe("You haven't recorded any Transport spending this month.");
    expect(telegram.sent[0]?.text).not.toMatch(/GH₵\d/);
  });

  it("names the transaction being corrected, or asks when several match", async () => {
    const { deps, store, telegram } = harness();
    await store.appendTransaction(expense());
    await store.appendTransaction(
      expense({
        transactionId: "3f2a1c4e-1111-4111-8111-111111111114",
        description: "Lunch",
        amount: "12.00",
        sourceUpdateId: "seed:4",
      }),
    );
    deps.interpret = async () => ({
      type: "correct_transaction",
      description_query: "lunch",
      changes: { amount: "55.00" },
    });
    await runUpdate(textUpdate(9, 42, "Change the lunch to 55"), deps);
    expect(telegram.sent[0]?.text).toContain("more than one match");
    expect((await store.listTransactions("42")).every((item) => item.amount !== "55.00")).toBe(true);

    const single = harness();
    await single.store.appendTransaction(expense());
    single.deps.interpret = async () => ({
      type: "correct_transaction",
      transaction_id: null,
      description_query: null,
      changes: { amount: "55.00" },
    });
    await runUpdate(textUpdate(10, 42, "I spent GH₵45 on lunch"), {
      ...single.deps,
      interpret: async () => ({
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
      }),
    });
    await runUpdate(textUpdate(11, 42, "Change it to 55"), single.deps);
    expect(single.telegram.sent.at(-1)?.text).toContain("Lunch");
    expect(single.telegram.sent.at(-1)?.text).toContain("55.00");
    expect((await single.store.listTransactions("42"))[0]?.amount).toBe("45.00");
  });

  it("does not report a failed write as recorded", async () => {
    const { deps, store, telegram } = harness();
    store.failNextTransactionAppends(1);
    deps.interpret = async () => ({
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
    });
    await runUpdate(textUpdate(12, 42, "I spent GH₵45 on lunch"), deps);
    expect(telegram.sent[0]?.text).not.toContain("Recorded");
    expect(telegram.sent[0]?.text).toContain("Nothing was saved");
    expect(await store.listTransactions("42")).toHaveLength(0);
  });

  it("states the remaining food budget from the configured amount", async () => {
    const store = (await import("@/lib/finance/memory-store")).MemoryFinanceStore;
    const memory = new store();
    await memory.appendTransaction(expense());
    await memory.saveBudget({
      budgetId: "3f2a1c4e-1111-4111-8111-111111111199",
      userId: "42",
      period: "2026-10",
      category: "Food",
      amount: "200.00",
      currency: "GHS",
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    const reply = await handleAction(
      { type: "get_budget_status", category: "Food", period: "2026-10" },
      {
        profile,
        store: memory,
        now: NOW,
        updateId: 13,
        chatId: 100,
        confirmTransactions: "auto",
        pendingTtlMs: 60_000,
        createId: () => "3f2a1c4e-1111-4111-8111-111111111200",
        createActionId: () => "actionid1234",
      },
    );
    expect(reply.kind === "text" ? reply.text : "").toBe("You have GH₵155.00 left in your Food budget for this month.");

    const missing = await handleAction(
      { type: "get_budget_status", category: "Transport" },
      {
        profile,
        store: memory,
        now: NOW,
        updateId: 14,
        chatId: 100,
        confirmTransactions: "auto",
        pendingTtlMs: 60_000,
        createId: () => "3f2a1c4e-1111-4111-8111-111111111201",
        createActionId: () => "actionid1234",
      },
    );
    expect(missing.kind === "text" ? missing.text : "").toBe("There's no Transport budget set for this month.");
  });

  it("answers what the current month was spent on with categories", async () => {
    const { deps, store, telegram } = harness();
    await store.appendTransaction(expense());
    await store.appendTransaction(
      expense({
        transactionId: "3f2a1c4e-1111-4111-8111-111111111130",
        amount: "20.00",
        category: "Transport",
        description: "Trotro",
        sourceUpdateId: "seed:month-transport",
      }),
    );
    deps.interpret = async () => ({ type: "get_spending_summary", period: "this_month", detail: "total" });
    await runUpdate(textUpdate(21, 42, "How much have I spent this month?"), deps);
    await runUpdate(textUpdate(22, 42, "What have I spent it on?"), deps);
    expect(telegram.sent[0]?.text).toBe("You've spent GH₵65.00 this month.");
    expect(telegram.sent[1]?.text).toContain("Food: GH₵45.00");
    expect(telegram.sent[1]?.text).toContain("Transport: GH₵20.00");
    expect(telegram.sent[1]?.text).not.toBe(telegram.sent[0]?.text);
  });

  it("says when only one category was recorded", async () => {
    const { deps, store, telegram } = harness();
    await store.appendTransaction(expense());
    deps.interpret = async () => ({ type: "get_spending_summary", period: "this_month", detail: "total" });
    await runUpdate(textUpdate(23, 42, "How much have I spent this month?"), deps);
    await runUpdate(textUpdate(24, 42, "What have I spent it on?"), deps);
    expect(telegram.sent[1]?.text).toContain("All recorded spending this month is Food: GH₵45.00.");
    expect(telegram.sent[1]?.text).toContain("Nothing else is recorded.");
    expect(telegram.sent[1]?.text).toContain("Lunch");
    expect(telegram.sent[1]?.text).not.toContain("Transport");
  });
});
