import { describe, expect, it, vi } from "vitest";

import type { InterpretRequest } from "@/lib/ai/deepseek";
import { ingestBankText } from "@/lib/bank/ingest";
import { MemoryBankStore } from "@/lib/bank/store";
import { LIMITS } from "@/lib/config";
import { MemoryLoanStore } from "@/lib/finance/loans";
import type { HandlerDeps } from "@/lib/telegram/handle-update";
import { POST } from "@/app/api/telegram/webhook/route";
import { UNLINKED_TEXT } from "@/lib/telegram/messages";
import { expense, harness, profile, runUpdate, settings, textUpdate, NOW } from "./helpers";

describe("telegram handler", () => {
  it("rejects an unauthorized user before interpretation", async () => {
    const { deps, telegram, interpret } = harness();
    const result = await runUpdate(textUpdate(1, 7, "I spent GH₵45 on lunch"), deps);
    expect(result.httpStatus).toBe(200);
    expect(telegram.sent[0]?.text).toBe(UNLINKED_TEXT);
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

  it("settles an open confirmation from a typed yes without asking the model", async () => {
    const { deps, store, telegram, interpret } = harness();
    await store.appendTransaction(expense());
    deps.interpret = async () => {
      interpret.calls += 1;
      return { type: "delete_transaction", transaction_id: null, description_query: "lunch", undo_last: false };
    };
    await runUpdate(textUpdate(40, 42, "Delete the lunch expense"), deps);
    expect(telegram.sent[0]?.buttons).toBeDefined();

    await runUpdate(textUpdate(41, 42, "Yes!"), deps);
    expect(interpret.calls).toBe(1);
    expect((await store.listTransactions("42"))[0]?.status).toBe("deleted");
    expect(telegram.sent.at(-1)?.text).toContain("Removed");
  });

  it("asks before saving a budget and saves it after Confirm", async () => {
    const { deps, store, telegram } = harness();
    deps.interpret = async () => ({ type: "set_budget", category: "food", amount: "800.00", currency: "GHS", period: null });
    await runUpdate(textUpdate(60, 42, "set a food budget of 800"), deps);
    expect(await store.listBudgets("42")).toHaveLength(0);
    expect(telegram.sent.at(-1)?.text).toContain("Set a Food budget of GH₵800.00 for October 2026?");

    await runUpdate(textUpdate(61, 42, "yes"), deps);
    const budgets = await store.listBudgets("42");
    expect(budgets).toHaveLength(1);
    expect(budgets[0]).toMatchObject({ category: "Food", amount: "800.00", period: "2026-10" });
  });
});

describe("waiting bank payments in the conversation", () => {
  const GRACE =
    "Payment received for GHS 125.00 from GRACE OPPONG Current Balance: GHS 485.00 . Available Balance: GHS 485.00. Reference: . Transaction ID: 92400000031. TRANSACTION FEE: 0.00";
  const ROSE =
    "Payment made for GHS 39.00 to ROSE ASARE Current Balance: GHS 446.00 . Available Balance: GHS 446.00. Reference: . Transaction ID: 92400000032. Fee charged: GHS0.00";

  async function withWaiting(interpret: HandlerDeps["interpret"]) {
    const bank = new MemoryBankStore();
    const loans = new MemoryLoanStore();
    const h = harness({ bank, loans, interpret });
    await ingestBankText({ bank, ledger: h.store, loans, now: NOW, createId: h.deps.createId }, profile(42), `${GRACE}\n${ROSE}`, { channel: "mac" });
    return { ...h, bank };
  }

  it("lets the main conversation label them, with the stronger model and the list in view", async () => {
    const requests: InterpretRequest[] = [];
    const { deps, telegram, bank } = await withWaiting(async (input) => {
      requests.push(input);
      return { type: "label_payments", answers: [{ items: [1], action: "category", category: "Gift", description: null }] };
    });
    await runUpdate(textUpdate(501, 42, "Grace was a gift"), deps);
    expect(requests[0].model).toBe("deepseek-v4-pro");
    expect(requests[0].waiting?.lines.join("\n")).toContain("IN GH₵125.00 from Grace Oppong");
    expect(telegram.sent.at(-1)?.text).toContain("Filed GH₵125.00 under Gift. I'll file Grace Oppong as Gift from now on.");
    expect(telegram.sent.at(-1)?.text).toContain("Last one: GH₵39.00 to Rose Asare");
    expect((await bank.listMessages("42", "needs_label")).map((item) => item.counterparty)).toEqual(["ROSE ASARE"]);
  });

  it("answers questions about them as ordinary chat", async () => {
    const { deps, telegram } = await withWaiting(async () => ({ type: "chat", message: "Grace Oppong sent you GH₵125 on Thursday. What was it for?", topic: "money" }));
    await runUpdate(textUpdate(502, 42, "who's Grace?"), deps);
    expect(telegram.sent.at(-1)?.text).toContain("Grace Oppong sent you GH₵125");
  });

  it("uses the usual model when nothing is waiting", async () => {
    const requests: InterpretRequest[] = [];
    const { deps } = harness({
      bank: new MemoryBankStore(),
      interpret: async (input) => {
        requests.push(input);
        return { type: "help" };
      },
    });
    await runUpdate(textUpdate(503, 42, "hi"), deps);
    expect(requests[0].model).toBeUndefined();
    expect(requests[0].waiting).toBeNull();
  });
});
