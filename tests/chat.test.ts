import { describe, expect, it } from "vitest";

import { chatDecisionSchema, chatTextSchema } from "@/lib/accounts/chat-request";
import { clientTurnUpdateId, MemoryMessageLog } from "@/lib/accounts/messages";
import { mergeThread, type ThreadMessage } from "@/lib/accounts/thread";
import { applyFollowUp } from "@/lib/finance/conversation";
import { MemoryFinanceStore } from "@/lib/finance/memory-store";
import { ALFRED_SUPABASE_HOST, ALFRED_SUPABASE_PROJECT_REF, ALFRED_SUPABASE_USER } from "@/lib/config";
import { handleProfileTurn, type StudioDeps } from "@/lib/studio/handle";
import { expense, harness, NOW, profile, runUpdate, settings, textUpdate } from "./helpers";

function webDeps(
  interpret: StudioDeps["interpret"],
  store = new MemoryFinanceStore(),
  messages = new MemoryMessageLog(),
): StudioDeps {
  const base = settings();
  let updates = 1_000;
  return {
    settings: {
      deepseek: base.deepseek!,
      google: null,
      supabase: {
        projectRef: ALFRED_SUPABASE_PROJECT_REF,
        host: ALFRED_SUPABASE_HOST,
        user: ALFRED_SUPABASE_USER,
        database: "postgres",
        password: "test-password",
      },
      authorizedUserIds: [42],
      timezone: base.timezone,
      currency: base.currency,
      confirmTransactions: "auto",
    },
    store,
    interpret,
    now: () => NOW,
    createId: () => "3f2a1c4e-2222-4222-8222-222222222222",
    createActionId: () => "actionid1234",
    nextUpdateId: () => updates++,
    messages,
  };
}

const monthContext = {
  rangeStart: "2026-10-01",
  rangeEnd: "2026-10-31",
  category: null,
  detail: "total" as const,
  summaryKind: "spending" as const,
  transactionId: null,
  pendingActionId: null,
};

function bubble(overrides: Partial<ThreadMessage> & Pick<ThreadMessage, "id" | "role" | "text">): ThreadMessage {
  return {
    channel: "web",
    createdAt: "2026-10-11T17:00:00.000Z",
    clientId: null,
    status: "sent",
    ...overrides,
  };
}

describe("web chat messages", () => {
  it("stores one user message and one reply when the same submission is sent twice", async () => {
    const messages = new MemoryMessageLog();
    const store = new MemoryFinanceStore();
    await store.appendTransaction(expense());
    let calls = 0;
    const deps = webDeps(async () => {
      calls += 1;
      return { type: "get_spending_summary", period: "this_month", detail: "total" };
    }, store, messages);
    const turn = { text: "How much have I spent this month?", clientId: "client-turn-01" };
    await handleProfileTurn(profile(), turn, deps);
    await handleProfileTurn(profile(), turn, deps);
    const rows = await messages.listRecent("42", 20);
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant"]);
    expect(rows.every((row) => row.clientId === "client-turn-01")).toBe(true);
    expect(calls).toBe(1);
  });

  it("collapses an optimistic bubble and the saved realtime row by client id", () => {
    const optimistic = bubble({
      id: "client-turn-01",
      role: "user",
      text: "How much have I spent this month?",
      clientId: "client-turn-01",
      status: "sending",
      createdAt: "2026-10-11T17:00:00.000Z",
    });
    const savedUser = bubble({
      id: "db-user",
      role: "user",
      text: "How much have I spent this month?",
      clientId: "client-turn-01",
      createdAt: "2026-10-11T17:00:01.000Z",
    });
    const savedReply = bubble({
      id: "db-reply",
      role: "assistant",
      text: "You've spent GH₵45.00 this month.",
      clientId: "client-turn-01",
      createdAt: "2026-10-11T17:00:01.000Z",
    });
    const merged = mergeThread([optimistic], [savedUser, savedReply]);
    expect(merged.map((message) => message.id)).toEqual(["db-user", "db-reply"]);
    expect(merged[0]?.role).toBe("user");
  });

  it("keeps two real submissions of the same text", () => {
    const first = bubble({ id: "a", role: "user", text: "How much have I spent this month?", clientId: "client-turn-01" });
    const second = bubble({
      id: "b",
      role: "user",
      text: "How much have I spent this month?",
      clientId: "client-turn-02",
      createdAt: "2026-10-11T17:05:00.000Z",
    });
    expect(mergeThread([first], [second])).toHaveLength(2);
  });

  it("retries a failed turn without a second user message", async () => {
    const messages = new MemoryMessageLog();
    const store = new MemoryFinanceStore();
    await store.appendTransaction(expense());
    let calls = 0;
    const deps = webDeps(async () => {
      calls += 1;
      if (calls === 1) throw new Error("ledger down");
      return { type: "get_spending_summary", period: "this_month", detail: "total" };
    }, store, messages);
    const turn = { text: "How much have I spent this month?", clientId: "client-turn-09" };
    await expect(handleProfileTurn(profile(), turn, deps)).rejects.toThrow(/ledger down/);
    expect(await messages.listRecent("42", 10)).toHaveLength(1);
    const retry = await handleProfileTurn(profile(), turn, deps);
    const rows = await messages.listRecent("42", 10);
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant"]);
    expect(retry.messages?.map((row) => row.role)).toEqual(["user", "assistant"]);
    expect(rows[0]?.body).toBe("How much have I spent this month?");
    expect(calls).toBe(2);
  });

  it("does not start a second turn while the first is still running", async () => {
    const messages = new MemoryMessageLog();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => undefined;
    const startedGate = new Promise<void>((resolve) => {
      started = resolve;
    });
    const deps = webDeps(async () => {
      started();
      await gate;
      return { type: "help" };
    }, new MemoryFinanceStore(), messages);
    const turn = { text: "How much have I spent this month?", clientId: "client-turn-03" };
    const first = handleProfileTurn(profile(), turn, deps);
    await startedGate;
    const second = await handleProfileTurn(profile(), turn, deps);
    expect(second.pending).toBe(true);
    expect(await messages.listByClientId("42", "client-turn-03")).toHaveLength(1);
    release();
    await first;
    expect((await messages.listRecent("42", 10)).map((row) => row.role)).toEqual(["user", "assistant"]);
  });

  it("orders a tied turn with the user message before the reply", () => {
    const merged = mergeThread(
      [],
      [
        bubble({
          id: "db-reply",
          role: "assistant",
          text: "You've spent GH₵45.00 this month.",
          clientId: "client-turn-01",
          createdAt: "2026-10-11T17:00:01.000Z",
        }),
        bubble({
          id: "db-user",
          role: "user",
          text: "How much have I spent this month?",
          clientId: "client-turn-01",
          createdAt: "2026-10-11T17:00:01.000Z",
        }),
      ],
    );
    expect(merged.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("uses the previous month when a follow-up asks what the money was spent on", () => {
    const action = applyFollowUp(
      "What have I spent it on?",
      { type: "get_spending_summary", period: "this_month", detail: "total", continue_previous: true },
      monthContext,
    );
    expect(action).toMatchObject({
      type: "get_spending_summary",
      detail: "by_category",
      period: null,
      start_date: "2026-10-01",
      end_date: "2026-10-31",
      category: null,
    });
  });

  it("does not let a request name another person's conversation", () => {
    expect(chatTextSchema.safeParse({ text: "Hello Alfred", clientId: "client-turn-01", ownerId: "someone-else" }).success).toBe(
      false,
    );
    expect(
      chatDecisionSchema.safeParse({ decision: "confirm", actionId: "actionid1234", clientId: "confirm-actionid1234", ownerId: "someone-else" })
        .success,
    ).toBe(false);
  });

  it("does not return another user's messages", async () => {
    const messages = new MemoryMessageLog();
    await messages.append({
      ownerId: "42",
      role: "user",
      body: "secret rent",
      channel: "web",
      clientId: "client-secret1",
    });
    expect(await messages.listRecent("77", 20)).toEqual([]);
    expect(await messages.listByClientId("77", "client-secret1")).toEqual([]);
    const own = await messages.listRecent("42", 20);
    expect(own).toHaveLength(1);
    expect(own[0]?.body).toBe("secret rent");
  });

  it("keeps telegram finance replies and shows them in the shared log", async () => {
    const messages = new MemoryMessageLog();
    const { deps, store, telegram } = harness({ messages });
    await store.appendTransaction(expense());
    await store.appendTransaction(
      expense({
        transactionId: "3f2a1c4e-1111-4111-8111-111111111131",
        amount: "20.00",
        category: "Transport",
        description: "Trotro",
        sourceUpdateId: "seed:telegram-transport",
      }),
    );
    deps.interpret = async () => ({ type: "get_spending_summary", period: "this_month", detail: "total" });
    await runUpdate(textUpdate(40, 42, "How much have I spent this month?"), deps);
    await runUpdate(textUpdate(41, 42, "What have I spent it on?"), deps);
    expect(telegram.sent[0]?.text).toContain("GH₵65.00");
    expect(telegram.sent[1]?.text).toContain("Food: GH₵45.00");
    expect(telegram.sent[1]?.text).toContain("Transport: GH₵20.00");
    const history = await messages.listRecent("42", 10);
    expect(history.map((row) => `${row.channel}:${row.role}`)).toEqual([
      "telegram:user",
      "telegram:assistant",
      "telegram:user",
      "telegram:assistant",
    ]);
    expect(await messages.listRecent("77", 10)).toEqual([]);
  });

  it("derives a stable claim id that stays clear of millisecond studio ids", () => {
    const id = clientTurnUpdateId("client-turn-01");
    expect(id).toBe(clientTurnUpdateId("client-turn-01"));
    expect(id).not.toBe(clientTurnUpdateId("client-turn-02"));
    expect(id).toBeGreaterThan(1_000_000_000_000);
    expect(id).toBeLessThan(1_000_000_000_000_000);
  });
});
