import { describe, expect, it } from "vitest";

import { MemoryBankStore, type NewBankMessage } from "@/lib/bank/store";
import { rememberedAnswers } from "@/lib/conversation/remembered";
import { MemoryFinanceStore } from "@/lib/finance/memory-store";
import { MemoryLoanStore } from "@/lib/finance/loans";
import { profile } from "./helpers";

async function world() {
  const owner = profile(42);
  const bank = new MemoryBankStore();
  const store = new MemoryFinanceStore();
  const loans = new MemoryLoanStore();
  let index = 0;
  const pay = async (fields: Partial<NewBankMessage>) => (await bank.insertMessage({
    ownerId: owner.profileId, source: "gcb", channel: "mac", externalId: `r-${++index}`, direction: "out", kind: "payment", amount: "100.00", fee: "0.00",
    currency: "GHS", counterparty: "", balance: null, occurredAt: "2026-10-01T10:00:00.000Z", status: "needs_label", raw: "synthetic", textHash: `r-${index}`, ...fields,
  }))!;
  const file = async (id: string, category: string, description: string, amount: string) => {
    const transactionId = `7a1b2c3d-4444-4444-8444-${String(++index).padStart(12, "0")}`;
    await store.appendTransaction({ transactionId, createdAt: "2026-10-01T10:00:00.000Z", transactionDate: "2026-10-01", userId: owner.profileId, type: "expense", amount, currency: "GHS", category, description, paymentMethod: "", notes: "", status: "active", updatedAt: "2026-10-01T10:00:00.000Z", sourceUpdateId: `bank:${id}` });
    await bank.updateMessage(owner.profileId, id, { status: "recorded", transactionId });
  };
  return { owner, bank, store, loans, pay, file };
}

describe("remembered answers", () => {
  it("shows how a similar nameless card charge was filed before", async () => {
    const w = await world();
    const october = await w.pay({ amount: "1290.10", occurredAt: "2026-10-03T10:09:00.000Z" });
    await w.file(october.id, "Subscriptions", "Claude subscription", "1290.10");
    const groceries = await w.pay({ amount: "120.00" });
    await w.file(groceries.id, "Food", "Groceries", "120.00");
    const november = await w.pay({ amount: "1307.48", occurredAt: "2026-11-03T10:09:00.000Z" });
    const lines = await rememberedAnswers(w, w.owner, november);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Subscriptions (Claude subscription)");
  });

  it("matches a named payee whatever the amount, and shows who a loan was with", async () => {
    const w = await world();
    const before = await w.pay({ counterparty: "KOFI MENSAH", amount: "50.00" });
    await w.bank.updateMessage(w.owner.profileId, before.id, { status: "lent" });
    await w.loans.add(w.owner.profileId, { person: "Kofi Mensah", kind: "lent", amount: "50.00", currency: "GHS", occurredAt: "2026-10-01T10:00:00.000Z", note: "", bankMessageId: before.id });
    const now = await w.pay({ counterparty: "KOFI MENSAH", amount: "400.00" });
    expect(await rememberedAnswers(w, w.owner, now)).toEqual([expect.stringContaining("lent to Kofi Mensah")]);
  });

  it("never learns from another person's payments", async () => {
    const w = await world();
    const theirs = await w.pay({ ownerId: "someone-else", amount: "1290.10" });
    await w.bank.updateMessage("someone-else", theirs.id, { status: "transfer" });
    const mine = await w.pay({ amount: "1307.48" });
    expect(await rememberedAnswers(w, w.owner, mine)).toEqual([]);
  });
});
