import { describe, expect, it } from "vitest";

import { applyLabel, ingestBankText, type IngestDeps } from "@/lib/bank/ingest";
import { applyResolved, groundedPaymentLabel, paymentPurposeUnclear, proposableLabel, waitingPayments } from "@/lib/bank/reply";
import { MemoryBankStore, type BankMessage } from "@/lib/bank/store";
import { fitsDirection } from "@/lib/conversation/proposals";
import { MemoryFinanceStore } from "@/lib/finance/memory-store";
import type { CategoryRecord } from "@/lib/finance/types";
import { profile } from "./helpers";

const NOW = new Date("2026-11-05T10:00:00.000Z");
const SENT = "Payment made for GHS 25.00 to FIXTURE PERSON Current Balance: GHS 475.00 . Available Balance: GHS 475.00. Reference: . Transaction ID: 99000125002. Fee charged: GHS0.00 Tax charged: 0.";

function setup() {
  const bank = new MemoryBankStore(), ledger = new MemoryFinanceStore(), owner = profile(42);
  let sequence = 0;
  const deps: IngestDeps = { bank, ledger, now: NOW, createId: () => `9a1b2c3d-1111-4111-8111-${String(++sequence).padStart(12, "0")}` };
  async function category(name = "Shopping", type: CategoryRecord["type"] = "expense", userId = owner.profileId) {
    return ledger.createCategory({ categoryId: deps.createId(), userId, name, type, createdAt: NOW.toISOString() });
  }
  async function payment(direction: BankMessage["direction"] = "out") {
    const key = deps.createId();
    return (await bank.insertMessage({ ownerId: owner.profileId, source: "gcb", channel: "manual", externalId: key, textHash: key,
      direction, kind: "payment", amount: "25.00", fee: "0.00", currency: "GHS", counterparty: "",
      balance: null, occurredAt: NOW.toISOString(), status: "needs_label", raw: "Fictional payment" }))!;
  }
  return { bank, ledger, owner, deps, category, payment };
}

describe("owner's saved categories in bank labels", () => {
  it("files a custom expense and preserves the canonical saved name", async () => {
    const state = setup();
    await state.category();
    const payment = await state.payment();
    const result = await applyLabel(state.deps, state.owner, payment.id, { kind: "category", category: "shopping" }, { learn: false });
    expect(result.ok).toBe(true);
    expect(await state.ledger.listTransactions(state.owner.profileId)).toMatchObject([{ category: "Shopping", type: "expense", amount: "25.00" }]);
  });

  it("accepts custom income while rejecting the wrong direction", async () => {
    const state = setup();
    await state.category("Royalties", "income");
    const outgoing = await state.payment(), incoming = await state.payment("in");
    expect((await applyLabel(state.deps, state.owner, outgoing.id, { kind: "category", category: "Royalties" })).ok).toBe(false);
    expect((await applyLabel(state.deps, state.owner, incoming.id, { kind: "category", category: "Royalties" })).ok).toBe(true);
    expect(await state.ledger.listTransactions(state.owner.profileId)).toMatchObject([{ category: "Royalties", type: "income" }]);
  });

  it.each(["refund", "chip_in"] as const)("keeps a custom %s under the expense category", async (kind) => {
    const state = setup();
    await state.category();
    const incoming = await state.payment("in");
    expect((await applyLabel(state.deps, state.owner, incoming.id, { kind, category: "Shopping" }, { learn: false })).ok).toBe(true);
    expect(await state.ledger.listTransactions(state.owner.profileId)).toMatchObject([{ category: "Shopping", type: "expense", amount: "-25.00" }]);
  });

  it("rejects unknown names and a category owned by someone else without writing", async () => {
    const state = setup();
    await state.category("Shopping", "expense", "84");
    const payment = await state.payment();
    expect((await applyLabel(state.deps, state.owner, payment.id, { kind: "category", category: "Shopping" })).ok).toBe(false);
    expect((await applyLabel(state.deps, state.owner, payment.id, { kind: "category", category: "Unconfigured" })).ok).toBe(false);
    expect(await state.ledger.listTransactions(state.owner.profileId)).toEqual([]);
    expect((await state.bank.getMessage(state.owner.profileId, payment.id))?.status).toBe("needs_label");
  });

  it("honors an explicitly saved custom category in future payee rules", async () => {
    const state = setup();
    await state.category();
    await state.bank.saveRule(state.owner.profileId, { payeeKey: "fixture person", category: "Shopping", description: "Fictional supplies" });
    const result = await ingestBankText(state.deps, state.owner, SENT, { channel: "manual", sender: "MobileMoney" });
    expect(result.outcomes[0]).toMatchObject({ outcome: "recorded", category: "Shopping" });
    expect(await state.ledger.listTransactions(state.owner.profileId)).toMatchObject([{ category: "Shopping", amount: "25.00" }]);
  });

  it("uses saved categories for exact payment replies and keeps unclear replies pending", async () => {
    const state = setup();
    const saved = await state.category();
    const payment = await state.payment();
    const waiting = (await waitingPayments(state.deps, state.owner, { currentMessageId: payment.id }))!;
    const answer = [{ messageIds: [payment.id], label: { kind: "category" as const, category: "Shopping" } }];
    expect(groundedPaymentLabel("Shopping", payment, answer[0].label, [saved])).toBe(true);
    expect(paymentPurposeUnclear("maybe Shopping", "out", [saved])).toBe(true);
    await applyResolved(state.deps, state.owner, "maybe Shopping", answer, waiting);
    expect(await state.ledger.listTransactions(state.owner.profileId)).toEqual([]);
    await applyResolved(state.deps, state.owner, "Shopping", answer, waiting);
    expect(await state.ledger.listTransactions(state.owner.profileId)).toMatchObject([{ category: "Shopping" }]);
  });

  it("does not let another owner's category satisfy pure proposal guards", async () => {
    const state = setup();
    const foreign = await state.category("Shopping", "expense", "84");
    const payment = await state.payment();
    const label = { kind: "category" as const, category: "Shopping" };
    expect(fitsDirection(payment, label, [foreign])).toBe(false);
    expect(groundedPaymentLabel("Shopping", payment, label, [foreign])).toBe(false);
    expect(proposableLabel("Shopping", payment, label, [], [foreign])).toBe(false);
  });

  it.each(["Arts & health", "École supplies", "Books (fiction)", "Health insurance"])("recognizes the complete saved name %s", async (name) => {
    const state = setup();
    const saved = await state.category(name);
    const payment = await state.payment();
    expect(groundedPaymentLabel(name, payment, { kind: "category", category: name }, [saved])).toBe(true);
    expect(groundedPaymentLabel(`${name} or Food`, payment, { kind: "category", category: name }, [saved])).toBe(false);
  });

  it.each(["Loan", "My own money", "Investment", "Pass through"])("does not erase financial-kind evidence in an income category named %s", async (name) => {
    const state = setup();
    const saved = await state.category(name, "income");
    const payment = await state.payment("in");
    const label = { kind: "category" as const, category: name };
    expect(groundedPaymentLabel(name, payment, label, [saved])).toBe(false);
    expect(proposableLabel(name, payment, label, [], [saved])).toBe(false);
    const waiting = (await waitingPayments(state.deps, state.owner, { currentMessageId: payment.id }))!;
    await applyResolved(state.deps, state.owner, name, [{ messageIds: [payment.id], label }], waiting);
    expect(await state.ledger.listTransactions(state.owner.profileId)).toEqual([]);
    expect((await state.bank.getMessage(state.owner.profileId, payment.id))?.status).toBe("needs_label");
  });

  it("does not let an expense category called Salary mask the built-in income category", async () => {
    const state = setup();
    const saved = await state.category("Salary", "expense");
    const payment = await state.payment("in");
    expect(groundedPaymentLabel("Salary", payment, { kind: "category", category: "Salary" }, [saved])).toBe(true);
    expect(fitsDirection(payment, { kind: "category", category: "Salary" }, [saved])).toBe(true);
  });

  it("does not let a custom income name mask refund evidence", async () => {
    const state = setup();
    const shopping = await state.category();
    const refundName = await state.category("Shopping refund", "income");
    const payment = await state.payment("in");
    expect(groundedPaymentLabel("Shopping refund", payment, { kind: "category", category: "Shopping refund" }, [shopping, refundName])).toBe(false);
    expect(proposableLabel("Shopping refund", payment, { kind: "category", category: "Shopping refund" }, [], [shopping, refundName])).toBe(false);
  });
});
