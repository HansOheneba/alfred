import { describe, expect, it, vi } from "vitest";

import { MemoryMessageLog } from "@/lib/accounts/messages";
import type { InterpretRequest } from "@/lib/ai/model";
import { groundedPaymentLabel, proposableLabel } from "@/lib/bank/reply";
import { MemoryBankStore, type BankMessage, type NewBankMessage } from "@/lib/bank/store";
import { ALFRED_SUPABASE_HOST, ALFRED_SUPABASE_PROJECT_REF, ALFRED_SUPABASE_USER } from "@/lib/config";
import { MemoryFinanceStore } from "@/lib/finance/memory-store";
import { MemoryLoanStore, loanBalances } from "@/lib/finance/loans";
import type { InterpretedAction } from "@/lib/finance/schemas";
import { handleProfileTurn, type StudioDeps } from "@/lib/studio/handle";
import { openConfirmationFor } from "@/lib/finance/pending";
import { MemoryLearningLog } from "@/lib/learning/log";
import { profile } from "./helpers";

const NOW = new Date("2026-11-04T18:20:00.000Z");

function setup(reply: (request: InterpretRequest) => InterpretedAction) {
  const owner = profile(42);
  const bank = new MemoryBankStore();
  const store = new MemoryFinanceStore();
  const messages = new MemoryMessageLog();
  const loans = new MemoryLoanStore();
  const interpret = vi.fn(async (request: InterpretRequest) => reply(request));
  const learning = new MemoryLearningLog();
  let sequence = 0;
  let action = 0;
  const deps: StudioDeps = {
    settings: {
      ai: { apiKey: "synthetic-only", model: "unused", strongModel: "unused" }, google: null,
      supabase: { projectRef: ALFRED_SUPABASE_PROJECT_REF, host: ALFRED_SUPABASE_HOST, user: ALFRED_SUPABASE_USER, database: "postgres", password: "synthetic-only" },
      authorizedUserIds: [42], timezone: "Africa/Accra", currency: "GHS", confirmTransactions: "auto",
    },
    bank, store, messages, interpret, loans, learning, now: () => NOW,
    createId: () => `7a1b2c3d-4444-4444-8444-${String(++sequence).padStart(12, "0")}`,
    createActionId: () => `synthetic-proposal-${++action}`,
  };
  async function payment(index: number, fields: Partial<NewBankMessage>): Promise<BankMessage> {
    return (await bank.insertMessage({
      ownerId: owner.profileId, source: "gcb", channel: "mac", externalId: `fictional-${index}`,
      direction: "in", kind: "payment", amount: "125.00", fee: "0.00", currency: "GHS", counterparty: "", balance: null,
      occurredAt: NOW.toISOString(), status: "needs_label", raw: `Fictional card fixture ${index}`, textHash: `card-${index}`, ...fields,
    }))!;
  }
  async function notice(message: BankMessage) {
    await messages.append({ ownerId: owner.profileId, role: "assistant", channel: "web", body: "Fictional payment notice",
      clientId: `payment-notice-${message.id}`, intent: "automation:incoming-payment", paymentNotice: { bankMessageId: message.id, requiresPurpose: true } });
  }
  return { owner, bank, store, loans, interpret, deps, payment, notice, learning };
}

/** A card top-up, then a friend's online purchase on the card ten minutes later. */
async function cardStory(state: ReturnType<typeof setup>) {
  const topUp = await state.payment(1, { direction: "in", amount: "350.00", counterparty: "GCB prepaid card top-up", occurredAt: "2026-11-04T18:08:00.000Z" });
  const charge = await state.payment(2, { direction: "out", amount: "332.19", counterparty: "MTCGAME.COM", occurredAt: "2026-11-04T18:18:00.000Z" });
  await state.notice(topUp);
  return { topUp, charge };
}

describe("Alfred proposes what it understood instead of refusing", () => {
  it("reads a card top-up and a friend's purchase together, and files both only after a yes", async () => {
    let seen: InterpretRequest | null = null;
    const state = setup((request) => {
      seen = request;
      const charge = request.waiting!.lines.findIndex((line) => line.includes("332.19")) + 1;
      return { type: "label_payments", answers: [
        { items: [request.waiting!.current], action: "own_transfer" },
        { items: [charge], action: "lent", person: "George" },
      ] };
    });
    const { topUp, charge } = await cardStory(state);

    const proposal = await handleProfileTurn(state.owner, { text: "He will pay me back so look at it more like George owes me", clientId: "george-owes" }, state.deps);
    expect(seen!.open?.join(" ")).toContain("around the same time");
    expect(proposal.text).toContain("Here's how I read those");
    expect(proposal.text).toContain("money you lent George");
    expect(proposal.text).toContain("your own money moving");
    expect(proposal.ledgerChanged).toBe(false);
    expect((await state.bank.getMessage(state.owner.profileId, topUp.id))?.status).toBe("needs_label");
    expect(await state.loans.list(state.owner.profileId)).toEqual([]);

    await handleProfileTurn(state.owner, { text: "yes", clientId: "george-yes" }, state.deps);
    expect((await state.bank.getMessage(state.owner.profileId, topUp.id))?.status).toBe("transfer");
    expect((await state.bank.getMessage(state.owner.profileId, charge.id))?.status).toBe("lent");
    expect(loanBalances(await state.loans.list(state.owner.profileId))).toMatchObject([{ person: "George", owed: "332.19" }]);
  });

  it("logs each reading the person replaced, rejected or accepted, and a trace per turn", async () => {
    let turn = 0;
    const state = setup((request) => {
      turn += 1;
      const charge = request.waiting!.lines.findIndex((line) => line.includes("332.19")) + 1;
      return turn === 1
        ? { type: "label_payments", answers: [{ items: [request.waiting!.current], action: "own_transfer" }] }
        : { type: "label_payments", answers: [{ items: [request.waiting!.current], action: "own_transfer" }, { items: [charge], action: "lent", person: "George" }] };
    });
    const { topUp } = await cardStory(state);
    await handleProfileTurn(state.owner, { text: "I topped up my virtual card", clientId: "log-1" }, state.deps);
    await handleProfileTurn(state.owner, { text: "George owes me for the game he bought with it", clientId: "log-2" }, state.deps);
    await handleProfileTurn(state.owner, { text: "yes", clientId: "log-3" }, state.deps);
    expect(state.learning.corrections.map((item) => item.kind)).toEqual(["edit", "yes"]);
    expect(state.learning.corrections[0]).toMatchObject({ bankMessageId: topUp.id, userText: "George owes me for the game he bought with it" });
    expect((state.learning.corrections[0].final as unknown[]).length).toBe(2);
    expect(state.learning.traces.length).toBeGreaterThanOrEqual(2);
    expect(state.learning.traces[0]).toMatchObject({ channel: "web", actions: ["label_payments"], proposed: true, refused: false });
    expect(state.learning.corrections.every((item) => item.ownerId === state.owner.profileId)).toBe(true);
  });

  it("logs a rejected reading", async () => {
    const state = setup((request) => ({ type: "label_payments", answers: [{ items: [request.waiting!.current], action: "own_transfer" }] }));
    await cardStory(state);
    await handleProfileTurn(state.owner, { text: "I topped up my virtual card", clientId: "reject-1" }, state.deps);
    await handleProfileTurn(state.owner, { text: "no", clientId: "reject-2" }, state.deps);
    expect(state.learning.corrections).toMatchObject([{ kind: "reject", final: null }]);
  });

  it("leaves everything untouched when the person says no", async () => {
    const state = setup((request) => ({ type: "label_payments", answers: [{ items: [request.waiting!.current], action: "own_transfer" }] }));
    const { topUp } = await cardStory(state);
    const proposal = await handleProfileTurn(state.owner, { text: "I topped up my virtual card", clientId: "top-up" }, state.deps);
    expect(proposal.text).toContain("Here's how I read that");
    await handleProfileTurn(state.owner, { text: "no", clientId: "top-up-no" }, state.deps);
    expect((await state.bank.getMessage(state.owner.profileId, topUp.id))?.status).toBe("needs_label");
  });

  it("re-asks about this payment rather than proposing a person nobody named", async () => {
    const state = setup((request) => ({ type: "label_payments", answers: [{ items: [request.waiting!.current + 1], action: "lent", person: "Kwame" }] }));
    const { charge } = await cardStory(state);
    const result = await handleProfileTurn(state.owner, { text: "a friend will pay me back", clientId: "unnamed-friend" }, state.deps);
    expect(result.text).toContain("haven't changed this payment");
    expect(result.text).not.toContain("couldn't tell which waiting payments");
    expect((await state.bank.getMessage(state.owner.profileId, charge.id))?.status).toBe("needs_label");
  });
});

describe("everyday loan phrasing", () => {
  const out = { direction: "out", counterparty: "MTCGAME.COM" } as BankMessage;
  it.each(["George owes me", "he will pay me back", "he'll pay me back", "I lent it to a friend"])("reads %s as money lent", (text) => {
    expect(groundedPaymentLabel(text, out, { kind: "lent", person: null })).toBe(true);
  });
  it("still reads a returned loan as a repayment", () => {
    expect(groundedPaymentLabel("returned the money I lent him", { direction: "in", counterparty: "KOFI" } as BankMessage, { kind: "repaid", person: null })).toBe(true);
  });
  it("never proposes a spending category the person didn't mention", () => {
    expect(proposableLabel("It was a nice message", { direction: "in", counterparty: "" } as BankMessage, { kind: "category", category: "Gift" })).toBe(false);
  });
});

describe("money in toward something shared", () => {
  const said = "Kojo was paying me to top up our shared API credits";
  const incoming = { direction: "in", counterparty: "KOJO ANSAH" } as BankMessage;
  it("can propose it as their share of what they named, and only after a yes", () => {
    expect(proposableLabel(said, incoming, { kind: "chip_in", category: "Subscriptions", description: "shared API credits", person: null })).toBe(true);
    expect(groundedPaymentLabel(said, incoming, { kind: "chip_in", category: "Subscriptions", description: "shared API credits", person: null })).toBe(false);
  });
  it("never reads it as money merely handled for them", () => {
    expect(proposableLabel(said, incoming, { kind: "pass_through", person: "Kojo", note: null })).toBe(false);
  });
  it("still won't add a bill they didn't name", () => {
    expect(proposableLabel(said, incoming, { kind: "chip_in", category: "Utilities", description: "fibre", person: null })).toBe(false);
  });
});

describe("a typed yes to a proposal in the question flow, after an earlier alert", () => {
  it("files it instead of saying nothing is waiting, and keeps Yes/No across a reload", async () => {
    const state = setup((request) => {
      const charge = request.waiting!.lines.findIndex((line) => line.includes("332.19")) + 1;
      return { type: "label_payments", answers: [{ items: [request.waiting!.current], action: "own_transfer" }, { items: [charge], action: "category", category: "Subscriptions", description: "Claude subscription" }] };
    });
    const { topUp, charge } = await cardStory(state);
    // Alfred then asked about the top-up in chat, not through the alert.
    await state.bank.updateMessage(state.owner.profileId, topUp.id, { askedAt: NOW.toISOString() });
    await state.deps.messages!.append({ ownerId: state.owner.profileId, role: "assistant", channel: "web", body: "Next (1 more after this): GH₵350.00 came in onto your GCB card. What was it?", intent: "bank:label" });
    const proposal = await handleProfileTurn(state.owner, { text: "I topped up my card and the next one was a Claude subscription with that money", clientId: "6f0a3c2e-1111-4111-8111-000000000001" }, state.deps);
    expect(proposal.actionId).toBeTruthy();
    const last = (await state.deps.messages!.listRecent(state.owner.profileId, 1)).at(-1);
    expect(await openConfirmationFor(state.store, state.owner.profileId, last, NOW)).toBe(proposal.actionId);

    const yes = await handleProfileTurn(state.owner, { text: "Yes", clientId: "6f0a3c2e-1111-4111-8111-000000000002" }, state.deps);
    expect(yes.text).not.toContain("nothing waiting");
    expect((await state.bank.getMessage(state.owner.profileId, topUp.id))?.status).toBe("transfer");
    expect((await state.bank.getMessage(state.owner.profileId, charge.id))?.status).toBe("recorded");
    const after = (await state.deps.messages!.listRecent(state.owner.profileId, 1)).at(-1);
    expect(await openConfirmationFor(state.store, state.owner.profileId, after, NOW)).toBeNull();
  });
});

describe("a right reading with an embellished note", () => {
  it("keeps the reading and drops the note instead of refusing", async () => {
    const state = setup((request) => ({ type: "label_payments", answers: [{ items: [request.waiting!.current], action: "lent", person: "George", description: "Mtcgame purchase on my card" }] }));
    const charge = await state.payment(2, { direction: "out", amount: "332.19", counterparty: "MTCGAME.COM", occurredAt: "2026-11-04T18:18:00.000Z" });
    await state.notice(charge);
    const reply = await handleProfileTurn(state.owner, { text: "that was George using my card, he owes me", clientId: "embellished-1", replyToPayment: { bankMessageId: charge.id, requiresPurpose: true } }, state.deps);
    expect(reply.text).not.toContain("haven't changed this payment");
    expect(reply.text).toContain("money you lent George");
    expect(reply.text).not.toContain("Mtcgame purchase");
    await handleProfileTurn(state.owner, { decision: "confirm", actionId: reply.actionId!, clientId: "embellished-2" }, state.deps);
    expect(loanBalances(await state.loans.list(state.owner.profileId))).toMatchObject([{ person: "George", owed: "332.19" }]);
  });
});
