import { describe, expect, it, vi } from "vitest";

import { MemoryMessageLog } from "@/lib/accounts/messages";
import type { InterpretRequest } from "@/lib/ai/deepseek";
import { MemoryBankStore } from "@/lib/bank/store";
import { ALFRED_SUPABASE_HOST, ALFRED_SUPABASE_PROJECT_REF, ALFRED_SUPABASE_USER } from "@/lib/config";
import { createLookup } from "@/lib/conversation/lookups";
import { MemoryFinanceStore } from "@/lib/finance/memory-store";
import { MemoryLoanStore } from "@/lib/finance/loans";
import type { InterpretedAction } from "@/lib/finance/schemas";
import { MemoryLearningLog } from "@/lib/learning/log";
import { handleProfileTurn, type StudioDeps } from "@/lib/studio/handle";
import { profile } from "./helpers";

const NOW = new Date("2026-11-05T14:00:00.000Z");

async function books() {
  const store = new MemoryFinanceStore();
  const owner = profile(42);
  const add = (id: number, date: string, amount: string, category: string, description: string, userId = owner.profileId) => store.appendTransaction({
    transactionId: `7a1b2c3d-9999-4999-8999-${String(id).padStart(12, "0")}`, createdAt: `${date}T12:00:00.000Z`, transactionDate: date, userId, type: "expense",
    amount, currency: "GHS", category, description, paymentMethod: "", notes: "", status: "active", updatedAt: `${date}T12:00:00.000Z`, sourceUpdateId: `t:${id}`,
  });
  await add(1, "2026-10-05", "187.60", "Food", "Shoprite groceries");
  await add(2, "2026-10-21", "95.00", "Food", "Shoprite snacks");
  await add(3, "2026-09-14", "212.40", "Food", "Shoprite groceries");
  await add(4, "2026-10-09", "500.00", "Food", "Shoprite party", "someone-else");
  return { store, owner };
}

describe("lookup tools", () => {
  it("find older transactions by word and date, with a total, for this person only", async () => {
    const { store, owner } = await books();
    const [result] = await createLookup({ store }, owner)([{ tool: "transactions", text: "shoprite", from: "2026-10-01", to: "2026-10-31" }]);
    expect(result.lines[0]).toBe("2 matching transactions.");
    expect(result.lines).toContain("Total expense: GH₵282.60");
    expect(result.lines.join("\n")).not.toContain("500.00");
  });
});

describe("a question that needs a lookup", () => {
  async function play(final: (request: InterpretRequest) => InterpretedAction) {
    const { store, owner } = await books();
    const seen: InterpretRequest[] = [];
    const learning = new MemoryLearningLog();
    const interpret = vi.fn(async (request: InterpretRequest): Promise<InterpretedAction> => {
      seen.push(request);
      return request.lookups?.length ? final(request) : { type: "look_up", queries: [{ tool: "transactions", text: "shoprite", category: null, type: "expense", from: "2026-10-01", to: "2026-10-31", person: null }] };
    });
    const deps: StudioDeps = {
      settings: { deepseek: { apiKey: "synthetic-only", model: "unused" }, google: null,
        supabase: { projectRef: ALFRED_SUPABASE_PROJECT_REF, host: ALFRED_SUPABASE_HOST, user: ALFRED_SUPABASE_USER, database: "postgres", password: "synthetic-only" },
        authorizedUserIds: [42], timezone: "Africa/Accra", currency: "GHS", confirmTransactions: "auto" },
      store, messages: new MemoryMessageLog(), bank: new MemoryBankStore(), loans: new MemoryLoanStore(), learning, interpret, now: () => NOW,
      createId: () => "7a1b2c3d-9999-4999-8999-000000000099", createActionId: () => "lookup-action",
    };
    const result = await handleProfileTurn(owner, { text: "How much did I spend at Shoprite in October?", clientId: "6f0a3c2e-3333-4333-8333-000000000001" }, deps);
    return { result, seen, learning };
  }

  it("looks up, then answers from the results", async () => {
    const { result, seen, learning } = await play(() => ({ type: "chat", message: "You spent GH₵282.60 at Shoprite in October.", topic: "money" }));
    expect(seen).toHaveLength(2);
    expect(seen[1].lookups?.[0].lines).toContain("Total expense: GH₵282.60");
    expect(result.text).toBe("You spent GH₵282.60 at Shoprite in October.");
    expect(learning.traces[0].actions).toEqual(["look_up", "chat"]);
  });

  it("shows the results plainly when the answer invents a figure", async () => {
    const { result } = await play(() => ({ type: "chat", message: "You spent GH₵310.00 at Shoprite in October.", topic: "money" }));
    expect(result.text).toContain("Here's what I found:");
    expect(result.text).toContain("Total expense: GH₵282.60");
  });

  it("stops looking after two rounds and asks instead", async () => {
    const { result, seen } = await play(() => ({ type: "look_up", queries: [{ tool: "notes", text: "x", category: null, type: null, from: null, to: null, person: null }] }));
    expect(seen).toHaveLength(3);
    expect(result.text).toContain("Can you tell me a bit more");
  });
});
