import { describe, expect, it, vi } from "vitest";

import { MemoryMessageLog } from "@/lib/accounts/messages";
import { waitingPayments } from "@/lib/bank/reply";
import { MemoryBankStore } from "@/lib/bank/store";
import { interpretWithContext } from "@/lib/finance/context";
import { MemoryLoanStore } from "@/lib/finance/loans";
import { MemoryFinanceStore } from "@/lib/finance/memory-store";
import { NOW, profile } from "./helpers";

describe("Chat context work budgets", () => {
  it("reads loans once for forty waiting payments while preserving both debt directions", async () => {
    const bank = new MemoryBankStore();
    const loans = new MemoryLoanStore();
    for (const [kind, amount] of [["lent", "100.00"], ["borrowed", "40.00"]] as const) {
      await loans.add("42", { person: "Fictional colleague", kind, amount, currency: "GHS", occurredAt: NOW.toISOString(), note: "Synthetic only", bankMessageId: null });
    }
    for (let index = 0; index < 40; index += 1) {
      await bank.insertMessage({ ownerId: "42", source: "gcb", channel: "manual", externalId: null, direction: index % 2 ? "out" : "in", kind: "payment", amount: "1.00", fee: "0.00", currency: "GHS", counterparty: "Fictional colleague", balance: null, occurredAt: NOW.toISOString(), status: "needs_label", raw: "Synthetic only", textHash: `synthetic-performance-${index}` });
    }
    const reads = vi.spyOn(loans, "list");
    const result = await waitingPayments({ bank, loans, ledger: new MemoryFinanceStore(), now: NOW, createId: () => "synthetic-id" }, profile());
    expect(result?.listed).toHaveLength(40);
    expect(reads).toHaveBeenCalledExactlyOnceWith("42");
    expect(result?.lines[0]).toContain("this person owes the user GH₵100.00");
    expect(result?.lines[1]).toContain("the user owes this person GH₵40.00");
  });

  it("starts independent context reads together instead of waiting for a slow history source", async () => {
    const store = new MemoryFinanceStore();
    const messages = new MemoryMessageLog();
    let release!: () => void;
    const slow = new Promise<void>(resolve => { release = resolve; });
    const recent = vi.spyOn(store, "listTransactions").mockImplementation(async () => { await slow; return []; });
    const updates = vi.spyOn(store, "latestCompletedUpdates");
    const budgets = vi.spyOn(store, "listBudgets");
    const goals = vi.spyOn(store, "listSavingsGoals");
    const history = vi.spyOn(messages, "listRecent");
    const turn = interpretWithContext({ text: "How are things?", profile: profile(), store, messages, now: NOW, channel: "web", interpret: async () => ({ type: "chat", message: "Synthetic reply" }) });
    expect(recent).toHaveBeenCalled();
    expect(updates).toHaveBeenCalled();
    expect(budgets).toHaveBeenCalled();
    expect(goals).toHaveBeenCalled();
    expect(history).toHaveBeenCalled();
    release();
    await expect(turn).resolves.toHaveProperty("action.type", "chat");
  });
});
