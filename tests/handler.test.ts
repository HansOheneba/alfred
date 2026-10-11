import { describe, expect, it, vi } from "vitest";

import { LIMITS } from "@/lib/config";
import { POST } from "@/app/api/telegram/webhook/route";
import { expense, harness, runUpdate, settings, textUpdate, NOW } from "./helpers";

describe("telegram handler", () => {
  it("rejects an unauthorized user before interpretation", async () => {
    const { deps, telegram, interpret } = harness();
    const result = await runUpdate(textUpdate(1, 7, "I spent GH₵45 on lunch"), deps);
    expect(result.httpStatus).toBe(200);
    expect(telegram.sent[0]?.text).toBe("This bot is private.");
    expect(interpret.calls).toBe(0);
  });

  it("records an explicit expense and ignores a duplicate delivery", async () => {
    const { deps, store, telegram, interpret } = harness();
    deps.interpret = async () => {
      interpret.calls += 1;
      return {
        type: "create_transaction",
        explicit: true,
        transactions: [
          {
            transaction_type: "expense",
            amount: "45.00",
            currency: "GHS",
            category: "lunch",
            description: "Lunch",
            date: "2026-10-11",
          },
        ],
      };
    };
    const update = textUpdate(20, 42, "I spent GH₵45 on lunch");
    await runUpdate(update, deps);
    await runUpdate(update, deps);
    expect(interpret.calls).toBe(1);
    const rows = await store.listTransactions("42");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.category).toBe("Food");
    expect(telegram.sent[0]?.text).toBe(
      "Recorded: GH₵45.00 — Food\nToday · Expense\n\nYour spending for the month is now GH₵45.00.",
    );
    expect(telegram.sent[1]?.text).toBe(telegram.sent[0]?.text);
  });

  it("requires confirmation before changing or deleting a transaction", async () => {
    const { deps, store, telegram } = harness({
      settings: settings({ authorizedUserIds: [42, 77] }),
    });
    await store.appendTransaction(expense());
    deps.interpret = async () => ({
      type: "delete_transaction",
      transaction_id: null,
      description_query: "lunch",
      undo_last: false,
    });
    await runUpdate(textUpdate(30, 42, "Delete the lunch expense"), deps);
    expect(await store.listTransactions("42")).toHaveLength(1);
    expect((await store.listTransactions("42"))[0]?.status).toBe("active");
    expect(telegram.sent[0]?.buttons?.[0]?.callbackData).toBe("c:actionid1234");

    await runUpdate(
      {
        update_id: 31,
        callback_query: {
          id: "cb-other",
          from: { id: 77 },
          data: "c:actionid1234",
          message: { message_id: 30, chat: { id: 100, type: "private" } },
        },
      },
      deps,
    );
    expect((await store.listTransactions("42"))[0]?.status).toBe("active");
    expect(telegram.edits.at(-1)?.text).toBe("That confirmation isn't for this chat.");

    await runUpdate(
      {
        update_id: 32,
        callback_query: {
          id: "cb-chat",
          from: { id: 42 },
          data: "c:actionid1234",
          message: { message_id: 30, chat: { id: 999, type: "private" } },
        },
      },
      deps,
    );
    expect((await store.listTransactions("42"))[0]?.status).toBe("active");

    const later = new Date(NOW.getTime() + LIMITS.pendingTtlMs + 1000);
    deps.now = () => later;
    await runUpdate(
      {
        update_id: 33,
        callback_query: {
          id: "cb-expired",
          from: { id: 42 },
          data: "c:actionid1234",
          message: { message_id: 30, chat: { id: 100, type: "private" } },
        },
      },
      deps,
    );
    expect((await store.listTransactions("42"))[0]?.status).toBe("active");
    expect(telegram.edits.at(-1)?.text).toContain("expired");
  });

  it("soft-deletes only after the owner confirms", async () => {
    const { deps, store, telegram } = harness();
    await store.appendTransaction(expense());
    deps.interpret = async () => ({
      type: "delete_transaction",
      undo_last: true,
      transaction_id: null,
      description_query: null,
    });
    await runUpdate(textUpdate(40, 42, "Undo my last expense"), deps);
    deps.now = () => new Date(NOW.getTime() + 1000);
    await runUpdate(
      {
        update_id: 41,
        callback_query: {
          id: "cb-ok",
          from: { id: 42 },
          data: "c:actionid1234",
          message: { message_id: 40, chat: { id: 100, type: "private" } },
        },
      },
      deps,
    );
    expect((await store.listTransactions("42"))[0]?.status).toBe("deleted");
    expect(telegram.edits.at(-1)?.text).toContain("Removed");
    deps.interpret = async () => ({
      type: "get_spending_summary",
      period: "this_month",
      detail: "total",
      category: "Food",
    });
    await runUpdate(textUpdate(42, 42, "How much did I spend on food this month?"), deps);
    expect(telegram.sent.at(-1)?.text).toContain("haven't recorded any Food spending");
  });
});

describe("webhook route", () => {
  it("rejects a bad secret before parsing the body", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123456:telegram-test-token";
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await POST(
      new Request("https://alfred.test/api/telegram/webhook", {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": "wrong-webhook-secret" },
        body: "{",
      }),
    );
    expect(response.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("returns 400 for invalid JSON and 413 for an oversized body", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123456:telegram-test-token";
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";
    const invalid = await POST(
      new Request("https://alfred.test/api/telegram/webhook", {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": "test-webhook-secret" },
        body: "{",
      }),
    );
    expect(invalid.status).toBe(400);
    const oversized = await POST(
      new Request("https://alfred.test/api/telegram/webhook", {
        method: "POST",
        headers: {
          "x-telegram-bot-api-secret-token": "test-webhook-secret",
          "content-length": String(LIMITS.maxBodyBytes + 1),
        },
        body: "{}",
      }),
    );
    expect(oversized.status).toBe(413);
  });

  it("ignores an update that has no message", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123456:telegram-test-token";
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";
    delete process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    delete process.env.GOOGLE_PRIVATE_KEY;
    delete process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    const response = await POST(
      new Request("https://alfred.test/api/telegram/webhook", {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": "test-webhook-secret" },
        body: JSON.stringify({ update_id: 1 }),
      }),
    );
    expect(response.status).toBe(200);
  });
});
