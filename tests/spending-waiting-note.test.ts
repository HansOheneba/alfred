import { describe, expect, it, vi } from "vitest";

import { handleAction, type ActionContext, type BankAccess } from "@/lib/finance/action-router";
import { MemoryFinanceStore } from "@/lib/finance/memory-store";
import { voiceDelivery, type Voice } from "@/lib/ai/voice";
import type { FinanceAction } from "@/lib/finance/schemas";

const NOW = "2026-11-12T12:00:00Z";
type Waiting = Awaited<ReturnType<NonNullable<BankAccess["waiting"]>>>;

function setup(waiting: Waiting | (() => Promise<Waiting>)) {
  const store = new MemoryFinanceStore();
  const ctx: ActionContext = {
    store,
    profile: { profileId: "owner", telegramUserId: null, spreadsheetId: "synthetic", currency: "GHS", timezone: "Africa/Accra", preferredName: "Alex", communicationPreference: "concise" },
    now: new Date(NOW),
    updateId: 1,
    chatId: 1,
    confirmTransactions: "auto",
    pendingTtlMs: 60_000,
    createId: () => "id",
    createActionId: () => "action",
    bank: { ignoreAccount: null, balances: async () => [], waiting: typeof waiting === "function" ? waiting : vi.fn(async () => waiting) },
  };
  return { ctx, store };
}

const out = (amount: string, occurredAt: string) => ({ direction: "out" as const, amount, currency: "GHS", occurredAt });

describe("spending replies name payments still waiting for a category", () => {
  it("counts only money out within the period asked about", async () => {
    const { ctx } = setup([
      out("40.00", "2026-11-10T09:00:00Z"),
      out("200.00", "2026-11-11T18:30:00Z"),
      { direction: "in", amount: "500.00", currency: "GHS", occurredAt: "2026-11-11T08:00:00Z" },
      out("75.00", "2026-10-28T10:00:00Z"),
    ]);
    const result = await handleAction({ type: "get_spending_summary", period: "this_month", detail: "total" }, ctx);
    expect(result.text).toContain("2 bank payments (GH₵240.00) are still waiting for a category and aren't included.");
  });

  it("says one payment in the singular", async () => {
    const { ctx } = setup([out("40.00", "2026-11-12T09:00:00Z")]);
    const result = await handleAction({ type: "get_spending_summary", period: "today", detail: "total" }, ctx);
    expect(result.text).toContain("1 bank payment (GH₵40.00) is still waiting for a category and isn't included.");
  });

  it("adds nothing when none are waiting in the period, for a category question, or when the bank can't be read", async () => {
    const quiet = setup([out("75.00", "2026-10-28T10:00:00Z")]);
    expect((await handleAction({ type: "get_spending_summary", period: "this_month", detail: "total" }, quiet.ctx)).text).not.toContain("waiting for a category");
    const food = setup([out("40.00", "2026-11-10T09:00:00Z")]);
    expect((await handleAction({ type: "get_spending_summary", period: "this_month", detail: "total", category: "Food" }, food.ctx)).text).not.toContain("waiting for a category");
    const broken = setup(async () => { throw new Error("offline"); });
    expect((await handleAction({ type: "get_spending_summary", period: "this_month", detail: "total" }, broken.ctx)).text).not.toContain("waiting for a category");
  });
});

describe("rewording a spending reply", () => {
  it("keeps the waiting note word for word and leaves it out of what the voice sees", async () => {
    const note = "2 bank payments (GH₵240.00) are still waiting for a category and aren't included.";
    const draft = `You've spent GH₵120.00 this month.\n\n${note}`;
    const voice = vi.fn(async (request: { draft: string }) => {
      expect(request.draft).not.toContain("waiting");
      return "So far this month you've spent GH₵120.00.";
    });
    const result = await voiceDelivery(voice as unknown as Voice, { type: "get_spending_summary", period: "this_month", detail: "total" } as FinanceAction, { kind: "text", text: draft }, {
      userText: "how much have I spent this month?",
      profile: { profileId: "owner", telegramUserId: null, spreadsheetId: "synthetic", currency: "GHS", timezone: "Africa/Accra", preferredName: "Alex", communicationPreference: "concise" },
    } as Parameters<typeof voiceDelivery>[3]);
    expect(result.kind === "text" && result.text).toBe(`So far this month you've spent GH₵120.00.\n\n${note}`);
  });
});
