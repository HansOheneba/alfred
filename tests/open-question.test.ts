import { describe, expect, it, vi } from "vitest";

import { MemoryMessageLog } from "@/lib/accounts/messages";
import type { InterpretRequest } from "@/lib/ai/model";
import { openThread } from "@/lib/conversation/thread";
import { ALFRED_SUPABASE_HOST, ALFRED_SUPABASE_PROJECT_REF, ALFRED_SUPABASE_USER } from "@/lib/config";
import { MemoryFinanceStore } from "@/lib/finance/memory-store";
import type { InterpretedAction } from "@/lib/finance/schemas";
import { handleProfileTurn, type StudioDeps } from "@/lib/studio/handle";
import { profile } from "./helpers";

const NOW = new Date("2026-11-05T00:03:30.000Z");
const QUESTION = "Do you want me to record a GH₵1,500.00 Rent & home expense for this month, Mitch?";
const RENT: InterpretedAction = {
  type: "create_transaction",
  explicit: true,
  transactions: [{ transaction_type: "expense", amount: "1500.00", currency: "GHS", category: "Rent & home", description: "Rent", date: "2026-11-05" }],
};

function setup(reply: (request: InterpretRequest) => InterpretedAction) {
  const owner = profile(42);
  const store = new MemoryFinanceStore();
  const messages = new MemoryMessageLog();
  const interpret = vi.fn(async (request: InterpretRequest) => reply(request));
  let sequence = 0;
  const deps: StudioDeps = {
    settings: {
      ai: { apiKey: "synthetic-only", model: "unused", strongModel: "unused" }, google: null,
      supabase: { projectRef: ALFRED_SUPABASE_PROJECT_REF, host: ALFRED_SUPABASE_HOST, user: ALFRED_SUPABASE_USER, database: "postgres", password: "synthetic-only" },
      authorizedUserIds: [42], timezone: "Africa/Accra", currency: "GHS", confirmTransactions: "auto",
    },
    store, messages, interpret, now: () => NOW,
    createId: () => `7a1b2c3d-4444-4444-8444-${String(++sequence).padStart(12, "0")}`,
    createActionId: () => "synthetic-action",
  };
  async function alfredAsked(body: string) {
    await messages.append({ ownerId: owner.profileId, role: "user", channel: "web", body: "Take the 1,500 rent from my savings", clientId: "earlier-user" });
    await messages.append({ ownerId: owner.profileId, role: "assistant", channel: "web", body, clientId: "earlier-user", intent: "clarify" });
  }
  return { owner, store, interpret, deps, alfredAsked };
}

describe("a yes to a question Alfred asked in plain words", () => {
  it("carries out what Alfred offered instead of saying nothing is waiting", async () => {
    const state = setup((request) => request.text.startsWith("Yes, go ahead") ? RENT : { type: "answer_confirmation", decision: "confirm" });
    await state.alfredAsked(QUESTION);
    const result = await handleProfileTurn(state.owner, { text: "Yes.", clientId: "mitch-yes" }, state.deps);
    expect(result.text).not.toContain("nothing waiting");
    expect(state.interpret).toHaveBeenCalledTimes(2);
    expect(state.interpret.mock.calls[1][0].text).toContain(QUESTION);
    expect(await state.store.listTransactions(state.owner.profileId)).toMatchObject([{ amount: "1500.00", category: "Rent & home" }]);
  });

  it("still says nothing is waiting when Alfred didn't ask anything", async () => {
    const state = setup(() => ({ type: "answer_confirmation", decision: "confirm" }));
    await state.alfredAsked("Done. Rent is recorded.");
    const result = await handleProfileTurn(state.owner, { text: "yes", clientId: "bare-yes" }, state.deps);
    expect(result.text).toContain("nothing waiting");
    expect(state.interpret).toHaveBeenCalledTimes(1);
  });

  it("tells the model a plain question has nothing saved behind it", () => {
    const lines = openThread({
      history: [{ ownerId: "o", role: "assistant", channel: "web", body: QUESTION, clientId: "c", createdAt: NOW.toISOString(), intent: "clarify" } as never],
      waiting: null, pending: null, now: NOW,
    });
    expect(lines.join(" ")).toContain("return the action your question described");
  });
});
