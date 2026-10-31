import { describe, expect, it } from "vitest";

import { MemoryMessageLog } from "@/lib/accounts/messages";
import { conversationTurns } from "@/lib/ai/deepseek";
import { buildSystemPrompt } from "@/lib/ai/prompts";
import type { VoiceRequest } from "@/lib/ai/voice";
import { ingestBankText } from "@/lib/bank/ingest";
import { MemoryBankStore } from "@/lib/bank/store";
import { openThread } from "@/lib/conversation/thread";
import { converse, type TurnDeps } from "@/lib/conversation/turn";
import type { InterpretRequest } from "@/lib/ai/deepseek";
import type { ActionContext } from "@/lib/finance/action-router";
import { MemoryLoanStore } from "@/lib/finance/loans";
import { MemoryFinanceStore } from "@/lib/finance/memory-store";
import { parseModelOutput, type InterpretedAction } from "@/lib/finance/schemas";
import { MemoryNotebookStore } from "@/lib/notebook/store";
import { profile } from "./helpers";

const ELLEN =
  "Payment made for GHS 22.50 to ELLEN OHENEWA OBENG-DARKO Current Balance: GHS 1512.11 . Available Balance: GHS 1512.11. Reference: . Transaction ID: 92694674830. Fee charged: GHS0.00";

function setup(reply: (request: InterpretRequest) => InterpretedAction) {
  const store = new MemoryFinanceStore();
  const bank = new MemoryBankStore();
  const notebook = new MemoryNotebookStore();
  bank.notebook = notebook;
  const messages = new MemoryMessageLog();
  const requests: InterpretRequest[] = [];
  const voiced: VoiceRequest[] = [];
  const now = new Date("2026-10-31T05:16:00.000Z");
  const owner = profile(42, { preferredName: "Hans" });
  const deps: TurnDeps = {
    store,
    bank,
    notebook,
    messages,
    loans: new MemoryLoanStore(),
    createId: (() => {
      let sequence = 0;
      return () => `7a1b2c3d-4444-4444-8444-${String(++sequence).padStart(12, "0")}`;
    })(),
    interpret: async (request) => {
      requests.push(request);
      return reply(request);
    },
    voice: async (request) => {
      voiced.push(request);
      return request.draft;
    },
  };
  const ctx: ActionContext = {
    profile: owner,
    store,
    now,
    updateId: 1,
    chatId: 100,
    confirmTransactions: "always",
    pendingTtlMs: 600_000,
    createId: deps.createId,
    createActionId: () => "turnaction01",
    notebook,
  };
  return { deps, ctx, bank, store, messages, requests, voiced, owner, now };
}

describe("the conversation as real turns", () => {
  it("joins messages in a row from one side and ends with Alfred", () => {
    expect(
      conversationTurns([
        { role: "assistant", body: "I'll ask about the one that needs a label in the morning." },
        { role: "user", body: "Ask" },
        { role: "assistant", body: "Ask away." },
        { role: "assistant", body: "Anything else?" },
        { role: "user", body: "No I mean ask your questions" },
      ]),
    ).toEqual([
      { role: "assistant", content: "I'll ask about the one that needs a label in the morning." },
      { role: "user", content: "Ask" },
      { role: "assistant", content: "Ask away.\n\nAnything else?" },
    ]);
  });

  it("keeps the history out of the instructions and puts what's open at the end", () => {
    const prompt = buildSystemPrompt({ today: "2026-10-31", timezone: "Africa/Accra", currency: "GHS", recent: [], open: ['Your last message, 3 hours ago: "I\'ll ask in the morning."'] });
    expect(prompt).not.toContain("Recent messages for this user only");
    expect(prompt.trimEnd().endsWith('Your last message, 3 hours ago: "I\'ll ask in the morning."')).toBe(true);
  });
});

describe("what's open", () => {
  it("reads a promise to ask later as the thing a bare \"ask\" answers", async () => {
    const { deps, ctx, owner, messages, now } = setup(() => ({ type: "ask_next" }));
    await ingestBankText({ bank: deps.bank!, ledger: ctx.store, now, createId: deps.createId }, owner, ELLEN, { channel: "mac" });
    await messages.append({ ownerId: "42", role: "assistant", body: "I'll ask about the one that needs a label in the morning.", channel: "telegram", intent: "bank:notice" });
    const { waitingPayments } = await import("@/lib/bank/reply");
    const waiting = await waitingPayments({ bank: deps.bank!, ledger: ctx.store, now, createId: deps.createId }, owner);
    const lines = openThread({ history: await messages.listRecent("42", 20), waiting, pending: null, now });
    expect(lines[0]).toMatch(/^Your last message, .*: "I'll ask about the one that needs a label in the morning\."$/);
    expect(lines[1]).toContain('If they say "ask", "go ahead", or similar, they want it now: use ask_next.');
  });
});

describe("a turn", () => {
  it("goes through waiting payments when the model says ask_next", async () => {
    const { deps, ctx, owner, now, requests } = setup(() => ({ type: "ask_next" }));
    await ingestBankText({ bank: deps.bank!, ledger: ctx.store, now, createId: deps.createId }, owner, ELLEN, { channel: "mac" });
    const reply = await converse("fire away", ctx, deps, { channel: "telegram" });
    expect(reply.text).toContain("First: GH₵22.50 to Ellen Ohenewa Obeng-Darko");
    expect(reply.buttons?.length).toBeGreaterThan(0);
    expect(requests[0].open?.some((line) => line.includes("use ask_next"))).toBe(true);
  });

  it("settles an open confirmation from a reply in any words", async () => {
    let call = 0;
    const { deps, ctx, store } = setup(() =>
      ++call === 1
        ? { type: "record_loan", direction: "borrowed", person: "Kwame", amount: "200.00", currency: "GHS", date: null, note: null }
        : { type: "answer_confirmation", decision: "confirm" },
    );
    deps.loans = new MemoryLoanStore();
    ctx.loans = deps.loans;
    const asked = await converse("I borrowed 200 cash from Kwame", ctx, deps, { channel: "telegram" });
    expect(asked.kind).toBe("confirm");
    const done = await converse("yes please go ahead", ctx, deps, { channel: "telegram" });
    expect(done.text).toBe("Done. You owe Kwame GH₵200.00 in total.");
    expect((await store.getPendingAction("turnaction01"))?.status).toBe("completed");
  });

  it("does several things asked in one message, in order", async () => {
    const { deps, ctx, bank } = setup(() => {
      const parsed = parseModelOutput(
        '{"actions":[{"type":"remember_about_me","note":"I\'m paid on the 25th."},{"type":"ask_next"}]}',
      );
      if (!parsed.success) throw new Error(parsed.issue);
      return parsed.data;
    });
    expect((await bank.listMessages("42")).length).toBe(0);
    const reply = await converse("remember I'm paid on the 25th, and what's next?", ctx, deps, { channel: "telegram" });
    expect(reply.text).toBe(
      "Noted in your notebook: “I'm paid on the 25th”. You can see and edit it on the Notebook page.\n\nNothing is waiting for a label right now. Tell me what you spent, or ask how the month is going.",
    );
    expect(reply.intent).toBe("remember_about_me+ask_next");
  });

  it("tells the voice what's waiting, so it can't say the books are quiet", async () => {
    const { deps, ctx, owner, now, voiced, messages } = setup(() => ({ type: "chat", message: "Ask away, Hans.", topic: "other" }));
    await messages.append({ ownerId: "42", role: "assistant", body: "Filed GH₵20.00 under Food.", channel: "telegram" });
    await ingestBankText({ bank: deps.bank!, ledger: ctx.store, now, createId: deps.createId }, owner, ELLEN, { channel: "mac" });
    await converse("how are you", ctx, deps, { channel: "telegram" });
    expect(voiced[0].state?.[0]).toBe("One payment from their bank texts is waiting for them to say what it was.");
  });
});
