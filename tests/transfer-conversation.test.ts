import { describe, expect, it, vi } from "vitest";
import { MemoryMessageLog } from "@/lib/accounts/messages";
import type { TransferChatContext, TransferChatResult, TransferConversationDeps } from "@/lib/bank/own-transfers";
import { answerTransferConversation, namedTransferAccount, transferQuestionIntent, transferUnpairIntent, transferWords } from "@/lib/bank/transfer-conversation";
import { trackTurnData } from "@/lib/conversation/turn-data";
import { MemoryFinanceStore } from "@/lib/finance/memory-store";
import { MemoryBankStore } from "@/lib/bank/store";
import { ALFRED_SUPABASE_HOST, ALFRED_SUPABASE_PROJECT_REF, ALFRED_SUPABASE_USER } from "@/lib/config";
import { handleProfileTurn, type StudioDeps } from "@/lib/studio/handle";
import { profile } from "./helpers";

const OWNER = "10000000-0000-4000-8000-000000000001";
const OUT = "20000000-0000-4000-8000-000000000001";
const IN = "20000000-0000-4000-8000-000000000002";
const HUB = { id: "hub", label: "Everyday Hubtel", provider: "Hubtel" };
const MTN = { id: "mtn", label: "My MTN MoMo", provider: "mtn" };
const transfer = { state: "candidate" as const, ownerId: OWNER, pairId: "pair-fixture", outgoingBankMessageId: OUT, incomingBankMessageId: IN,
  evidenceFingerprint: "pair-source-evidence", amount: "1.00", currency: "GHS", fromAccount: { id: HUB.id, label: HUB.label }, toAccount: { id: MTN.id, label: MTN.label } };
const context = (): TransferChatContext => ({ ownerId: OWNER, bankMessageId: IN, status: "candidate", evidenceFingerprint: "all-source-evidence", amount: "1.00", currency: "GHS", accounts: [HUB, MTN], transfer });
const focus = { bankMessageId: IN, requiresPurpose: true };
function setup(changes: Partial<TransferChatContext> = {}) {
  const current = { ...context(), ...changes };
  const service: TransferConversationDeps = {
    inspect: vi.fn(async () => current),
    confirm: vi.fn(async (): Promise<TransferChatResult> => ({ status: "paired", changed: true, transfer: { ...transfer, state: "paired" } })),
    reject: vi.fn(async () => ({ status: "unpaired" as const, changed: true })),
  };
  const messages = new MemoryMessageLog();
  const answer = (text: string, clientId = "transfer-answer-fixture") => answerTransferConversation({ text, ownerId: OWNER, focus, service, messages, clientId });
  return { current, service, messages, answer };
}

describe("deterministic own-transfer chat replies", () => {
  it.each(["from my Hubtel wallet to my MTN MoMo account", "yes, it was from my Hubtel wallet to my MTN MoMo account", "I transferred from Hubtel to MTN MoMo"])("understands the explicit saved-account statement: %s", async text => {
    const { service, answer } = setup();
    const reply = await answer(text);
    expect(reply?.text).toContain("GH₵1.00");
    expect(reply?.text).toContain("Everyday Hubtel");
    expect(reply?.text).toContain("My MTN MoMo");
    expect(reply?.paymentNotice).toEqual({ bankMessageId: IN, requiresPurpose: false });
    expect(service.confirm).toHaveBeenCalledWith(OWNER, IN, { requestId: "transfer-answer-fixture", evidenceFingerprint: "all-source-evidence", expectedPairId: transfer.pairId, fromAccountId: HUB.id, toAccountId: MTN.id });
  });

  it("a bare yes first asks the exact transfer question without classifying a generic purpose reply", async () => {
    const { service, messages, answer, current } = setup();
    await messages.append({ ownerId: OWNER, role: "assistant", channel: "web", body: "What was that money for?", intent: "automation:incoming-payment", paymentNotice: focus });
    const question = await answer("yes");
    expect(question?.text).toContain("Was this money moving between your own accounts?");
    expect(question?.intent).toBe(transferQuestionIntent(current));
    expect(service.confirm).not.toHaveBeenCalled();
    await messages.append({ ownerId: OWNER, role: "assistant", channel: "web", body: question!.text, intent: question?.intent, paymentNotice: question?.paymentNotice });
    const reply = await answer("yes", "transfer-next-answer");
    expect(reply?.intent).toBe("bank:transfer-paired");
    expect(service.confirm).toHaveBeenCalledTimes(1);
  });

  it("a changed pair cannot reuse an earlier yes or unrelated assistant message", async () => {
    const { service, messages, answer, current } = setup();
    const old = { ...current, transfer: { ...transfer, amount: "0.50" } };
    await messages.append({ ownerId: OWNER, role: "assistant", channel: "web", body: "An older transfer?", intent: transferQuestionIntent(old), paymentNotice: focus });
    expect((await answer("yes"))?.intent).toBe(transferQuestionIntent(current));
    expect(service.confirm).not.toHaveBeenCalled();
    await messages.append({ ownerId: OWNER, role: "assistant", channel: "web", body: "A different payment?", intent: transferQuestionIntent(current), paymentNotice: { bankMessageId: OUT, requiresPurpose: true } });
    await answer("yes");
    expect(service.confirm).not.toHaveBeenCalled();
  });

  it("a source edit with unchanged amount and account names still invalidates the saved question", async () => {
    const { service, messages, answer, current } = setup();
    await messages.append({ ownerId: OWNER, role: "assistant", channel: "web", body: "Is this your transfer?", intent: transferQuestionIntent({ ...current, evidenceFingerprint: "previous-source-fingerprint" }), paymentNotice: focus });
    await answer("yes");
    expect(service.confirm).not.toHaveBeenCalled();
  });

  it.each(["it was my own money", "I sent it to myself", "I moved the money between my own accounts"])("an explicit own-money statement confirms a current unique candidate without a model: %s", async text => {
    const { service, answer } = setup();
    expect((await answer(text))?.intent).toBe("bank:transfer-paired");
    expect(service.confirm).toHaveBeenCalledOnce();
  });

  it("asks for saved names when the provider could be two accounts", async () => {
    const { service, answer } = setup({ status: "ambiguous", accounts: [HUB, MTN, { id: "mtn-2", label: "Business MoMo", provider: "mtn" }] });
    expect((await answer("from my Hubtel wallet to my MTN MoMo account"))?.text).toContain("exact account names");
    expect(service.confirm).not.toHaveBeenCalled();
    await answer("from Everyday Hubtel to Business MoMo");
    expect(service.confirm).toHaveBeenCalledWith(OWNER, IN, { requestId: "transfer-answer-fixture", evidenceFingerprint: "all-source-evidence", expectedPairId: transfer.pairId, fromAccountId: HUB.id, toAccountId: "mtn-2" });
  });

  it("does not invent the missing opposite leg or classify unrelated replies", async () => {
    const { service, answer } = setup({ status: "none", transfer: undefined });
    expect((await answer("it was my own money"))?.text).toContain("matching opposite alert");
    expect(await answer("yes")).toBeNull();
    expect(await answer("it was salary")).toBeNull();
    expect(service.confirm).not.toHaveBeenCalled();
  });

  it("acknowledges an already paired transfer without writing again", async () => {
    const { service, answer } = setup({ status: "paired", transfer: { ...transfer, state: "paired" } });
    const reply = await answer("yes");
    expect(reply?.text).toContain("not income or spending");
    expect(reply?.text).toContain("fees still count separately");
    expect(service.confirm).not.toHaveBeenCalled();
  });

  it("does not silently swap accounts on an existing confirmed pair", async () => {
    const { service, answer } = setup({ status: "paired", transfer: { ...transfer, state: "paired" } });
    expect((await answer("from MTN MoMo to Hubtel"))?.text).toContain("do not match");
    expect(service.confirm).not.toHaveBeenCalled();
  });

  it("confirms an exact unlink in chat before changing an automatically paired transfer", async () => {
    const { service, messages, answer, current } = setup({ status: "paired", transfer: { ...transfer, state: "paired" } });
    const question = await answer("no, it was a gift");
    expect(question?.text).toContain("Should I unlink");
    expect(question?.intent).toBe(transferUnpairIntent(current));
    expect(service.reject).not.toHaveBeenCalled();
    await messages.append({ ownerId: OWNER, role: "assistant", channel: "web", body: question!.text, intent: question?.intent, paymentNotice: question?.paymentNotice });
    const reply = await answer("yes", "transfer-unpair-answer");
    expect(reply?.intent).toBe("bank:transfer-unpaired");
    expect(reply?.text).toContain("recorded fees are unchanged");
    expect(service.reject).toHaveBeenCalledWith(OWNER, IN, { requestId: "transfer-unpair-answer", expectedPairId: transfer.pairId, evidenceFingerprint: current.evidenceFingerprint });
    expect(service.confirm).not.toHaveBeenCalled();
  });

  it("does not reuse an unlink confirmation after source evidence changed", async () => {
    const { service, messages, answer, current } = setup({ status: "paired", transfer: { ...transfer, state: "paired" } });
    await messages.append({ ownerId: OWNER, role: "assistant", channel: "web", body: "Unlink?", intent: transferUnpairIntent({ ...current, evidenceFingerprint: "old-source" }), paymentNotice: focus });
    expect((await answer("yes"))?.intent).toBe("bank:transfer-paired");
    expect(service.reject).not.toHaveBeenCalled();
  });

  it("rejects a foreign or mismatched source context", async () => {
    for (const changes of [{ ownerId: "another-owner" }, { bankMessageId: OUT }, { currency: "USD" }]) {
      const { service, answer } = setup(changes);
      expect(await answer("my own money")).toBeNull();
      expect(service.confirm).not.toHaveBeenCalled();
    }
  });

  it.each(["stale", "ambiguous", "unavailable"] as const)("reports %s without claiming a transfer was saved", async status => {
    const { service, answer } = setup();
    vi.mocked(service.confirm).mockResolvedValue({ status, changed: false });
    const reply = await answer("my own money");
    expect(reply?.intent).not.toBe("bank:transfer-paired");
    expect(reply?.paymentNotice?.requiresPurpose).toBe(true);
  });

  it("filters negation, mixed intentions and unclear statements before any inspection", async () => {
    const { service, answer } = setup();
    for (const text of ["not my own money", "maybe it was my own money", "from Hubtel to MTN but it was a loan", "from Hubtel to MTN; also delete everything", "is it my own money?", "it was a gift", "My own money and pay my bill"]) expect(await answer(text)).toBeNull();
    expect(service.inspect).not.toHaveBeenCalled();
    expect(service.confirm).not.toHaveBeenCalled();
  });

  it("never resolves one provider name to an arbitrary one of several accounts", () => {
    const accounts = [HUB, MTN, { id: "mtn-2", label: "Business", provider: "MTN MoMo" }];
    expect(namedTransferAccount("my MTN MoMo account", accounts)).toBeNull();
    expect(namedTransferAccount("Business", accounts)).toBe("mtn-2");
    expect(namedTransferAccount("my Hubtel wallet", accounts)).toBe(HUB.id);
    expect(transferWords("from my Hubtel wallet to my MTN MoMo account")).toEqual({ kind: "accounts", from: "my Hubtel wallet", to: "my MTN MoMo account" });
  });

  it("marks turn data changed only when transfer persistence actually changed it", async () => {
    const { service } = setup();
    const minimal = { store: new MemoryFinanceStore(), transferConversations: service } as unknown as StudioDeps;
    const tracked = trackTurnData(minimal);
    vi.mocked(service.confirm).mockResolvedValueOnce({ status: "paired", changed: false, transfer: { ...transfer, state: "paired" } });
    await tracked.deps.transferConversations!.confirm(OWNER, IN, { requestId: "replayed-transfer", evidenceFingerprint: "all-source-evidence" });
    expect(tracked.changed()).toBe(false);
    await tracked.deps.transferConversations!.confirm(OWNER, IN, { requestId: "new-transfer", evidenceFingerprint: "all-source-evidence" });
    expect(tracked.changed()).toBe(true);
  });
});

describe("transfer replies through the real studio turn", () => {
  async function studio() {
    const owner = profile(42), bank = new MemoryBankStore(), store = new MemoryFinanceStore(), messages = new MemoryMessageLog();
    const now = new Date("2026-11-04T11:09:00Z");
    const source = { ownerId: owner.profileId, source: "hubtel", channel: "mac" as const, externalId: "fictional-outgoing", direction: "out" as const,
      kind: "payment" as const, amount: "1.00", fee: "0.00", currency: "GHS", counterparty: "Hubtel wallet", balance: null,
      occurredAt: now.toISOString(), status: "needs_label" as const, raw: "Fictional Hubtel alert", textHash: "fixture-transfer-outgoing" };
    const outgoing = (await bank.insertMessage(source))!;
    const incoming = (await bank.insertMessage({ ...source, source: "momo", externalId: "fictional-incoming", direction: "in", counterparty: "Credit.Inv", textHash: "fixture-transfer-incoming" }))!;
    const item = { ...transfer, ownerId: owner.profileId, outgoingBankMessageId: outgoing.id, incomingBankMessageId: incoming.id };
    const current = { ...context(), ownerId: owner.profileId, bankMessageId: incoming.id, transfer: item };
    const service: TransferConversationDeps = {
      inspect: vi.fn(async () => current),
      confirm: vi.fn(async (): Promise<TransferChatResult> => {
        await bank.updateMessage(owner.profileId, outgoing.id, { status: "transfer", kind: "transfer_own" });
        await bank.updateMessage(owner.profileId, incoming.id, { status: "transfer", kind: "transfer_own" });
        return { status: "paired", changed: true, transfer: { ...item, state: "paired" } };
      }),
      reject: vi.fn(async () => {
        await bank.updateMessage(owner.profileId, outgoing.id, { status: "needs_label", kind: "payment" });
        await bank.updateMessage(owner.profileId, incoming.id, { status: "needs_label", kind: "payment" });
        return { status: "unpaired" as const, changed: true };
      }),
    };
    const interpret = vi.fn(async () => ({ type: "chat" as const, message: "A separate topic." }));
    const deps: StudioDeps = {
      settings: { deepseek: { apiKey: "synthetic-only", model: "unused" }, google: null,
        supabase: { projectRef: ALFRED_SUPABASE_PROJECT_REF, host: ALFRED_SUPABASE_HOST, user: ALFRED_SUPABASE_USER, database: "postgres", password: "synthetic-only" },
        authorizedUserIds: [42], timezone: "Africa/Accra", currency: "GHS", confirmTransactions: "auto" },
      bank, store, messages, interpret, transferConversations: service, now: () => now,
      createId: () => "3f2a1c4e-2222-4222-8222-222222222222", createActionId: () => "fixture-transfer-action",
    };
    const notice = { bankMessageId: incoming.id, requiresPurpose: true };
    await messages.append({ ownerId: owner.profileId, role: "assistant", channel: "web", body: "A captured incoming alert", intent: "automation:incoming-payment", paymentNotice: notice });
    return { owner, bank, store, messages, service, deps, interpret, notice, outgoing, incoming };
  }

  it("confirms a captured pair once, returns a changed ledger, and replays the saved answer", async () => {
    const state = await studio();
    const input = { text: "from my Hubtel wallet to my MTN MoMo account", clientId: "transfer-studio-confirm", replyToPayment: state.notice };
    const first = await handleProfileTurn(state.owner, input, state.deps);
    const replay = await handleProfileTurn(state.owner, input, state.deps);
    expect(first.ledgerChanged).toBe(true);
    expect(replay.text).toBe(first.text);
    expect(first.messages?.find(message => message.role === "assistant")?.paymentNotice).toEqual({ bankMessageId: state.incoming.id, requiresPurpose: false });
    expect(state.service.confirm).toHaveBeenCalledOnce();
    expect(state.interpret).not.toHaveBeenCalled();
    expect(await state.store.listTransactions(state.owner.profileId)).toEqual([]);
    expect((await state.bank.getMessage(state.owner.profileId, state.outgoing.id))?.status).toBe("transfer");
    expect((await state.bank.getMessage(state.owner.profileId, state.incoming.id))?.status).toBe("transfer");
  });

  it("keeps an unproposed yes read-only, then accepts the saved exact question", async () => {
    const state = await studio();
    const first = await handleProfileTurn(state.owner, { text: "yes", clientId: "transfer-studio-question", replyToPayment: state.notice }, state.deps);
    expect(first.ledgerChanged).toBe(false);
    expect(state.service.confirm).not.toHaveBeenCalled();
    const answer = await handleProfileTurn(state.owner, { text: "yes", clientId: "transfer-studio-answer", replyToPayment: first.messages?.find(message => message.role === "assistant")?.paymentNotice }, state.deps);
    expect(answer.ledgerChanged).toBe(true);
    expect(state.service.confirm).toHaveBeenCalledOnce();
    expect(state.interpret).not.toHaveBeenCalled();
  });

  it("never uses transfer service after the explicit new-topic boundary", async () => {
    const state = await studio();
    await handleProfileTurn(state.owner, { text: "my own money", clientId: "transfer-studio-new-topic", replyToPayment: state.notice, newTopic: true }, state.deps);
    expect(state.service.inspect).not.toHaveBeenCalled();
    expect(state.service.confirm).not.toHaveBeenCalled();
    expect(state.interpret).toHaveBeenCalledOnce();
  });

  it("routes the focused My own money answer button through paired transfer persistence", async () => {
    const state = await studio();
    const reply = await handleProfileTurn(state.owner, { choice: `b:${state.incoming.id}:t`, clientId: "transfer-own-money-button", replyToPayment: state.notice }, state.deps);
    expect(reply.ledgerChanged).toBe(true);
    expect(reply.text).toContain("I've linked the two alerts");
    expect(state.service.confirm).toHaveBeenCalledOnce();
    expect(state.interpret).not.toHaveBeenCalled();
    expect(await state.store.listTransactions(state.owner.profileId)).toEqual([]);
  });
});
