import { describe, expect, it, vi } from "vitest";

import { MemoryMessageLog } from "@/lib/accounts/messages";
import type { InterpretRequest } from "@/lib/ai/model";
import { inventsClaims } from "@/lib/ai/voice";
import { ALFRED_SUPABASE_HOST, ALFRED_SUPABASE_PROJECT_REF, ALFRED_SUPABASE_USER } from "@/lib/config";
import { MemoryFinanceStore } from "@/lib/finance/memory-store";
import { MemoryLoanStore, loanBalances } from "@/lib/finance/loans";
import type { InterpretedAction } from "@/lib/finance/schemas";
import { handleProfileTurn, type StudioDeps } from "@/lib/studio/handle";
import { profile } from "./helpers";

const NOW = new Date("2026-11-05T13:00:00.000Z");

function setup(reply: (request: InterpretRequest) => InterpretedAction) {
  const owner = profile(42);
  const store = new MemoryFinanceStore();
  const loans = new MemoryLoanStore();
  const interpret = vi.fn(async (request: InterpretRequest) => reply(request));
  let sequence = 0, actions = 0;
  const deps: StudioDeps = {
    settings: {
      ai: { apiKey: "synthetic-only", model: "unused", strongModel: "unused" }, google: null,
      supabase: { projectRef: ALFRED_SUPABASE_PROJECT_REF, host: ALFRED_SUPABASE_HOST, user: ALFRED_SUPABASE_USER, database: "postgres", password: "synthetic-only" },
      authorizedUserIds: [42], timezone: "Africa/Accra", currency: "GHS", confirmTransactions: "auto",
    },
    store, loans, messages: new MemoryMessageLog(), interpret, now: () => NOW,
    createId: () => `7a1b2c3d-7777-4777-8777-${String(++sequence).padStart(12, "0")}`,
    createActionId: () => `offer-action-${++actions}`,
  };
  return { owner, store, loans, interpret, deps };
}

const RENT = { type: "create_transaction", explicit: true, transactions: [{ transaction_type: "expense", amount: "1500.00", currency: "GHS", category: "Rent & home", description: "Rent", date: null, payment_method: null, notes: null }] };

describe("a question that offers something", () => {
  it("shows Yes/No, and a yes does exactly what was offered", async () => {
    const state = setup(() => ({ type: "clarify", question: "Shall I record GH₵1,500.00 for rent today?", offer: [RENT] }));
    const asked = await handleProfileTurn(state.owner, { text: "I paid my rent, 1,500", clientId: "6f0a3c2e-2222-4222-8222-000000000001" }, state.deps);
    expect(asked.actionId).toBeTruthy();
    expect(asked.text).toContain("Shall I record");
    expect(await state.store.listTransactions(state.owner.profileId)).toEqual([]);
    await handleProfileTurn(state.owner, { text: "Yes.", clientId: "6f0a3c2e-2222-4222-8222-000000000002" }, state.deps);
    expect(await state.store.listTransactions(state.owner.profileId)).toMatchObject([{ amount: "1500.00", category: "Rent & home" }]);
    expect(state.interpret).toHaveBeenCalledTimes(1);
  });

  it("doesn't ask a second time when the offered action has its own confirmation", async () => {
    const state = setup(() => ({ type: "clarify", question: "Shall I note that Kwame lent you GH₵200.00?", offer: [{ type: "record_loan", direction: "borrowed", person: "Kwame", amount: "200.00", currency: "GHS", date: null, note: null }] }));
    const asked = await handleProfileTurn(state.owner, { text: "kwame gave me 200 cash", clientId: "6f0a3c2e-2222-4222-8222-000000000003" }, state.deps);
    const done = await handleProfileTurn(state.owner, { decision: "confirm", actionId: asked.actionId!, clientId: "confirm-offer" }, state.deps);
    expect(done.actionId).toBeFalsy();
    expect(loanBalances(await state.loans.list(state.owner.profileId))).toMatchObject([{ person: "Kwame", owe: "200.00" }]);
  });

  it("stays a plain question when the offer isn't something safe to do", async () => {
    const state = setup(() => ({ type: "clarify", question: "What was it for?", offer: [{ type: "chat", message: "hi" }] }));
    const asked = await handleProfileTurn(state.owner, { text: "I paid 50", clientId: "6f0a3c2e-2222-4222-8222-000000000004" }, state.deps);
    expect(asked.actionId).toBeFalsy();
  });

  it("does nothing on No", async () => {
    const state = setup(() => ({ type: "clarify", question: "Shall I record GH₵1,500.00 for rent today?", offer: [RENT] }));
    const asked = await handleProfileTurn(state.owner, { text: "I paid my rent, 1,500", clientId: "6f0a3c2e-2222-4222-8222-000000000005" }, state.deps);
    await handleProfileTurn(state.owner, { decision: "cancel", actionId: asked.actionId!, clientId: "cancel-offer" }, state.deps);
    expect(await state.store.listTransactions(state.owner.profileId)).toEqual([]);
  });
});

describe("replies can't claim what didn't happen", () => {
  it("rejects Mitch's 'from your investments' when only the expense was saved", () => {
    const draft = "Recorded: GH₵1,500.00 — Rent & home\nToday · Expense\n\nYour spending for the month is now GH₵4,083.71.";
    expect(inventsClaims("Done, Mitch — GH₵1,500.00 for Rent & home is recorded as coming from your investments, not your cash.", draft, false)).toBe(true);
    expect(inventsClaims("Done, Mitch. GH₵1,500.00 for Rent & home is recorded.", draft, false)).toBe(false);
  });
  it("allows the claim when the facts say it happened", () => {
    expect(inventsClaims("Took GH₵1,500.00 out of Risevest.", "Noted: GH₵1,500.00 out of Risevest. It isn't counted as income. Withdrawn for rent.", false)).toBe(false);
  });
  it("stops a chat reply from saying it saved something", () => {
    expect(inventsClaims("Sure, I've recorded that for you.", "", true)).toBe(true);
    expect(inventsClaims("That sounds like a good plan.", "", true)).toBe(false);
  });
});
