import { describe, expect, it, vi } from "vitest";

import { MemoryMessageLog, type ChatMessageRecord } from "@/lib/accounts/messages";
import type { InterpretRequest } from "@/lib/ai/deepseek";
import { waitingPayments } from "@/lib/bank/reply";
import { MemoryBankStore } from "@/lib/bank/store";
import { interpretWithContext } from "@/lib/finance/context";
import { MemoryLoanStore } from "@/lib/finance/loans";
import { MemoryFinanceStore } from "@/lib/finance/memory-store";
import { NOW, profile } from "./helpers";

describe("Chat context work budgets", () => {
  it("keeps proactive private payment copy out of later model history", async () => {
    const store = new MemoryFinanceStore(), messages = new MemoryMessageLog();
    await messages.append({ ownerId: "42", channel: "web", role: "assistant", body: "Synthetic private payment detail", intent: "automation:incoming-payment" });
    await messages.append({ ownerId: "42", channel: "web", role: "assistant", body: "Synthetic private follow-up detail", paymentNotice: { bankMessageId: "11111111-1111-4111-8111-111111111111", requiresPurpose: true } });
    await messages.append({ ownerId: "42", channel: "web", role: "user", body: "How are things?" });
    const interpret = vi.fn(async (_request: InterpretRequest) => ({ type: "chat" as const, message: "Synthetic reply" }));
    const open = vi.fn((_history: ChatMessageRecord[]) => []);
    const result = await interpretWithContext({ text: "How are things?", profile: profile(), store, messages, now: NOW, channel: "web", interpret, open });
    expect(JSON.stringify(interpret.mock.calls[0])).not.toContain("Synthetic private payment detail");
    expect(JSON.stringify(open.mock.calls[0])).not.toContain("Synthetic private payment detail");
    expect(JSON.stringify(interpret.mock.calls[0])).not.toContain("Synthetic private follow-up detail");
    expect(JSON.stringify(open.mock.calls[0])).not.toContain("Synthetic private follow-up detail");
    expect(result.cue.history).toEqual([{ role: "user", body: "How are things?" }]);
    expect(interpret.mock.calls[0][0].history).toHaveLength(1);
  });
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
