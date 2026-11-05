import { describe, expect, it } from "vitest";

import { readTurnResponse, revealedWords, TURN_STREAM } from "@/app/chat/turn-stream";
import { actionStep, lookupStep, stepper } from "@/lib/conversation/steps";

function streamed(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); } }), { headers: { "content-type": `${TURN_STREAM}; charset=utf-8` } });
}

describe("streaming a chat turn", () => {
  it("passes each step on as it arrives, then reads the reply, even when lines are split across chunks", async () => {
    const steps: string[] = [];
    const result = await readTurnResponse<{ ok: boolean; text: string }>(streamed([
      '{"type":"step","text":"Reading your message"}\n{"type":"st', 'ep","text":"Adding up this month\'s spending"}\n',
      '{"type":"result","status":200,"body":{"ok":true,"text":"GH₵225.00 on food."}}\n',
    ]), (step) => steps.push(step));
    expect(steps).toEqual(["Reading your message", "Adding up this month's spending"]);
    expect(result).toEqual({ ok: true, payload: { ok: true, text: "GH₵225.00 on food." } });
  });

  it("keeps an error's status, and reads a plain JSON reply the same way", async () => {
    expect(await readTurnResponse(streamed(['{"type":"result","status":429,"body":{"ok":false,"text":"Too many messages."}}\n']), () => undefined))
      .toEqual({ ok: false, payload: { ok: false, text: "Too many messages." } });
    expect(await readTurnResponse(Response.json({ ok: false, text: "Sign in." }, { status: 401 }), () => undefined)).toEqual({ ok: false, payload: { ok: false, text: "Sign in." } });
  });

  it("fails plainly when the stream ends without a reply", async () => {
    await expect(readTurnResponse(streamed(['{"type":"step","text":"Reading your message"}\n']), () => undefined)).rejects.toThrow(/ended/);
  });

  it("reveals a reply quickly, and long ones in about a second and a half", () => {
    expect(revealedWords(10, 0)).toBe(1);
    expect(revealedWords(10, 1000)).toBe(10);
    expect(revealedWords(400, 1400)).toBe(156);
    expect(revealedWords(400, 3700)).toBe(400);
    expect(revealedWords(0, 100)).toBe(0);
  });

  it("says what Alfred is doing in plain words, never a result", () => {
    expect(actionStep({ type: "get_spending_summary", period: "this_month" })).toBe("Adding up this month's spending");
    expect(actionStep({ type: "get_spending_summary" })).toBe("Adding up spending");
    expect(actionStep({ type: "show_chart", by: "week" })).toBe("Drawing your chart");
    expect(actionStep({ type: "chat", message: "Hello" })).toBeNull();
    expect(lookupStep([{ tool: "transactions", text: "Shoprite" }])).toBe("Looking up Shoprite in your records");
    expect(lookupStep([{ tool: "loans" }, { tool: "transactions" }])).toBe("Looking through your records");
  });

  it("skips repeated steps and survives a listener that throws", () => {
    const seen: string[] = [];
    const step = stepper((text) => { seen.push(text); if (text === "boom") throw new Error("listener"); });
    step("Reading your message"); step("Reading your message"); step("boom"); step("Writing");
    expect(seen).toEqual(["Reading your message", "boom", "Writing"]);
  });
});

import { converse } from "@/lib/conversation/turn";
import type { ActionContext } from "@/lib/finance/action-router";
import { MemoryFinanceStore } from "@/lib/finance/memory-store";
import type { FinanceAction } from "@/lib/finance/schemas";
import { profile } from "./helpers";

describe("a turn reports what it's doing", () => {
  it("reads, then adds up, in order, without repeating itself", async () => {
    const store = new MemoryFinanceStore();
    const steps: string[] = [];
    const ctx: ActionContext = { profile: profile(), store, now: new Date("2026-11-20T12:00:00.000Z"), updateId: 1, chatId: 100, confirmTransactions: "auto", pendingTtlMs: 600_000,
      createId: () => "8f02f5de-3333-4333-8333-000000000001", createActionId: () => "action1", progress: stepper((step) => steps.push(step)) };
    const interpret = async (): Promise<FinanceAction> => ({ type: "show_chart", by: "week", period: "this_month" });
    const reply = await converse("chart my spending by week", ctx, { store, interpret, createId: ctx.createId }, { channel: "web" });
    expect(steps).toEqual(["Reading your message", "Drawing your chart"]);
    expect(reply.chart?.kind).toBe("chart");
  });
});
