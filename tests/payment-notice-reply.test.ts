import { describe, expect, it, vi } from "vitest";

import { clientTurnUpdateId, MemoryMessageLog, type ChatMessageRecord } from "@/lib/accounts/messages";
import { chatChoiceSchema, chatTextSchema } from "@/lib/accounts/chat-request";
import type { InterpretRequest } from "@/lib/ai/deepseek";
import { applyResolved, chooseLabel, currentQuestion, waitingPayments } from "@/lib/bank/reply";
import { applyLabel } from "@/lib/bank/ingest";
import { MemoryBankStore, type BankMessage, type NewBankMessage } from "@/lib/bank/store";
import { ALFRED_SUPABASE_HOST, ALFRED_SUPABASE_PROJECT_REF, ALFRED_SUPABASE_USER } from "@/lib/config";
import { AiError } from "@/lib/errors";
import { MemoryFinanceStore } from "@/lib/finance/memory-store";
import { MemoryLoanStore, loanBalances } from "@/lib/finance/loans";
import type { FinanceAction, InterpretedAction } from "@/lib/finance/schemas";
import { handleProfileTurn, openChoices, type StudioDeps } from "@/lib/studio/handle";
import { expense, profile } from "./helpers";

const NOW = new Date("2026-11-03T12:00:00.000Z");

function setup(reply?: (request: InterpretRequest) => InterpretedAction | Promise<InterpretedAction>) {
  const owner = profile(42);
  const bank = new MemoryBankStore();
  const store = new MemoryFinanceStore();
  const messages = new MemoryMessageLog();
  const interpret = vi.fn(async (request: InterpretRequest): Promise<InterpretedAction> => reply
    ? reply(request)
    : ({ type: "label_payments", answers: [{ items: [request.waiting!.current], action: "category", category: "Business", description: "freelance work" }] }));
  let sequence = 0;
  const deps: StudioDeps = {
    settings: {
      deepseek: { apiKey: "synthetic-only", model: "unused" }, google: null,
      supabase: { projectRef: ALFRED_SUPABASE_PROJECT_REF, host: ALFRED_SUPABASE_HOST, user: ALFRED_SUPABASE_USER, database: "postgres", password: "synthetic-only" },
      authorizedUserIds: [42], timezone: "Africa/Accra", currency: "GHS", confirmTransactions: "auto",
    },
    bank, store, messages, interpret, now: () => NOW,
    createId: () => `7a1b2c3d-4444-4444-8444-${String(++sequence).padStart(12, "0")}`,
    createActionId: () => "synthetic-payment-reply",
  };
  const ingest = { bank, ledger: store, now: NOW, createId: deps.createId };
  async function payment(index: number, overrides: Partial<NewBankMessage> = {}): Promise<BankMessage> {
    return (await bank.insertMessage({
      ownerId: owner.profileId, source: "mtn", channel: "mac", externalId: `fictional-${index}`,
      direction: "in", kind: "payment", amount: "125.00", fee: "0.00", currency: "GHS",
      counterparty: `FICTIONAL PERSON ${index}`, balance: null,
      occurredAt: new Date(NOW.getTime() - 60_000 * (100 - index)).toISOString(),
      status: "needs_label", raw: `Fictional provider fixture ${index}`, textHash: `fixture-${index}`, ...overrides,
    }))!;
  }
  async function notice(message: BankMessage, requiresPurpose = true): Promise<ChatMessageRecord> {
    return messages.append({ ownerId: owner.profileId, role: "assistant", channel: "web",
      body: "FICTIONAL PRIVATE NOTICE BODY — must not become extra model history",
      clientId: `payment-notice-${message.id}`, intent: "automation:incoming-payment",
      paymentNotice: { bankMessageId: message.id, requiresPurpose },
    });
  }
  return { owner, bank, store, messages, interpret, deps, ingest, payment, notice };
}

async function olderConfirmation(state: ReturnType<typeof setup>) {
  await state.store.appendPendingAction({ actionId: "older-confirmation", userId: state.owner.profileId, chatId: "0",
    actionType: "create_transaction", status: "pending", createdAt: new Date(NOW.getTime() - 60_000).toISOString(),
    expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    payloadJson: JSON.stringify({ type: "create_transaction", originUpdateId: "123", transactions: [{
      transactionType: "expense", amount: "9.00", currency: "GHS", category: "Food", description: "Fictional older lunch",
      date: "2026-11-03", paymentMethod: "", notes: "",
    }] }),
  });
}

describe("replying to a proactive payment-purpose question", () => {
  it("shows only the exact notice's answer buttons without marking it asked or writing finances", async () => {
    const state = setup();
    const older = await state.payment(1);
    const target = await state.payment(2);
    await state.bank.updateMessage(state.owner.profileId, older.id, { askedAt: NOW.toISOString() });
    const last = await state.notice(target);
    const before = await state.bank.listMessages(state.owner.profileId);
    const choices = await openChoices(state.owner, state.deps, last);
    expect(choices.flat().length).toBeGreaterThan(0);
    expect(choices.flat().filter(choice => choice.choice).every(choice => choice.choice!.includes(target.id))).toBe(true);
    expect((await currentQuestion(state.ingest, state.owner))?.message.id).toBe(older.id);
    expect(await state.bank.listMessages(state.owner.profileId)).toEqual(before);
    expect(await state.store.listTransactions(state.owner.profileId)).toEqual([]);
    expect(state.interpret).not.toHaveBeenCalled();
  });

  it("includes the exact notice beyond forty older waiting rows in a bounded context", async () => {
    const state = setup();
    const all = [];
    for (let index = 0; index < 45; index++) all.push(await state.payment(index));
    const target = all.at(-1)!;
    const waiting = await waitingPayments(state.ingest, state.owner, { currentMessageId: target.id });
    expect(waiting?.listed).toHaveLength(40);
    expect(waiting?.current?.id).toBe(target.id);
    expect(waiting?.currentNumber).toBe(40);
    expect(waiting?.listed[waiting.currentNumber - 1]?.id).toBe(target.id);
    expect((await state.bank.getMessage(state.owner.profileId, target.id))?.askedAt).toBeNull();
  });

  it("files an explicit purpose for exactly that payment once and excludes the private notice from model history", async () => {
    const state = setup();
    const older = await state.payment(1);
    const target = await state.payment(2);
    await state.bank.updateMessage(state.owner.profileId, older.id, { askedAt: NOW.toISOString() });
    await state.notice(target);
    const input = { text: "It was for freelance work", clientId: "purpose-clear-answer-01" };
    const first = await handleProfileTurn(state.owner, input, state.deps);
    const replay = await handleProfileTurn(state.owner, input, state.deps);
    const request = state.interpret.mock.calls[0][0];
    expect(request.waiting?.current).toBe(2);
    expect(request.waiting?.lines[1]).toContain("Fictional Person 2");
    expect(JSON.stringify(request.history)).not.toContain("FICTIONAL PRIVATE NOTICE BODY");
    expect(JSON.stringify(request.open)).not.toContain("FICTIONAL PRIVATE NOTICE BODY");
    expect(request.open?.join(" ")).toContain("waiting payment 2");
    expect(state.interpret).toHaveBeenCalledTimes(1);
    expect(first.text).toContain("Business");
    expect(replay.text).toBe(first.text);
    expect(first.ledgerChanged).toBe(true);
    expect(replay.ledgerChanged).toBe(true);
    expect(first.messages?.find(message => message.role === "assistant")?.paymentNotice).toEqual({ bankMessageId: target.id, requiresPurpose: false });
    expect(await state.store.listTransactions(state.owner.profileId)).toMatchObject([{ category: "Business", description: "freelance work", amount: "125.00" }]);
    expect((await state.bank.getMessage(state.owner.profileId, target.id))?.status).toBe("recorded");
    expect((await state.bank.getMessage(state.owner.profileId, older.id))?.status).toBe("needs_label");
    expect(await state.messages.listByClientId(state.owner.profileId, input.clientId)).toHaveLength(2);
    expect((await state.messages.listByClientId(state.owner.profileId, input.clientId)).find(message => message.role === "user")?.paymentNotice).toEqual({ bankMessageId: target.id, requiresPurpose: true });
  });

  it.each(["yes", "no idea", "not sure", "maybe", "maybe salary?", "maybe it was salary", "not sure if gift or loan", "probably gift or salary", "I think", "thanks"])("keeps a vague reply (%s) open without letting a resolver guess", async text => {
    const state = setup();
    const target = await state.payment(1);
    await olderConfirmation(state);
    await state.notice(target);
    const first = await handleProfileTurn(state.owner, { text, clientId: `unclear-answer-${text.replaceAll(" ", "-")}` }, state.deps);
    expect(first.ledgerChanged).toBe(false);
    expect(first.text).toContain("leave this uncategorised");
    expect(first.messages?.find(message => message.role === "assistant")?.paymentNotice).toEqual({ bankMessageId: target.id, requiresPurpose: true });
    expect(first.choices?.flat().filter(choice => choice.choice).every(choice => choice.choice!.includes(target.id))).toBe(true);
    expect(state.interpret).not.toHaveBeenCalled();
    expect(await state.store.listTransactions(state.owner.profileId)).toEqual([]);
    expect((await state.bank.getMessage(state.owner.profileId, target.id))?.askedAt).toBeNull();
    expect((await state.store.getPendingAction("older-confirmation"))?.status).toBe("pending");
  });

  it.each([
    ["I think it was a gift", "Gift", "gift"],
    ["probably freelance work", "Business", "freelance work"],
    ["I think it was salary", "Salary", "salary"],
  ])("accepts a clear single purpose despite a declarative hedge (%s)", async (text, category, description) => {
    const state = setup(request => ({ type: "label_payments", answers: [{ items: [request.waiting!.current], action: "category", category, description }] }));
    const older = await state.payment(1);
    const target = await state.payment(2);
    await olderConfirmation(state);
    await state.notice(target);
    const input = { text, clientId: `clear-hedged-${category}` };
    const first = await handleProfileTurn(state.owner, input, state.deps);
    const replay = await handleProfileTurn(state.owner, input, state.deps);
    expect(first.ledgerChanged).toBe(true);
    expect(replay.text).toBe(first.text);
    expect(first.text).toContain(`under ${category}`);
    expect(first.text).not.toMatch(/received|settled|verified/i);
    expect(await state.store.listTransactions(state.owner.profileId)).toMatchObject([{ category, description }]);
    expect((await state.bank.getMessage(state.owner.profileId, older.id))?.status).toBe("needs_label");
    expect((await state.bank.getMessage(state.owner.profileId, target.id))?.status).toBe("recorded");
    expect(state.bank.rules.size).toBe(0);
    expect((await state.store.getPendingAction("older-confirmation"))?.status).toBe("pending");
    expect(state.interpret).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["I think it was a gift", "Business", "freelance work"],
    ["I think it was a gift", "Gift", "birthday gift"],
    ["probably freelance work", "Salary", "salary"],
    ["probably freelance work", "Business", "website development"],
    ["It was for freelance work", "Gift", "gift"],
    ["It was a nice message", "Gift", "gift"],
  ])("rejects a model purpose or detail absent from the person's reply (%s / %s / %s)", async (text, category, description) => {
    const state = setup(request => ({ type: "label_payments", answers: [{ items: [request.waiting!.current], action: "category", category, description }] }));
    const target = await state.payment(1);
    await state.notice(target);
    const result = await handleProfileTurn(state.owner, { text, clientId: `ungrounded-purpose-${category}-${description.replaceAll(" ", "-")}` }, state.deps);
    expect(result.ledgerChanged).toBe(false);
    // Either Alfred asks again, or it offers the purpose they named with the invented detail dropped, for a yes first.
    if (result.actionId) expect(result.text).not.toContain(`(${description})`);
    else expect(result.text).toContain("haven't changed this payment");
    expect(result.messages?.find(message => message.role === "assistant")?.paymentNotice).toEqual({ bankMessageId: target.id, requiresPurpose: true });
    expect(await state.store.listTransactions(state.owner.profileId)).toEqual([]);
    expect((await state.bank.getMessage(state.owner.profileId, target.id))?.status).toBe("needs_label");
    expect(state.bank.rules.size).toBe(0);
  });

  it("allows formatting a clear purpose with this alert's known sender, but no invented purpose", async () => {
    const state = setup(request => ({ type: "label_payments", answers: [{ items: [request.waiting!.current], action: "category", category: "Gift", description: "Gift from Fictional Person 1" }] }));
    const target = await state.payment(1);
    await state.notice(target);
    const result = await handleProfileTurn(state.owner, { text: "I think it was a gift", clientId: "grounded-purpose-known-sender" }, state.deps);
    expect(result.ledgerChanged).toBe(true);
    expect(await state.store.listTransactions(state.owner.profileId)).toMatchObject([{ category: "Gift", description: "Gift from Fictional Person 1" }]);
  });

  it.each([["thanks", "You're welcome."], ["ok", "Got it."], ["okay!", "Got it."]])("naturally acknowledges %s after a non-question notice without touching old actions", async (text, expected) => {
    const state = setup(() => { throw new Error("A social acknowledgement must not call a model"); });
    const older = await state.payment(1);
    await state.bank.updateMessage(state.owner.profileId, older.id, { askedAt: NOW.toISOString() });
    const target = await state.payment(2, { status: "recorded" });
    await olderConfirmation(state);
    const last = await state.notice(target, false);
    const first = await handleProfileTurn(state.owner, { text, clientId: `social-known-${text.replaceAll("!", "")}`, replyToPayment: last.paymentNotice }, state.deps);
    expect(first.text).toBe(expected);
    expect(first.ledgerChanged).toBe(false);
    expect(first.messages?.find(message => message.role === "assistant")?.paymentNotice).toEqual({ bankMessageId: target.id, requiresPurpose: false });
    const yes = await handleProfileTurn(state.owner, { text: "yes", clientId: `social-known-yes-${text.replaceAll("!", "")}` }, state.deps);
    expect(yes.text).toBe("Got it.");
    expect(yes.ledgerChanged).toBe(false);
    expect(await state.store.listTransactions(state.owner.profileId)).toEqual([]);
    expect((await state.store.getPendingAction("older-confirmation"))?.status).toBe("pending");
    expect((await state.bank.getMessage(state.owner.profileId, older.id))?.status).toBe("needs_label");
    expect(state.interpret).not.toHaveBeenCalled();
  });

  it.each(["school fees from dad", "my sister's wedding contribution"])("asks for financial type without losing a clear contextual purpose (%s)", async purpose => {
    const state = setup(request => ({ type: "label_payments", answers: [{ items: [request.waiting!.current], action: "category", category: "Gift", description: request.text }] }));
    const other = await state.payment(1);
    const target = await state.payment(2);
    await state.notice(target);
    const first = await handleProfileTurn(state.owner, { text: purpose, clientId: `context-purpose-${purpose.startsWith("school") ? "school" : "wedding"}` }, state.deps);
    expect(first.ledgerChanged).toBe(false);
    expect(first.text).toContain(`You said “${purpose}”`);
    expect(first.text).toContain("Was it a gift, a repayment, your own money");
    expect(first.text).not.toContain("What was it?");
    expect(await state.store.listTransactions(state.owner.profileId)).toEqual([]);
    const second = await handleProfileTurn(state.owner, { text: "Gift", clientId: `context-classify-${purpose.startsWith("school") ? "school" : "wedding"}` }, state.deps);
    expect(second.ledgerChanged).toBe(true);
    expect(await state.store.listTransactions(state.owner.profileId)).toMatchObject([{ category: "Gift", description: purpose }]);
    expect((await state.bank.getMessage(state.owner.profileId, other.id))?.status).toBe("needs_label");
    expect(state.bank.rules.size).toBe(0);
    const classifyRequest = state.interpret.mock.calls[1][0];
    expect(classifyRequest.text).toBe("Gift");
    expect(JSON.stringify(classifyRequest.history)).not.toContain(purpose);
    // The person's earlier words about this same payment are given as labelled context, never as chat history.
    expect(JSON.stringify(classifyRequest.open)).toContain(`Earlier about this payment they said: \\"${purpose}\\"`);
  });

  it("does not recover purpose details from another payment's private reply", async () => {
    const state = setup(request => ({ type: "label_payments", answers: [{ items: [request.waiting!.current], action: "category", category: "Gift", description: "gift" }] }));
    const other = await state.payment(1);
    const target = await state.payment(2);
    await state.messages.append({ ownerId: state.owner.profileId, role: "user", channel: "web", body: "school fees from dad", paymentNotice: { bankMessageId: other.id, requiresPurpose: true } });
    await state.notice(target);
    const result = await handleProfileTurn(state.owner, { text: "Gift", clientId: "context-no-other-payment-detail" }, state.deps);
    expect(result.ledgerChanged).toBe(true);
    expect((await state.store.listTransactions(state.owner.profileId))[0].description).toBe("gift");
  });

  it.each([
    ["I spent 30 on lunch", "30.00", "GHS", "lunch"],
    ["I just spent GHS 30.50 on lunch", "30.50", "GHS", "lunch"],
    ["I spent 30 USD on transport", "30.00", "USD", "transport"],
  ])("accepts a narrowly grounded independent expense after a closed notice (%s)", async (text, amount, currency, description) => {
    const state = setup(() => { throw new Error("The grounded new-expense request must not need a model"); });
    const target = await state.payment(1, { status: "recorded" });
    await olderConfirmation(state);
    const notice = await state.notice(target, false);
    const input = { text, clientId: `known-new-expense-${currency}-${amount.replaceAll(".", "-")}`, replyToPayment: notice.paymentNotice };
    const pending = await handleProfileTurn(state.owner, input, state.deps);
    const replay = await handleProfileTurn(state.owner, input, state.deps);
    expect(pending.actionId).toBe("synthetic-payment-reply");
    expect(pending.ledgerChanged).toBe(false);
    expect(replay.actionId).toBe(pending.actionId);
    expect(pending.messages?.find(message => message.role === "assistant")?.paymentNotice).toBeUndefined();
    expect(await state.store.listTransactions(state.owner.profileId)).toEqual([]);
    expect((await state.store.listPendingActions(state.owner.profileId)).filter(action => action.actionId === pending.actionId)).toHaveLength(1);
    const confirmed = await handleProfileTurn(state.owner, { text: "yes", clientId: `known-new-expense-yes-${currency}-${amount.replaceAll(".", "-")}`, replyToPayment: null }, state.deps);
    expect(confirmed.ledgerChanged).toBe(true);
    expect(await state.store.listTransactions(state.owner.profileId)).toMatchObject([{ type: "expense", amount, currency, description }]);
    expect((await state.store.getPendingAction("older-confirmation"))?.status).toBe("pending");
    expect((await state.store.getPendingAction("synthetic-payment-reply"))?.status).toBe("completed");
    expect((await state.bank.getMessage(state.owner.profileId, target.id))?.status).toBe("recorded");
    expect(state.interpret).not.toHaveBeenCalled();
  });

  it.each(["that was salary", "I spent 30 on maybe lunch", "I spent 30 on lunch and transport", "I spent thirty on lunch", "I spent 30 on school fees"])("does not broaden the natural new-expense escape to unclear or different requests (%s)", async text => {
    const state = setup(() => ({ type: "create_transaction", explicit: true, transactions: [{ transaction_type: "income", amount: "125.00", currency: "GHS", category: "Salary", description: "Invented salary", date: "2026-11-03", payment_method: "", notes: "" }] }));
    const target = await state.payment(1, { status: "recorded" });
    await state.notice(target, false);
    const result = await handleProfileTurn(state.owner, { text, clientId: `known-no-expense-escape-${text.replaceAll(" ", "-")}` }, state.deps);
    expect(result.ledgerChanged).toBe(false);
    expect(result.messages?.find(message => message.role === "assistant")?.paymentNotice).toEqual({ bankMessageId: target.id, requiresPurpose: false });
    expect(await state.store.listTransactions(state.owner.profileId)).toEqual([]);
    expect(await state.store.listPendingActions(state.owner.profileId)).toEqual([]);
  });

  it("keeps the exact target after an unclear reply, then accepts a clear purpose", async () => {
    const state = setup();
    const older = await state.payment(1);
    const target = await state.payment(2);
    await state.bank.updateMessage(state.owner.profileId, older.id, { askedAt: NOW.toISOString() });
    await state.notice(target);
    await handleProfileTurn(state.owner, { text: "not sure", clientId: "purpose-clarify-first" }, state.deps);
    await handleProfileTurn(state.owner, { text: "It was for freelance work", clientId: "purpose-clarify-second" }, state.deps);
    expect(state.interpret.mock.calls[0][0].waiting?.current).toBe(2);
    expect((await state.bank.getMessage(state.owner.profileId, target.id))?.status).toBe("recorded");
    expect((await state.bank.getMessage(state.owner.profileId, older.id))?.status).toBe("needs_label");
  });

  it("keeps model-read alerts tentative and points to Review when reasking", async () => {
    const state = setup();
    const target = await state.payment(1, { readBy: "model", kind: "unknown" });
    await state.notice(target);
    const result = await handleProfileTurn(state.owner, { text: "not sure", clientId: "purpose-possible-alert-reask" }, state.deps);
    expect(result.text).toContain("possible payment alert");
    expect(result.text).toContain("Review");
    expect(result.text).not.toContain("received");
    expect(result.ledgerChanged).toBe(false);
    expect(await state.store.listTransactions(state.owner.profileId)).toEqual([]);
  });

  it("uses the question actually displayed when a newer notice arrives before Send", async () => {
    const state = setup();
    const shown = await state.payment(1);
    const newer = await state.payment(2);
    const visible = await state.notice(shown);
    await state.notice(newer);
    const result = await handleProfileTurn(state.owner, { text: "It was for freelance work", clientId: "purpose-visible-question", replyToPayment: visible.paymentNotice }, state.deps);
    expect(state.interpret.mock.calls[0][0].waiting?.current).toBe(1);
    expect(result.ledgerChanged).toBe(true);
    expect((await state.bank.getMessage(state.owner.profileId, shown.id))?.status).toBe("recorded");
    expect((await state.bank.getMessage(state.owner.profileId, newer.id))?.status).toBe("needs_label");
  });

  it("keeps the original saved reply reference on a refreshed failed retry", async () => {
    const state = setup();
    const original = await state.payment(1);
    const newer = await state.payment(2);
    const originalNotice = await state.notice(original);
    const clientId = "purpose-refresh-original-reference";
    await state.messages.append({ ownerId: state.owner.profileId, role: "user", channel: "web", body: "freelance work", clientId, paymentNotice: originalNotice.paymentNotice });
    const newerNotice = await state.notice(newer);
    await handleProfileTurn(state.owner, { text: "freelance work", clientId, replyToPayment: newerNotice.paymentNotice }, state.deps);
    expect(state.interpret.mock.calls[0][0].waiting?.current).toBe(1);
    expect((await state.bank.getMessage(state.owner.profileId, original.id))?.status).toBe("recorded");
    expect((await state.bank.getMessage(state.owner.profileId, newer.id))?.status).toBe("needs_label");
  });

  it("does not bind an unseen newly arrived notice when the client explicitly sends null", async () => {
    const state = setup(() => ({ type: "label_payments", answers: [{ items: [1], action: "category", category: "Business", description: "freelance work" }] }));
    const target = await state.payment(1);
    await olderConfirmation(state);
    await state.notice(target);
    const result = await handleProfileTurn(state.owner, { text: "freelance work", clientId: "purpose-unseen-null", replyToPayment: null }, state.deps);
    expect(state.interpret.mock.calls[0][0].waiting?.current).toBe(0);
    expect(result.ledgerChanged).toBe(false);
    expect((await state.store.getPendingAction("older-confirmation"))?.status).toBe("pending");
    expect(await state.store.listTransactions(state.owner.profileId)).toEqual([]);
    expect((await state.bank.getMessage(state.owner.profileId, target.id))?.status).toBe("needs_label");
    expect(result.messages?.find(message => message.role === "assistant")?.paymentNotice).toEqual({ bankMessageId: target.id, requiresPurpose: false });
  });

  it("does not add a new payment binding to an originally unbound saved retry", async () => {
    const state = setup(() => ({ type: "label_payments", answers: [{ items: [1], action: "category", category: "Business", description: "freelance work" }] }));
    const clientId = "purpose-refresh-original-null";
    await state.messages.append({ ownerId: state.owner.profileId, role: "user", channel: "web", body: "freelance work", clientId });
    const target = await state.payment(1);
    const latest = await state.notice(target);
    const result = await handleProfileTurn(state.owner, { text: "freelance work", clientId, replyToPayment: latest.paymentNotice }, state.deps);
    expect(result.ledgerChanged).toBe(false);
    expect(state.interpret.mock.calls[0][0].waiting?.current).toBe(0);
    expect(await state.store.listTransactions(state.owner.profileId)).toEqual([]);
  });

  it("preserves an ordinary bank question when explicit null means no automation notice was displayed", async () => {
    const state = setup();
    const target = await state.payment(1);
    await state.bank.updateMessage(state.owner.profileId, target.id, { askedAt: NOW.toISOString() });
    await state.messages.append({ ownerId: state.owner.profileId, role: "assistant", channel: "web", body: "What was this payment for?", intent: "bank:label" });
    const result = await handleProfileTurn(state.owner, { text: "freelance work", clientId: "purpose-ordinary-null", replyToPayment: null }, state.deps);
    expect(result.ledgerChanged).toBe(true);
    expect(state.interpret.mock.calls[0][0].waiting?.current).toBe(1);
  });

  it("starts an explicit independent topic without targeting old payments, confirmations, or chat history", async () => {
    const state = setup(() => ({ type: "create_transaction", explicit: true, transactions: [{
      transaction_type: "expense", amount: "9.00", currency: "GHS", category: "Food", description: "Fictional new lunch", date: "2026-11-03", payment_method: "Cash", notes: "",
    }] }));
    const target = await state.payment(1);
    await state.bank.updateMessage(state.owner.profileId, target.id, { askedAt: NOW.toISOString() });
    await olderConfirmation(state);
    await state.notice(target);
    const input = { text: "Log a new cash expense of 9 for lunch", clientId: "purpose-new-topic-expense", replyToPayment: null, newTopic: true };
    const first = await handleProfileTurn(state.owner, input, state.deps);
    const replay = await handleProfileTurn(state.owner, input, state.deps);
    const request = state.interpret.mock.calls[0][0];
    expect(request.waiting).toBeNull();
    expect(request.open).toEqual([]);
    expect(request.history).toEqual([]);
    expect(first.ledgerChanged).toBe(true);
    expect(replay.ledgerChanged).toBe(true);
    expect(await state.store.listTransactions(state.owner.profileId)).toMatchObject([{ description: "Fictional new lunch", amount: "9.00" }]);
    expect((await state.bank.getMessage(state.owner.profileId, target.id))?.status).toBe("needs_label");
    expect((await state.store.getPendingAction("older-confirmation"))?.status).toBe("pending");
    expect(first.messages?.find(message => message.role === "user")?.newTopic).toBe(true);
    expect(first.messages?.find(message => message.role === "assistant")?.paymentNotice).toBeUndefined();
    expect(state.interpret).toHaveBeenCalledTimes(1);
  });

  it("preserves a saved new-topic gesture across a refreshed retry after a new alert", async () => {
    const state = setup(() => ({ type: "create_transaction", explicit: true, transactions: [{
      transaction_type: "expense", amount: "9.00", currency: "GHS", category: "Food", description: "Fictional new lunch", date: "2026-11-03", payment_method: "Cash", notes: "",
    }] }));
    const clientId = "purpose-new-topic-saved-retry";
    await state.messages.append({ ownerId: state.owner.profileId, role: "user", channel: "web", body: "Log a new cash expense of 9 for lunch", clientId, newTopic: true });
    const target = await state.payment(1);
    const latest = await state.notice(target);
    const result = await handleProfileTurn(state.owner, { text: "Log a new cash expense of 9 for lunch", clientId, replyToPayment: latest.paymentNotice }, state.deps);
    expect(state.interpret.mock.calls[0][0].waiting).toBeNull();
    expect(result.ledgerChanged).toBe(true);
    expect(await state.store.listTransactions(state.owner.profileId)).toHaveLength(1);
    expect((await state.bank.getMessage(state.owner.profileId, target.id))?.status).toBe("needs_label");
  });

  it("confirms only a new topic's new pending expense after labelling a notice", async () => {
    let requests = 0;
    const state = setup(request => ++requests === 1
      ? { type: "label_payments", answers: [{ items: [request.waiting!.current], action: "category", category: "Business", description: "freelance work" }] }
      : { type: "create_transaction", explicit: false, transactions: [{
        transaction_type: "expense", amount: "9.00", currency: "GHS", category: "Food", description: "Fictional new lunch", date: "2026-11-03", payment_method: "Cash", notes: "",
      }] });
    const target = await state.payment(1);
    await olderConfirmation(state);
    await state.notice(target);
    await handleProfileTurn(state.owner, { text: "freelance work", clientId: "purpose-then-new-topic-label" }, state.deps);
    const pending = await handleProfileTurn(state.owner, { text: "I spent some cash on lunch", clientId: "purpose-then-new-topic-pending", newTopic: true, replyToPayment: null }, state.deps);
    expect(pending.actionId).toBe("synthetic-payment-reply");
    expect(pending.ledgerChanged).toBe(false);
    const confirmed = await handleProfileTurn(state.owner, { text: "yes", clientId: "purpose-confirm-new-topic", replyToPayment: null }, state.deps);
    expect(confirmed.ledgerChanged).toBe(true);
    expect(await state.store.listTransactions(state.owner.profileId)).toHaveLength(2);
    expect((await state.store.listTransactions(state.owner.profileId)).filter(item => item.type === "expense")).toMatchObject([{ description: "Fictional new lunch", amount: "9.00" }]);
    expect((await state.store.getPendingAction("synthetic-payment-reply"))?.status).toBe("completed");
    expect((await state.store.getPendingAction("older-confirmation"))?.status).toBe("pending");
    expect(state.interpret).toHaveBeenCalledTimes(2);
  });

  it("does not let undo after a new notice reverse an unrelated previous label batch", async () => {
    const state = setup();
    const filed = await state.payment(1, { status: "recorded" });
    const transaction = await state.store.appendTransaction(expense());
    await state.bank.saveUndo(state.owner.profileId, [{ messageId: filed.id, previous: { status: "needs_label", kind: "payment" }, transactionIds: [transaction.transactionId] }]);
    const target = await state.payment(2);
    await state.notice(target);
    const result = await handleProfileTurn(state.owner, { text: "undo", clientId: "purpose-no-unrelated-undo" }, state.deps);
    expect(result.ledgerChanged).toBe(false);
    expect(result.text).toContain("haven't undone anything");
    expect((await state.store.listTransactions(state.owner.profileId))[0].status).toBe("active");
    expect((await state.bank.getMessage(state.owner.profileId, filed.id))?.status).toBe("recorded");
    expect(await state.bank.peekUndo(state.owner.profileId, new Date(NOW.getTime() - 30 * 60_000))).not.toBeNull();
    expect(state.interpret).not.toHaveBeenCalled();
  });

  it.each(["known", "foreign", "stale"] as const)("never substitutes a newer question for an explicit %s displayed reference", async kind => {
    const state = setup(() => ({ type: "label_payments", answers: [{ items: [1], action: "category", category: "Business", description: "freelance work" }] }));
    const current = await state.payment(1);
    const shown = await state.payment(2, kind === "foreign" ? { ownerId: "77" } : {});
    if (kind === "stale") await state.bank.updateMessage(state.owner.profileId, shown.id, { status: "recorded" });
    await state.notice(current);
    const result = await handleProfileTurn(state.owner, { text: "freelance work", clientId: `purpose-displayed-${kind}`,
      replyToPayment: { bankMessageId: shown.id, requiresPurpose: kind !== "known" },
    }, state.deps);
    expect(state.interpret.mock.calls[0][0].waiting?.current).toBe(0);
    expect(result.ledgerChanged).toBe(false);
    expect(await state.store.listTransactions(state.owner.profileId)).toEqual([]);
    expect((await state.bank.getMessage(state.owner.profileId, current.id))?.status).toBe("needs_label");
  });

  it("does not learn a permanent rule or file other payments from the same person", async () => {
    const state = setup();
    const other = await state.payment(1, { counterparty: "FICTIONAL SAME PAYER", amount: "70.00" });
    const target = await state.payment(2, { counterparty: "FICTIONAL SAME PAYER" });
    await state.notice(target);
    const result = await handleProfileTurn(state.owner, { text: "freelance work", clientId: "purpose-only-one-same-payer" }, state.deps);
    expect(result.text).not.toContain("from now on");
    expect(state.bank.rules.size).toBe(0);
    expect(await state.store.listTransactions(state.owner.profileId)).toHaveLength(1);
    expect((await state.bank.getMessage(state.owner.profileId, other.id))?.status).toBe("needs_label");
  });

  it("accepts only a bounded explicit displayed-payment reference in text requests", () => {
    const valid = { text: "freelance work", clientId: "purpose-schema-fixture", replyToPayment: { bankMessageId: "00000000-0000-4000-9000-000000000001", requiresPurpose: true } };
    expect(chatTextSchema.safeParse(valid).success).toBe(true);
    expect(chatTextSchema.safeParse({ ...valid, replyToPayment: null }).success).toBe(true);
    expect(chatTextSchema.safeParse({ ...valid, newTopic: true }).success).toBe(true);
    expect(chatTextSchema.safeParse({ ...valid, newTopic: "yes" }).success).toBe(false);
    expect(chatTextSchema.safeParse({ ...valid, replyToPayment: { ...valid.replyToPayment, bankMessageId: "not-an-id" } }).success).toBe(false);
    expect(chatTextSchema.safeParse({ ...valid, replyToPayment: { ...valid.replyToPayment, requiresPurpose: "true" } }).success).toBe(false);
    expect(chatTextSchema.safeParse({ ...valid, replyToPayment: { ...valid.replyToPayment, ownerId: "77" } }).success).toBe(false);
    expect(chatChoiceSchema.safeParse({ choice: `b:${valid.replyToPayment.bankMessageId}:c1`, clientId: valid.clientId, replyToPayment: valid.replyToPayment }).success).toBe(true);
  });

  it("files a displayed notice's tapped category once without learning or touching the same payer's other payments", async () => {
    const state = setup();
    const other = await state.payment(1, { counterparty: "FICTIONAL SAME PAYER" });
    const target = await state.payment(2, { counterparty: "FICTIONAL SAME PAYER" });
    const visible = await state.notice(target);
    const business = (await openChoices(state.owner, state.deps, visible)).flat().find(choice => choice.label === "Business")!;
    // Another notice may land after the question was displayed.
    await state.notice(other);
    const input = { choice: business.choice!, clientId: "purpose-choice-exact-once", replyToPayment: visible.paymentNotice };
    const first = await handleProfileTurn(state.owner, input, state.deps);
    const replay = await handleProfileTurn(state.owner, input, state.deps);
    expect(first.ledgerChanged).toBe(true);
    expect(replay.text).toBe(first.text);
    expect(await state.store.listTransactions(state.owner.profileId)).toHaveLength(1);
    expect((await state.bank.getMessage(state.owner.profileId, target.id))?.status).toBe("recorded");
    expect((await state.bank.getMessage(state.owner.profileId, other.id))?.status).toBe("needs_label");
    expect(state.bank.rules.size).toBe(0);
    expect(state.interpret).not.toHaveBeenCalled();
  });

  it.each(["mismatched", "known", "foreign", "stale"] as const)("rejects a %s displayed payment choice without changing finances", async kind => {
    const state = setup();
    const target = await state.payment(1);
    const other = await state.payment(2, kind === "foreign" ? { ownerId: "77" } : {});
    if (kind === "stale") await state.bank.updateMessage(state.owner.profileId, other.id, { status: "recorded" });
    const visible = await state.notice(kind === "mismatched" || kind === "known" ? target : other, kind !== "known");
    const id = kind === "mismatched" ? other.id : visible.paymentNotice!.bankMessageId;
    const before = await state.bank.listMessages(state.owner.profileId);
    const result = await handleProfileTurn(state.owner, { choice: `b:${id}:c1`, clientId: `purpose-choice-${kind}`, replyToPayment: visible.paymentNotice }, state.deps);
    expect(result.ledgerChanged).toBe(false);
    expect(await state.store.listTransactions(state.owner.profileId)).toEqual([]);
    expect(await state.bank.listMessages(state.owner.profileId)).toEqual(before);
    expect(state.bank.rules.size).toBe(0);
    expect(state.interpret).not.toHaveBeenCalled();
  });

  it("rejects a choice from an unseen new notice when the displayed binding is explicitly null", async () => {
    const state = setup();
    const target = await state.payment(1);
    await state.notice(target);
    const result = await handleProfileTurn(state.owner, { choice: `b:${target.id}:c1`, clientId: "purpose-choice-unseen-null", replyToPayment: null }, state.deps);
    expect(result.ledgerChanged).toBe(false);
    expect(await state.store.listTransactions(state.owner.profileId)).toEqual([]);
    expect((await state.bank.getMessage(state.owner.profileId, target.id))?.status).toBe("needs_label");
  });

  it("rejects a model's different payment for an otherwise bare purpose reply", async () => {
    const state = setup(() => ({ type: "label_payments", answers: [{ items: [1], action: "category", category: "Business", description: "freelance work" }] }));
    const older = await state.payment(1);
    const target = await state.payment(2);
    await state.bank.updateMessage(state.owner.profileId, older.id, { askedAt: NOW.toISOString() });
    await state.notice(target);
    const result = await handleProfileTurn(state.owner, { text: "freelance work", clientId: "purpose-wrong-resolver" }, state.deps);
    expect(result.text).toContain("haven't changed this payment");
    expect(result.ledgerChanged).toBe(false);
    expect(await state.store.listTransactions(state.owner.profileId)).toEqual([]);
    expect(result.messages?.find(message => message.role === "assistant")?.paymentNotice).toEqual({ bankMessageId: target.id, requiresPurpose: true });
  });

  it("does not mistake a repeated amount for permission to label another waiting payment", async () => {
    const state = setup(() => ({ type: "label_payments", answers: [{ items: [1], action: "category", category: "Business", description: "freelance work" }] }));
    const older = await state.payment(1);
    const target = await state.payment(2);
    await state.notice(target);
    const result = await handleProfileTurn(state.owner, { text: "That 125 was for freelance work", clientId: "purpose-repeated-amount" }, state.deps);
    expect(result.ledgerChanged).toBe(false);
    expect(await state.store.listTransactions(state.owner.profileId)).toEqual([]);
    expect((await state.bank.getMessage(state.owner.profileId, older.id))?.status).toBe("needs_label");
    expect((await state.bank.getMessage(state.owner.profileId, target.id))?.status).toBe("needs_label");
  });

  it.each([false, true])("does not create a duplicate income when a purpose resolver returns a new transaction (mixed=%s)", async mixed => {
    const duplicate: FinanceAction = { type: "create_transaction", explicit: true, transactions: [{
      transaction_type: "income", amount: "125.00", currency: "GHS", category: "Business", description: "freelance work", date: "2026-11-03", payment_method: "", notes: "",
    }] };
    const state = setup(request => mixed ? { type: "several", actions: [
      { type: "label_payments", answers: [{ items: [request.waiting!.current], action: "category", category: "Business", description: "freelance work" }] }, duplicate,
    ] } : duplicate);
    const target = await state.payment(1);
    await state.notice(target);
    const input = { text: "It was for freelance work", clientId: `purpose-block-duplicate-${mixed}` };
    const first = await handleProfileTurn(state.owner, input, state.deps);
    const replay = await handleProfileTurn(state.owner, input, state.deps);
    expect(first.text).toContain("captured payment");
    expect(first.ledgerChanged).toBe(false);
    expect(replay.ledgerChanged).toBe(false);
    expect(await state.store.listTransactions(state.owner.profileId)).toEqual([]);
    expect((await state.bank.getMessage(state.owner.profileId, target.id))?.status).toBe("needs_label");
    expect(state.bank.rules.size).toBe(0);
    expect(first.messages?.find(message => message.role === "assistant")?.paymentNotice).toEqual({ bankMessageId: target.id, requiresPurpose: true });
    expect(state.interpret).toHaveBeenCalledTimes(1);
  });

  it.each(["known", "settled", "foreign", "missing"] as const)("blocks a model-created income even when a %s notice has no open current payment", async kind => {
    const state = setup(() => ({ type: "create_transaction", explicit: true, transactions: [{
      transaction_type: "income", amount: "125.00", currency: "GHS", category: "Salary", description: "Fictional salary", date: "2026-11-03", payment_method: "", notes: "",
    }] }));
    const target = await state.payment(1, kind === "foreign" ? { ownerId: "77" } : {});
    if (kind === "settled") await state.bank.updateMessage(state.owner.profileId, target.id, { status: "recorded" });
    const last = await state.notice(kind === "missing" ? { ...target, id: "00000000-0000-4000-9000-999999999999" } : target, kind !== "known");
    const result = await handleProfileTurn(state.owner, { text: "That was salary", clientId: `purpose-closed-create-${kind}`, replyToPayment: last.paymentNotice }, state.deps);
    expect(result.ledgerChanged).toBe(false);
    expect(result.text).toContain("Nothing was changed");
    expect(await state.store.listTransactions(state.owner.profileId)).toEqual([]);
    expect(await state.store.listPendingActions(state.owner.profileId)).toEqual([]);
  });

  it("does not turn a purpose answer into a model-guessed budget write", async () => {
    const state = setup(() => ({ type: "set_budget", category: "Food", amount: "125.00", currency: "GHS", period: "2026-11" }));
    const target = await state.payment(1);
    await state.notice(target);
    const result = await handleProfileTurn(state.owner, { text: "It was for food", clientId: "purpose-block-budget-guess" }, state.deps);
    expect(result.ledgerChanged).toBe(false);
    expect(await state.store.listBudgets(state.owner.profileId)).toEqual([]);
    expect((await state.bank.getMessage(state.owner.profileId, target.id))?.status).toBe("needs_label");
  });

  it("keeps a settled acknowledgement bound and cannot confirm an older action with a later yes", async () => {
    const state = setup();
    const target = await state.payment(1);
    await olderConfirmation(state);
    await state.notice(target);
    const filed = await handleProfileTurn(state.owner, { text: "freelance work", clientId: "purpose-settled-ack" }, state.deps);
    const ack = filed.messages?.find(message => message.role === "assistant");
    expect(ack?.paymentNotice).toEqual({ bankMessageId: target.id, requiresPurpose: false });
    expect(filed.choices).toEqual([]);
    const yes = await handleProfileTurn(state.owner, { text: "yes", clientId: "purpose-after-ack-yes", replyToPayment: ack?.paymentNotice }, state.deps);
    expect(yes.ledgerChanged).toBe(false);
    expect(await state.store.listTransactions(state.owner.profileId)).toHaveLength(1);
    expect((await state.store.getPendingAction("older-confirmation"))?.status).toBe("pending");
  });

  it.each(["known", "settled", "foreign", "missing"] as const)("never falls back to an older payment or confirmation for a %s notice", async kind => {
    const state = setup(() => ({ type: "label_payments", answers: [{ items: [1], action: "category", category: "Business", description: "freelance work" }] }));
    const older = await state.payment(1);
    const target = await state.payment(2, kind === "foreign" ? { ownerId: "77" } : {});
    if (kind === "settled") await state.bank.updateMessage(state.owner.profileId, target.id, { status: "recorded" });
    await state.bank.updateMessage(state.owner.profileId, older.id, { askedAt: NOW.toISOString() });
    await olderConfirmation(state);
    const last = await state.notice(kind === "missing" ? { ...target, id: "00000000-0000-4000-9000-999999999999" } : target, kind !== "known");
    expect(await openChoices(state.owner, state.deps, last)).toEqual([]);
    const vague = await handleProfileTurn(state.owner, { text: "yes", clientId: `purpose-${kind}-yes` }, state.deps);
    expect(vague.ledgerChanged).toBe(false);
    const named = await handleProfileTurn(state.owner, { text: "freelance work", clientId: `purpose-${kind}-reply` }, state.deps);
    expect(named.ledgerChanged).toBe(false);
    expect(state.interpret.mock.calls[0][0].waiting?.current).toBe(0);
    expect(state.interpret.mock.calls[0][0].open?.join(" ")).not.toContain("still open");
    expect(await state.store.listTransactions(state.owner.profileId)).toEqual([]);
    expect((await state.store.getPendingAction("older-confirmation"))?.status).toBe("pending");
    expect((await state.bank.getMessage(state.owner.profileId, older.id))?.status).toBe("needs_label");
  });

  it("does not expose recently filed correction targets when a notice has no open question", async () => {
    const state = setup();
    const filed = await state.payment(1, { status: "recorded" });
    await state.bank.saveUndo(state.owner.profileId, [{ messageId: filed.id, previous: { status: "needs_label", kind: "payment" }, transactionIds: [] }]);
    expect(await waitingPayments(state.ingest, state.owner)).not.toBeNull();
    expect(await waitingPayments(state.ingest, state.owner, { currentMessageId: null })).toBeNull();
  });

  it("retains the exact question through an outage without adding a financial write", async () => {
    let calls = 0;
    const state = setup(request => {
      if (++calls === 1) throw new AiError("unavailable", "Fictional model outage");
      return { type: "label_payments", answers: [{ items: [request.waiting!.current], action: "category", category: "Business", description: "freelance work" }] };
    });
    const older = await state.payment(1);
    const target = await state.payment(2);
    await state.bank.updateMessage(state.owner.profileId, older.id, { askedAt: NOW.toISOString() });
    await state.notice(target);
    const outage = await handleProfileTurn(state.owner, { text: "freelance work", clientId: "purpose-outage-first" }, state.deps);
    expect(outage.ledgerChanged).toBe(false);
    expect(outage.messages?.find(message => message.role === "assistant")?.paymentNotice).toEqual({ bankMessageId: target.id, requiresPurpose: true });
    expect(await state.store.listTransactions(state.owner.profileId)).toEqual([]);
    const next = await handleProfileTurn(state.owner, { text: "freelance work", clientId: "purpose-outage-second" }, state.deps);
    expect(next.ledgerChanged).toBe(true);
    expect(state.interpret.mock.calls[1][0].waiting?.current).toBe(2);
    expect((await state.bank.getMessage(state.owner.profileId, older.id))?.status).toBe("needs_label");
  });
});

describe("leaving a closed payment notice", () => {
  const expenseAction = (amount = "30.00", category = "Food", description = "lunch"): FinanceAction => ({ type: "create_transaction", explicit: true, transactions: [{ transaction_type: "expense", amount, currency: "GHS", category, description, date: "2026-11-03", payment_method: "", notes: "" }] });
  const budgetAction: FinanceAction = { type: "set_budget", amount: "500.00", currency: "GHS", category: "Food", period: "2026-11" };

  it.each([["spent 30 on lunch", "30.00", "Food", "lunch"], ["lunch 30", "30.00", "Food", "lunch"], ["paid 50 for an uber", "50.00", "Transport", "uber"]])("confirms an ordinary independent expense (%s) then continues normally", async (text, amount, category, description) => {
    let calls = 0;
    const state = setup(() => ++calls === 1 ? expenseAction(amount, category, description) : { type: "chat", message: "Hello. How can I help?", topic: "other" });
    const target = await state.payment(1, { status: "recorded" });
    await olderConfirmation(state);
    const notice = await state.notice(target, false);
    const pending = await handleProfileTurn(state.owner, { text, clientId: "ordinary-expense-request", replyToPayment: notice.paymentNotice }, state.deps);
    expect(pending.actionId).toBe("synthetic-payment-reply");
    expect(pending.messages?.find(row => row.role === "assistant")).toMatchObject({ newTopic: true, paymentNotice: undefined });
    expect(await state.store.listTransactions(state.owner.profileId)).toEqual([]);
    const yes = await handleProfileTurn(state.owner, { text: "yes", clientId: "ordinary-expense-confirm", replyToPayment: null }, state.deps);
    expect(yes.ledgerChanged).toBe(true);
    expect(await state.store.listTransactions(state.owner.profileId)).toMatchObject([{ type: "expense", amount, category, description }]);
    expect((await state.store.getPendingAction("older-confirmation"))?.status).toBe("pending");
    const followup = await handleProfileTurn(state.owner, { text: "hello", clientId: "ordinary-expense-followup", replyToPayment: null }, state.deps);
    expect(followup.text).toContain("Hello");
    expect(followup.messages?.find(row => row.role === "assistant")?.paymentNotice).toBeUndefined();
    expect(state.interpret.mock.calls[1][0].open?.join(" ")).not.toContain("still open");
  });

  it("uses the normal budget confirmation and confirms the new budget only", async () => {
    const state = setup(() => budgetAction);
    const target = await state.payment(1, { status: "recorded" });
    await olderConfirmation(state);
    const notice = await state.notice(target, false);
    const pending = await handleProfileTurn(state.owner, { text: "set my food budget to 500", clientId: "ordinary-budget-request", replyToPayment: notice.paymentNotice }, state.deps);
    expect(pending.actionId).toBe("synthetic-payment-reply");
    expect(pending.ledgerChanged).toBe(false);
    expect(await state.store.listBudgets(state.owner.profileId)).toEqual([]);
    const yes = await handleProfileTurn(state.owner, { text: "yes", clientId: "ordinary-budget-confirm", replyToPayment: null }, state.deps);
    expect(yes.ledgerChanged).toBe(true);
    expect(await state.store.listBudgets(state.owner.profileId)).toMatchObject([{ category: "Food", amount: "500.00" }]);
    expect(await state.store.listTransactions(state.owner.profileId)).toEqual([]);
    expect((await state.store.getPendingAction("older-confirmation"))?.status).toBe("pending");
  });

  it.each(["hello", "weather"])("drops closed focus after safe %s but never revives an older confirmation", async text => {
    let calls = 0;
    const state = setup(() => ++calls === 1 ? { type: "chat", message: "Hello. Would you like to chat?", topic: "other" } : { type: "answer_confirmation", decision: "confirm" });
    const target = await state.payment(1, { status: "recorded" });
    await olderConfirmation(state);
    const notice = await state.notice(target, false);
    const reply = await handleProfileTurn(state.owner, { text, clientId: `safe-boundary-${text}`, replyToPayment: notice.paymentNotice }, state.deps);
    expect(reply.messages?.find(row => row.role === "assistant")).toMatchObject({ newTopic: true, paymentNotice: undefined });
    const yes = await handleProfileTurn(state.owner, { text: "yes", clientId: `safe-boundary-yes-${text}`, replyToPayment: null }, state.deps);
    expect(yes.ledgerChanged).toBe(false);
    expect(yes.text).toContain("nothing waiting for a yes or no");
    expect(await state.store.listTransactions(state.owner.profileId)).toEqual([]);
    expect((await state.store.getPendingAction("older-confirmation"))?.status).toBe("pending");
    expect(state.interpret.mock.calls[1][0].open?.join(" ")).not.toContain("still open");
  });

  it.each([null, "bad!client"])("fails closed when a boundary's supposed confirmation client is %s", async clientId => {
    const state = setup(() => ({ type: "answer_confirmation", decision: "confirm" }));
    await olderConfirmation(state);
    await state.messages.append({ ownerId: state.owner.profileId, role: "assistant", body: "Confirm or cancel.", channel: "web", clientId, intent: "create_transaction", newTopic: true });
    const result = await handleProfileTurn(state.owner, { text: "yes", clientId: "boundary-malformed-confirm", replyToPayment: null }, state.deps);
    expect(result.ledgerChanged).toBe(false);
    expect((await state.store.getPendingAction("older-confirmation"))?.status).toBe("pending");
    expect(await state.store.listTransactions(state.owner.profileId)).toEqual([]);
  });

  it.each([false, true])("matches a combined confirmation by origin/type and refuses ambiguity (ambiguous=%s)", async ambiguous => {
    const state = setup(() => ({ type: "answer_confirmation", decision: "confirm" }));
    await olderConfirmation(state);
    const clientId = "combined-boundary-turn";
    const originUpdateId = String(clientTurnUpdateId(clientId));
    await state.store.appendPendingAction({ actionId: "combined-budget-action", userId: state.owner.profileId, chatId: "0", actionType: "set_budget", status: "pending", createdAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 60_000).toISOString(), payloadJson: JSON.stringify({ type: "set_budget", originUpdateId, category: "Food", amount: "500.00", currency: "GHS", period: "2026-11" }) });
    if (ambiguous) await state.store.appendPendingAction({ actionId: "combined-second-action", userId: state.owner.profileId, chatId: "0", actionType: "create_transaction", status: "pending", createdAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 60_000).toISOString(), payloadJson: JSON.stringify({ type: "create_transaction", originUpdateId, transactions: [] }) });
    await state.messages.append({ ownerId: state.owner.profileId, role: "assistant", body: "Confirm or cancel.", channel: "web", clientId, intent: ambiguous ? "set_budget+create_transaction" : "set_budget+help", newTopic: true });
    const result = await handleProfileTurn(state.owner, { text: "yes", clientId: "combined-boundary-confirm", replyToPayment: null }, state.deps);
    expect(result.ledgerChanged).toBe(!ambiguous);
    expect(await state.store.listBudgets(state.owner.profileId)).toHaveLength(ambiguous ? 0 : 1);
    expect((await state.store.getPendingAction("older-confirmation"))?.status).toBe("pending");
  });

  it.each(["invented expense", "invented budget", "wrong amount", "mixed income", "unrelated delete"])("keeps the barrier when the model proposes an %s", async kind => {
    const state = setup(() => kind === "invented budget" ? budgetAction
      : kind === "unrelated delete" ? { type: "delete_transaction", transaction_id: "3f2a1c4e-1111-4111-8111-111111111111", undo_last: false }
      : kind === "mixed income" ? { type: "several", actions: [expenseAction(), { type: "create_transaction", explicit: true, transactions: [{ transaction_type: "income", amount: "125.00", currency: "GHS", category: "Salary", description: "salary", date: "2026-11-03", payment_method: "", notes: "" }] }] }
      : expenseAction(kind === "wrong amount" ? "300.00" : "30.00"));
    const target = await state.payment(1, { status: "recorded" });
    await olderConfirmation(state);
    const notice = await state.notice(target, false);
    const text = kind === "invented expense" || kind === "invented budget" ? "hello" : kind === "unrelated delete" ? "delete my last expense" : "lunch 30";
    const result = await handleProfileTurn(state.owner, { text, clientId: `closed-unsafe-${kind.replaceAll(" ", "-")}`, replyToPayment: notice.paymentNotice }, state.deps);
    expect(result.ledgerChanged).toBe(false);
    expect(result.messages?.find(row => row.role === "assistant")?.paymentNotice).toEqual(notice.paymentNotice);
    expect(await state.store.listTransactions(state.owner.profileId)).toEqual([]);
    expect(await state.store.listBudgets(state.owner.profileId)).toEqual([]);
    expect(await state.store.listPendingActions(state.owner.profileId)).toHaveLength(1);
  });
});

describe("natural incoming payment purposes", () => {
  it.each([
    ["birthday money from grandma", "Gift", "birthday gift from grandma"],
    ["birthday cash from grandpa", "Gift", "birthday cash from grandpa"],
    ["money for my birthday from mum", "Gift", "birthday gift from mum"],
    ["grandma sent me Christmas money", "Gift", "Christmas money from grandma"],
    ["graduation money from my aunt", "Gift", "graduation money from my aunt"],
    ["my grandmother gifted me money", "Gift", "Gift from my grandmother"],
    ["I think it was birthday money from grandma", "Gift", "birthday gift from grandma"],
    ["rent from my tenant", "Business", "rental income"],
    ["my tenant paid their rent", "Business", "rental income from my tenant"],
    ["rental income", "Business", "rental income"],
    ["probably rent from my tenant", "Business", "rental income from my tenant"],
  ])("files clear semantic purpose %s for the exact alert without a category bounce", async (text, category, description) => {
    const state = setup(request => ({ type: "label_payments", answers: [{ items: [request.waiting!.current], action: "category", category, description }] }));
    const other = await state.payment(1, { counterparty: "FICTIONAL SAME PAYER" });
    const target = await state.payment(2, { counterparty: "FICTIONAL SAME PAYER" });
    await olderConfirmation(state);
    await state.notice(target);
    const input = { text, clientId: `natural-${text.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` };
    const first = await handleProfileTurn(state.owner, input, state.deps);
    const replay = await handleProfileTurn(state.owner, input, state.deps);
    expect(first.ledgerChanged).toBe(true);
    expect(first.text).toContain(`under ${category}`);
    expect(first.text).not.toMatch(/was it a gift|what was it|verified|settled|received/i);
    expect(replay.text).toBe(first.text);
    expect(await state.store.listTransactions(state.owner.profileId)).toMatchObject([{ category, description, amount: "125.00", type: "income" }]);
    expect((await state.bank.getMessage(state.owner.profileId, target.id))?.status).toBe("recorded");
    expect((await state.bank.getMessage(state.owner.profileId, other.id))?.status).toBe("needs_label");
    expect(state.bank.rules.size).toBe(0);
    expect((await state.store.getPendingAction("older-confirmation"))?.status).toBe("pending");
    expect(state.interpret).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(state.interpret.mock.calls[0][0].history)).not.toContain("FICTIONAL PRIVATE NOTICE BODY");
  });

  it.each([
    ["money from grandma", "Gift", "money from grandma"],
    ["birthday money to grandma", "Gift", "birthday gift"],
    ["birthday money for my sister", "Gift", "birthday gift"],
    ["holding birthday money from grandma", "Gift", "birthday gift"],
    ["school fees from dad", "Gift", "school fees from dad"],
    ["my sister's wedding contribution", "Gift", "wedding contribution"],
    ["rent deposit returned by my landlord", "Business", "rental income"],
    ["birthday cake sales", "Gift", "birthday gift"],
    ["birthday money from cake sales", "Gift", "birthday gift"],
    ["not birthday money from grandma", "Gift", "birthday gift"],
    ["maybe birthday money from grandma", "Gift", "birthday gift"],
    ["birthday money or a loan from grandma", "Gift", "birthday gift"],
    ["rent from my tenant or a loan", "Business", "rental income"],
    ["birthday money from grandma as a loan", "Gift", "birthday gift"],
    ["birthday money from grandma", "Business", "birthday money from grandma"],
    ["birthday money from grandma", "Gift", "Christmas gift from grandma"],
    ["rent from my tenant", "Salary", "salary"],
    ["rent from my tenant", "Business", "rental income from a second apartment"],
  ])("rejects unsupported type/detail for %s (%s / %s)", async (text, category, description) => {
    const state = setup(request => ({ type: "label_payments", answers: [{ items: [request.waiting!.current], action: "category", category, description }] }));
    const target = await state.payment(1);
    await state.notice(target);
    const result = await handleProfileTurn(state.owner, { text, clientId: `natural-unsupported-${text.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 48)}` }, state.deps);
    expect(result.ledgerChanged).toBe(false);
    expect(await state.store.listTransactions(state.owner.profileId)).toEqual([]);
    expect((await state.bank.getMessage(state.owner.profileId, target.id))?.status).toBe("needs_label");
    expect(state.bank.rules.size).toBe(0);
  });

  it.each(["he paid me back", "loan repayment from Fictional Payer", "returned the money I lent him", "he paid me back for the tickets"])("records an explicit repayment (%s) against a known matching debt only once", async text => {
    const state = setup(request => ({ type: "label_payments", answers: [{ items: [request.waiting!.current], action: "repaid" }] }));
    const loans = new MemoryLoanStore();
    state.deps.loans = loans;
    const other = await state.payment(1, { counterparty: "FICTIONAL PAYER" });
    const target = await state.payment(2, { counterparty: "FICTIONAL PAYER" });
    await loans.add(state.owner.profileId, { person: "FICTIONAL PAYER", kind: "lent", amount: "200.00", currency: "GHS", occurredAt: "2026-11-01T12:00:00.000Z", note: "Fictional existing debt", bankMessageId: null });
    await state.notice(target);
    const input = { text, clientId: `natural-repaid-${text.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` };
    const first = await handleProfileTurn(state.owner, input, state.deps);
    await handleProfileTurn(state.owner, input, state.deps);
    expect(first.ledgerChanged).toBe(true);
    expect(first.text).not.toContain("Was it a gift");
    expect((await state.bank.getMessage(state.owner.profileId, target.id))?.status).toBe("repaid");
    expect((await state.bank.getMessage(state.owner.profileId, other.id))?.status).toBe("needs_label");
    expect(await loans.list(state.owner.profileId)).toHaveLength(2);
    expect(loanBalances(await loans.list(state.owner.profileId))[0].owed).toBe("75.00");
    expect(await state.store.listTransactions(state.owner.profileId)).toEqual([]);
    expect(state.bank.rules.size).toBe(0);
    expect(state.interpret).toHaveBeenCalledTimes(1);
  });

  it("does not invent a loan or income for a repayment whose debt is unknown to this owner", async () => {
    const state = setup(request => ({ type: "label_payments", answers: [{ items: [request.waiting!.current], action: "repaid" }] }));
    const loans = new MemoryLoanStore();
    state.deps.loans = loans;
    await loans.add("77", { person: "FICTIONAL PAYER", kind: "lent", amount: "200.00", currency: "GHS", occurredAt: "2026-11-01T12:00:00.000Z", note: "Fictional other owner's debt", bankMessageId: null });
    const target = await state.payment(1, { counterparty: "FICTIONAL PAYER" });
    await state.notice(target);
    const result = await handleProfileTurn(state.owner, { text: "he paid me back", clientId: "natural-repaid-owner-isolation" }, state.deps);
    expect(result.ledgerChanged).toBe(false);
    expect(await loans.list(state.owner.profileId)).toEqual([]);
    expect(await state.store.listTransactions(state.owner.profileId)).toEqual([]);
    expect((await state.bank.getMessage(state.owner.profileId, target.id))?.status).toBe("needs_label");
  });
});

// An outgoing notice cannot use the incoming-only independent-expense escape.
describe('outgoing notice duplicate-expense barrier',()=>{
 const action:FinanceAction={type:'create_transaction',explicit:true,transactions:[{transaction_type:'expense',amount:'30.00',currency:'GHS',category:'Food',description:'lunch',date:'2026-11-03',payment_method:'',notes:''}]};
 it('derives direction from the owned source and does not log a captured outgoing expense again',async()=>{
  const state=setup(()=>action),captured=await state.payment(1,{direction:'out',status:'recorded'});
  const existing=await state.store.appendTransaction(expense({amount:'30.00',transactionDate:'2026-11-03'}));
  await state.bank.updateMessage(state.owner.profileId,captured.id,{transactionId:existing.transactionId});
  const notice=await state.notice(captured,false);
  const before=await state.store.listTransactions(state.owner.profileId);
  const reply=await handleProfileTurn(state.owner,{text:'I spent 30 on lunch',clientId:'outgoing-duplicate-expense',replyToPayment:notice.paymentNotice},state.deps);
  expect(reply.actionId).toBeUndefined();expect(reply.text).toContain('Nothing was changed');expect(await state.store.listTransactions(state.owner.profileId)).toEqual(before);
 });
 it('permits a separately requested expense after an explicit new-topic boundary',async()=>{
  const state=setup(()=>action),captured=await state.payment(1,{direction:'out',status:'recorded'});await state.notice(captured,false);
  const reply=await handleProfileTurn(state.owner,{text:'I spent 30 on lunch',clientId:'outgoing-new-topic-expense',newTopic:true,replyToPayment:null},state.deps);
  expect(reply.ledgerChanged).toBe(true);expect(await state.store.listTransactions(state.owner.profileId)).toMatchObject([{type:'expense',amount:'30.00',description:'lunch'}]);expect(reply.messages?.find(row=>row.role==='assistant')?.paymentNotice).toBeUndefined();
 });
});

describe("separate requests after a closed outgoing notice", () => {
  const draft = (type: "income" | "expense", amount = "500.00", category = "Salary", description = "salary", overrides: Record<string, unknown> = {}): FinanceAction => ({ type: "create_transaction", explicit: true, transactions: [{ transaction_type: type, amount, currency: "GHS", category, description, date: "2026-11-03", payment_method: "", notes: "", ...overrides }] });
  async function captured(state: ReturnType<typeof setup>, options: { amount?: string; principal?: string; fee?: string; linkedFee?: string } = {}) {
    const message = await state.payment(1, { direction: "out", status: "recorded", amount: options.amount ?? "30.00", fee: options.fee ?? "0.00" });
    const principal = await state.store.appendTransaction(expense({ amount: options.principal ?? options.amount ?? "30.00", transactionDate: "2026-11-03", sourceUpdateId: `bank:${message.id}` }));
    let feeId: string | undefined;
    if (options.linkedFee) feeId = (await state.store.appendTransaction(expense({ transactionId: "33333333-3333-4333-8333-333333333333", amount: options.linkedFee, category: "Fees", transactionDate: "2026-11-03", sourceUpdateId: `bank:${message.id}:fee` }))).transactionId;
    await state.bank.updateMessage(state.owner.profileId, message.id, { transactionId: principal.transactionId, ...(feeId ? { feeTransactionId: feeId } : {}) });
    return { message, notice: await state.notice(message, false) };
  }

  it("keeps repeated possible duplicates blocked, then confirms a different expense without reviving an older action", async () => {
    const state = setup(request => request.text === "yes" ? { type: "answer_confirmation", decision: "confirm" } : draft("expense", request.text.includes("50") ? "50.00" : "30.00", request.text.includes("50") ? "Transport" : "Food", request.text.includes("50") ? "transport" : "lunch"));
    const { notice } = await captured(state); await olderConfirmation(state);
    const before = await state.store.listTransactions(state.owner.profileId);
    for (const clientId of ["closed-out-duplicate-one", "closed-out-duplicate-two"]) {
      const refused = await handleProfileTurn(state.owner, { text: "I spent 30 on lunch", clientId, replyToPayment: notice.paymentNotice }, state.deps);
      expect(refused.text).toContain("Nothing was changed"); expect(refused.text).toContain("Ask something else");
      expect(refused.messages?.find(row => row.role === "assistant")?.paymentNotice).toEqual(notice.paymentNotice);
    }
    expect(await state.store.listTransactions(state.owner.profileId)).toEqual(before);
    const separate = await handleProfileTurn(state.owner, { text: "I spent 50 on transport", clientId: "closed-out-different-expense", replyToPayment: notice.paymentNotice }, state.deps);
    expect(separate.actionId).toBe("synthetic-payment-reply"); expect(separate.ledgerChanged).toBe(false);
    expect(separate.messages?.find(row => row.role === "assistant")).toMatchObject({ newTopic: true, paymentNotice: undefined });
    expect(await state.store.listTransactions(state.owner.profileId)).toEqual(before);
    await handleProfileTurn(state.owner, { text: "yes", clientId: "closed-out-different-yes", replyToPayment: null }, state.deps);
    expect(await state.store.listTransactions(state.owner.profileId)).toHaveLength(2);
    expect((await state.store.getPendingAction("older-confirmation"))?.status).toBe("pending");
    await handleProfileTurn(state.owner, { text: "yes", clientId: "closed-out-late-yes", replyToPayment: null }, state.deps);
    expect(await state.store.listTransactions(state.owner.profileId)).toHaveLength(2);
    expect((await state.store.getPendingAction("older-confirmation"))?.status).toBe("pending");
  });

  it.each(["25.00", "30.00", "5.00", "27.00", "32.00"])("protects principal, fee and combined captured amounts (%s)", async amount => {
    const state = setup(() => draft("expense", amount, "Food", "lunch"));
    const { notice } = await captured(state, { amount: "30.00", principal: "25.00", linkedFee: "2.00" });
    const before = await state.store.listTransactions(state.owner.profileId);
    const reply = await handleProfileTurn(state.owner, { text: `I spent ${amount} on lunch`, clientId: `closed-out-fee-${amount}`, replyToPayment: notice.paymentNotice }, state.deps);
    expect(reply.actionId).toBeUndefined(); expect(reply.text).toContain("Nothing was changed"); expect(await state.store.listTransactions(state.owner.profileId)).toEqual(before);
  });

  it.each([
    ["Record new salary income of GHS 500", "GHS", "2026-11-03"],
    ["I received GHS500 salary", "GHS", "2026-11-03"],
    ["I got 500 salary", "GHS", "2026-11-03"],
    ["salary500", "GHS", "2026-11-03"],
    ["Log salary income of usd 500", "USD", "2026-11-03"],
    ["Record salary income of GHS500 on 2026-11-02", "GHS", "2026-11-02"],
  ])("confirms an independently grounded income request (%s) and only its own action", async (text, currency, date) => {
    const state = setup(() => draft("income", "500.00", "Salary", "salary", { currency, date }));
    const { notice } = await captured(state); await olderConfirmation(state);
    const reply = await handleProfileTurn(state.owner, { text, clientId: `closed-out-income-${currency}-${date}`, replyToPayment: notice.paymentNotice }, state.deps);
    expect(reply.actionId).toBe("synthetic-payment-reply"); expect(reply.ledgerChanged).toBe(false);
    expect(reply.messages?.find(row => row.role === "assistant")).toMatchObject({ newTopic: true, paymentNotice: undefined });
    expect(await state.store.listTransactions(state.owner.profileId)).toHaveLength(1);
    const yes = { text: "yes", clientId: `closed-out-income-yes-${currency}-${date}`, replyToPayment: null };
    await handleProfileTurn(state.owner, yes, state.deps); await handleProfileTurn(state.owner, yes, state.deps);
    expect((await state.store.listTransactions(state.owner.profileId)).filter(row => row.type === "income")).toMatchObject([{ amount: "500.00", currency, transactionDate: date, category: "Salary" }]);
    expect((await state.store.getPendingAction("older-confirmation"))?.status).toBe("pending");
  });

  it.each([
    ["Record salary income of -500", {}], ["Record salary income of -GHS500", {}], ["Record salary income of −500", {}],
    ["Record salary income of GHS500 and tax 100", {}], ["Record salary income of GHS500 USD", {}],
    ["Record salary income of GHS500 on 2026-11-02", { date: "2026-11-03" }],
    ["Record salary income of GHS500 on 2026-11-02", { date: undefined }],
    ["Record salary income of GHS500 on 2026-11-31", { date: "2026-11-31" }],
    ["Record salary income of GHS500", { amount: "600.00" }], ["Record salary income of GHS500", { currency: "USD" }],
    ["Record income of GHS500 from dad", { category: "Gift", description: "gift" }],
    ["Record business500 for supplies", { category: "Business", description: "supplies" }],
    ["Record salary income of GHS500", { description: "未提供" }], ["Record salary income of GHS500", { notes: "invented detail" }],
    ["That was salary of GHS500", {}], ["Record income of GHS500 as a refund", { category: "Refund", description: "refund" }],
    ["Record salary income of GHS500 from a loan", {}], ["Maybe record salary income of GHS500", {}],
    ["I received500 gift on behalf of Aunt", { category: "Gift", description: "gift" }],
    ["Record salary income500 I owe Aunt", {}],
    ["gift500 for my friend", { category: "Gift", description: "gift" }],
    ["Record gift500 to my friend", { category: "Gift", description: "gift" }],
    ["I made500 gift for John", { category: "Gift", description: "gift" }],
    ["Record salary income of GHS 5 USD", { amount: "5.00" }],
  ] as [string, Record<string, unknown>][])("rejects ambiguous or model-invented independent income (%s)", async (text, overrides) => {
    const state = setup(() => draft("income", "500.00", "Salary", "salary", overrides));
    const { notice } = await captured(state); const before = await state.store.listTransactions(state.owner.profileId);
    const result = await handleProfileTurn(state.owner, { text, clientId: "closed-out-income-rejected", replyToPayment: notice.paymentNotice }, state.deps);
    expect(result.actionId).toBeUndefined(); expect(await state.store.listTransactions(state.owner.profileId)).toEqual(before);
  });

  it.each(["open-outgoing", "stale-closed-outgoing", "closed-incoming", "foreign-outgoing", "missing"])("keeps income held for %s source context", async kind => {
    const state = setup(() => draft("income"));
    const source = await state.payment(1, { direction: kind === "closed-incoming" ? "in" : "out", status: ["open-outgoing", "stale-closed-outgoing"].includes(kind) ? "needs_label" : "recorded", ...(kind === "foreign-outgoing" ? { ownerId: "foreign" } : {}) });
    const notice = await state.notice(source, kind === "open-outgoing");
    if (kind === "missing") state.deps.bank = null;
    const result = await handleProfileTurn(state.owner, { text: "Record salary income of GHS500", clientId: `closed-income-source-${kind}`, replyToPayment: notice.paymentNotice }, state.deps);
    expect(result.actionId).toBeUndefined(); expect(await state.store.listTransactions(state.owner.profileId)).toEqual([]);
  });

  it("does not use a full history scan or invent details to distinguish an outgoing expense", async () => {
    const state = setup(() => draft("expense", "50.00", "Transport", "未提供"));
    const { notice, message } = await captured(state);
    const lookup = vi.spyOn(state.store, "findTransactionsBySource");
    const reply = await handleProfileTurn(state.owner, { text: "I spent 50 on transport", clientId: "closed-out-invented-expense", replyToPayment: notice.paymentNotice }, state.deps);
    expect(reply.actionId).toBeUndefined(); expect(lookup).not.toHaveBeenCalled();
    expect((await state.bank.getMessage(state.owner.profileId, message.id))?.status).toBe("recorded");
  });

  it.each(["in", "out"] as const)("does not let a false closed flag bypass a server-open %s payment or revive old yes", async direction => {
    const state = setup(request => request.text === "yes" ? { type: "answer_confirmation", decision: "confirm" } : draft("expense", "50.00", "Transport", "transport"));
    const source = await state.payment(1, { direction, status: "needs_label", amount: "30.00" });
    const notice = await state.notice(source, false); await olderConfirmation(state);
    const result = await handleProfileTurn(state.owner, { text: "I spent 50 on transport", clientId: `server-open-false-closed-${direction}`, replyToPayment: notice.paymentNotice }, state.deps);
    expect(result.actionId).toBeUndefined(); expect(await state.store.listTransactions(state.owner.profileId)).toEqual([]);
    await handleProfileTurn(state.owner, { text: "yes", clientId: `server-open-old-yes-${direction}`, replyToPayment: null }, state.deps);
    expect(await state.store.listTransactions(state.owner.profileId)).toEqual([]); expect((await state.store.getPendingAction("older-confirmation"))?.status).toBe("pending");
  });

  it.each([
    ["I spent USD50 on transport", "expense", "50.00", "Transport", "transport", { currency: "USD" }],
    ["I spent 30 on lunch on 2026-11-02", "expense", "30.00", "Food", "lunch", { date: "2026-11-02" }],
  ] as [string, "income" | "expense", string, string, string, Record<string, unknown>][])("confirms clearly distinct explicit currency/date evidence (%s)", async (text, type, amount, category, description, overrides) => {
    const state = setup(() => draft(type, amount, category, description, overrides));
    const { notice, message } = await captured(state);
    const lookup = vi.spyOn(state.store, "findTransactionsBySource");
    const reply = await handleProfileTurn(state.owner, { text, clientId: "closed-out-separate-evidence", replyToPayment: notice.paymentNotice }, state.deps);
    expect(reply.actionId).toBe("synthetic-payment-reply"); expect(await state.store.listTransactions(state.owner.profileId)).toHaveLength(1);
    expect(lookup).toHaveBeenCalledExactlyOnceWith(state.owner.profileId, `bank:${message.id}`);
  });

  it("conservatively retains an unresolved external match without listing history", async () => {
    const state = setup(() => draft("expense", "50.00", "Transport", "transport"));
    const source = await state.payment(1, { direction: "out", status: "matched", amount: "30.00" });
    const manual = await state.store.appendTransaction(expense());
    await state.bank.updateMessage(state.owner.profileId, source.id, { transactionId: manual.transactionId });
    const notice = await state.notice(source, false), lookup = vi.spyOn(state.store, "findTransactionsBySource");
    const reply = await handleProfileTurn(state.owner, { text: "I spent 50 on transport", clientId: "closed-out-external-match", replyToPayment: notice.paymentNotice }, state.deps);
    expect(reply.actionId).toBeUndefined(); expect(reply.text).toContain("Ask something else");
    expect(lookup).toHaveBeenCalledExactlyOnceWith(state.owner.profileId, `bank:${source.id}`);
  });

  it.each(["I spent -50 on transport", "I spent -GHS50 on transport", "I spent −50 on transport", "I spent 50 on transport yesterday", "I spent 50 on transport on 2026-11-02", "I spent 50 on transport on 2026-11-31"])("does not turn signed or mismatched-date prose into a separate expense (%s)", async text => {
    const state = setup(() => draft("expense", "50.00", "Transport", "transport"));
    const { notice } = await captured(state), lookup = vi.spyOn(state.store, "findTransactionsBySource");
    const result = await handleProfileTurn(state.owner, { text, clientId: "closed-out-unsafe-expense-prose", replyToPayment: notice.paymentNotice }, state.deps);
    expect(result.actionId).toBeUndefined(); expect(await state.store.listTransactions(state.owner.profileId)).toHaveLength(1); expect(lookup).not.toHaveBeenCalled();
  });

  it.each(["two-expenses", "two-incomes", "extra-note"])("rejects multiple model actions for one independent request (%s)", async kind => {
    const entry = kind === "two-expenses" ? draft("expense", "50.00", "Transport", "transport") : draft("income");
    const state = setup(() => ({ type: "several", actions: [entry, kind === "extra-note" ? { type: "remember_about_me", note: "An unrelated model-invented note" } : entry] }));
    const addNote = vi.fn();
    state.deps.notebook = { list: async () => [], add: addNote, remove: vi.fn() };
    const { notice } = await captured(state);
    const reply = await handleProfileTurn(state.owner, { text: kind === "two-expenses" ? "I spent 50 on transport" : "Record salary income of GHS500", clientId: `closed-out-several-${kind}`, replyToPayment: notice.paymentNotice }, state.deps);
    expect(reply.actionId).toBeUndefined(); expect(reply.text).toContain("Nothing was changed");
    expect(await state.store.listPendingActions(state.owner.profileId)).toEqual([]); expect(await state.store.listTransactions(state.owner.profileId)).toHaveLength(1);
    expect(addNote).not.toHaveBeenCalled();
  });

  it("checks both currency sides of a one-digit outgoing expense", async () => {
    for (const conflict of [false, true]) {
      const state = setup(() => draft("expense", "5.00", "Food", "lunch"));
      const { notice } = await captured(state);
      const reply = await handleProfileTurn(state.owner, { text: conflict ? "I spent GHS5 USD on lunch" : "I spent GHS5 on lunch", clientId: "closed-out-one-digit-currency", replyToPayment: notice.paymentNotice }, state.deps);
      expect(reply.actionId).toBe(conflict ? undefined : "synthetic-payment-reply");
      expect(await state.store.listPendingActions(state.owner.profileId)).toHaveLength(conflict ? 0 : 1);
      expect(await state.store.listTransactions(state.owner.profileId)).toHaveLength(1);
    }
  });
});

describe("captured payment notices cannot be skipped", () => {
  it.each(["in", "out"] as const)("has no Skip answer and keeps a typed dismissal pending for %s alerts", async direction => {
    for (const text of ["skip", "skip it", "please ignore this payment", "dismiss it", "leave it out"]) {
      const state = setup(() => ({ type: "label_payments", answers: [{ items: [1], action: "skip" }] }));
      const source = await state.payment(1, { direction });
      const notice = await state.notice(source);
      const choices = await openChoices(state.owner, state.deps, notice);
      expect(choices.flat().map(choice => choice.label)).not.toContain("Skip");
      const before = await state.bank.getMessage(state.owner.profileId, source.id);
      const input = { text, clientId: `no-skip-${direction}-${text.replaceAll(" ", "-")}`, replyToPayment: notice.paymentNotice };
      const first = await handleProfileTurn(state.owner, input, state.deps);
      expect(first.text).toContain("keep this payment pending");
      expect(first.text).toContain("Ask something else");
      expect(first.choices?.flat().map(choice => choice.label)).toContain(direction === "in" ? "Business" : "Food");
      expect(first.choices?.flat().map(choice => choice.label)).not.toContain("Skip");
      expect(first.messages?.find(message => message.role === "assistant")?.paymentNotice).toEqual({ bankMessageId: source.id, requiresPurpose: true });
      expect((await handleProfileTurn(state.owner, input, state.deps)).text).toBe(first.text);
      expect(await state.bank.getMessage(state.owner.profileId, source.id)).toEqual(before);
      expect(await state.store.listTransactions(state.owner.profileId)).toEqual([]);
      expect(state.interpret).not.toHaveBeenCalled();
    }
  });

  it.each(["mac", "shortcut", "manual", "screenshot"] as const)("blocks a stale ordinary s callback from %s without changing its source", async channel => {
    const state = setup();
    const source = await state.payment(1, { channel });
    const notice = await state.notice(source);
    const before = await state.bank.getMessage(state.owner.profileId, source.id);
    const input = { choice: `b:${source.id}:s`, clientId: `stale-skip-${channel}`, replyToPayment: notice.paymentNotice };
    const reply = await handleProfileTurn(state.owner, input, state.deps);
    expect(reply.text).toContain("keep this payment pending");
    expect(reply.messages?.find(message => message.role === "assistant")?.paymentNotice).toEqual({ bankMessageId: source.id, requiresPurpose: true });
    expect((await handleProfileTurn(state.owner, input, state.deps)).text).toBe(reply.text);
    expect(await state.bank.getMessage(state.owner.profileId, source.id)).toEqual(before);
    expect(await state.store.listTransactions(state.owner.profileId)).toEqual([]);
  });

  it("does not let a model-produced skip discard the exact unresolved source", async () => {
    const state = setup(request => ({ type: "label_payments", answers: [{ items: [request.waiting!.current], action: "skip" }] }));
    const source = await state.payment(1);
    const notice = await state.notice(source);
    const before = await state.bank.getMessage(state.owner.profileId, source.id);
    const reply = await handleProfileTurn(state.owner, { text: "it was a small test transfer, leave it out", clientId: "model-must-not-skip", replyToPayment: notice.paymentNotice }, state.deps);
    expect(reply.text).toContain("keep this payment pending");
    expect(state.interpret).toHaveBeenCalledOnce();
    expect(await state.bank.getMessage(state.owner.profileId, source.id)).toEqual(before);
    expect(await state.store.listTransactions(state.owner.profileId)).toEqual([]);
  });

  it("does not use a stale callback to switch the exact notice or reach another owner", async () => {
    const state = setup();
    const target = await state.payment(1), older = await state.payment(2), foreign = await state.payment(3, { ownerId: "another-owner" });
    const notice = await state.notice(target);
    for (const source of [older, foreign]) {
      const reply = await handleProfileTurn(state.owner, { choice: `b:${source.id}:s`, clientId: `no-skip-other-${source.id}`, replyToPayment: notice.paymentNotice }, state.deps);
      expect(reply.text).toContain("no longer valid");
    }
    expect(await chooseLabel(state.ingest, state.owner, `b:${foreign.id}:s`)).toBeNull();
    expect((await state.bank.getMessage(state.owner.profileId, target.id))?.status).toBe("needs_label");
    expect((await state.bank.getMessage(state.owner.profileId, older.id))?.status).toBe("needs_label");
    expect((await state.bank.getMessage("another-owner", foreign.id))?.status).toBe("needs_label");
    expect(await state.store.listTransactions(state.owner.profileId)).toEqual([]);
  });

  it("Ask something else leaves the source pending and available to reopen", async () => {
    const state = setup(() => ({ type: "chat", message: "We can talk about something else." }));
    const source = await state.payment(1);
    const notice = await state.notice(source);
    const before = await state.bank.getMessage(state.owner.profileId, source.id);
    const reply = await handleProfileTurn(state.owner, { text: "let's talk about saving", clientId: "no-skip-ask-something-else", replyToPayment: notice.paymentNotice, newTopic: true }, state.deps);
    expect(reply.messages?.find(message => message.role === "assistant")?.paymentNotice).toBeUndefined();
    expect(reply.messages?.find(message => message.role === "assistant")?.newTopic).toBe(true);
    expect((await currentQuestion(state.ingest, state.owner, { currentMessageId: source.id }))?.message.id).toBe(source.id);
    expect((await openChoices(state.owner, state.deps, notice)).flat().map(choice => choice.label)).toContain("Business");
    expect(await state.bank.getMessage(state.owner.profileId, source.id)).toEqual(before);
    expect(await state.store.listTransactions(state.owner.profileId)).toEqual([]);
  });

  it("rejects a model skip before undoing any recent valid classification", async () => {
    const state = setup();
    const source = await state.payment(1);
    const labelled = await applyLabel(state.ingest, state.owner, source.id, { kind: "category", category: "Business", description: "Fictional freelance work" });
    expect(labelled.ok).toBe(true);
    if (!labelled.ok) throw new Error("Synthetic classification was not saved");
    await state.bank.saveUndo(state.owner.profileId, labelled.changes);
    const before = await state.bank.getMessage(state.owner.profileId, source.id);
    const finances = await state.store.listTransactions(state.owner.profileId);
    const waiting = await waitingPayments(state.ingest, state.owner);
    expect(waiting?.recent).toHaveLength(1);
    const reply = await applyResolved(state.ingest, state.owner, "skip that", [{ messageIds: [source.id], label: { kind: "skip" } }], waiting!);
    expect(reply?.text).toContain("haven't removed or changed");
    expect(await state.bank.getMessage(state.owner.profileId, source.id)).toEqual(before);
    expect(await state.store.listTransactions(state.owner.profileId)).toEqual(finances);
  });

  it("leaves historical skipped records unchanged when a stale skip reaches the write guard", async () => {
    const state = setup();
    const source = await state.payment(1, { status: "skipped" });
    const before = await state.bank.getMessage(state.owner.profileId, source.id);
    expect((await applyLabel(state.ingest, state.owner, source.id, { kind: "skip" })).ok).toBe(false);
    expect(await state.bank.getMessage(state.owner.profileId, source.id)).toEqual(before);
    expect(await state.store.listTransactions(state.owner.profileId)).toEqual([]);
  });

  it("does not turn an unmatched hold-settlement callback into an ordinary skip", async () => {
    const state = setup();
    const source = await state.payment(1, { direction: "out", kind: "hold_settle" });
    const notice = await state.notice(source);
    const before = await state.bank.getMessage(state.owner.profileId, source.id);
    const reply = await handleProfileTurn(state.owner, { choice: `b:${source.id}:s`, clientId: "no-skip-unmatched-hold", replyToPayment: notice.paymentNotice }, state.deps);
    expect(reply.text).toContain("keep this payment pending");
    expect(await state.bank.getMessage(state.owner.profileId, source.id)).toEqual(before);
    expect(await state.store.listTransactions(state.owner.profileId)).toEqual([]);
  });
});
