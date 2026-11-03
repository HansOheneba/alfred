import { describe, expect, it, vi } from "vitest";

import { chatChoices } from "@/lib/accounts/chat-choices";
import { chatChoiceSchema } from "@/lib/accounts/chat-request";
import { MemoryMessageLog } from "@/lib/accounts/messages";
import { ingestBankText } from "@/lib/bank/ingest";
import { askNext, chooseLabel, currentQuestion } from "@/lib/bank/reply";
import { MemoryBankStore } from "@/lib/bank/store";
import { MemoryFinanceStore } from "@/lib/finance/memory-store";
import { ALFRED_SUPABASE_HOST, ALFRED_SUPABASE_PROJECT_REF, ALFRED_SUPABASE_USER } from "@/lib/config";
import { handleProfileTurn, type StudioDeps } from "@/lib/studio/handle";
import { profile } from "./helpers";

const paid = (name: string, amount: string, id: string) =>
  `Payment made for GHS ${amount} to ${name} Current Balance: GHS 1512.11 . Available Balance: GHS 1512.11. Reference: . Transaction ID: ${id}. Fee charged: GHS0.00`;

async function setup() {
  const store = new MemoryFinanceStore();
  const bank = new MemoryBankStore();
  const owner = profile(42, { preferredName: "Hans" });
  let sequence = 0;
  const ingest = {
    bank,
    ledger: store,
    now: new Date("2026-10-31T05:16:00.000Z"),
    createId: () => `7a1b2c3d-4444-4444-8444-${String(++sequence).padStart(12, "0")}`,
  };
  await ingestBankText(ingest, owner, paid("ELLEN OHENEWA OBENG-DARKO", "22.50", "92694674830"), { channel: "mac" });
  await ingestBankText(ingest, owner, paid("KOFI BOATENG", "40.00", "92694674831"), { channel: "mac" });
  return { ingest, owner, bank, store };
}

describe("answer buttons in the web chat", () => {
  it("offers the payment just asked about as tappable choices", async () => {
    const { ingest, owner } = await setup();
    expect(await currentQuestion(ingest, owner)).toBeNull();
    const asked = await askNext(ingest, owner);
    const current = await currentQuestion(ingest, owner);
    expect(current?.message.id).toBe(asked?.id);
    const labels = chatChoices(current?.buttons).flat().map((choice) => choice.label);
    expect(labels).toContain("Transport");
    expect(labels).toContain("Skip");
  });

  it("files a tapped choice without the model and asks the next one", async () => {
    const { ingest, owner, store } = await setup();
    await askNext(ingest, owner);
    const transport = chatChoices((await currentQuestion(ingest, owner))?.buttons)
      .flat()
      .find((choice) => choice.label === "Transport");
    expect(chatChoiceSchema.safeParse({ choice: transport?.choice, clientId: "6f1b2c3d-4444-4444-8444-000000000001" }).success).toBe(true);
    const chosen = await chooseLabel(ingest, owner, transport!.choice!);
    expect(chosen?.said).toBe("Transport");
    expect(chosen?.reply.text).toMatch(/^✓ .*Transport/);
    expect(chosen?.reply.text).toContain("Kofi Boateng");
    expect(chosen?.reply.buttons?.length).toBeGreaterThan(0);
    const filed = (await store.listTransactions(owner.profileId)).filter((item) => item.category === "Transport");
    expect(filed).toHaveLength(1);
  });

  it("turns the review link into a page on the site and drops other buttons", () => {
    expect(
      chatChoices([
        [{ text: "Food", callbackData: "b:7a1b2c3d-4444-4444-8444-000000000001:c0" }, { text: "Confirm", callbackData: "c:abc" }],
        [{ text: "Review all 3 on the web", url: "https://alfred.example/review" }],
      ]),
    ).toEqual([
      [{ label: "Food", choice: "b:7a1b2c3d-4444-4444-8444-000000000001:c0" }],
      [{ label: "Review all 3 on the web", href: "/review" }],
    ]);
  });
});

async function webSetup() {
  const state = await setup();
  await askNext(state.ingest, state.owner);
  const transport = chatChoices((await currentQuestion(state.ingest, state.owner))?.buttons).flat().find(choice => choice.label === "Transport")!.choice!;
  const messages = new MemoryMessageLog();
  const interpret = vi.fn(async () => { throw new Error("Choice submission must not call a model"); });
  const deps: StudioDeps = {
    settings: {
      deepseek: { apiKey: "synthetic-only", model: "unused" }, google: null,
      supabase: { projectRef: ALFRED_SUPABASE_PROJECT_REF, host: ALFRED_SUPABASE_HOST, user: ALFRED_SUPABASE_USER, database: "postgres", password: "synthetic-only" },
      authorizedUserIds: [42, 43], timezone: "Africa/Accra", currency: "GHS", confirmTransactions: "auto",
    },
    store: state.store, bank: state.bank, messages, interpret,
    now: () => state.ingest.now, createId: state.ingest.createId, createActionId: () => "synthetic-choice-action",
  };
  return { ...state, deps, messages, interpret, transport };
}

describe("payment-choice financial outcomes", () => {
  it("marks a choice-backed label as a financial write and preserves that metadata on completed replay", async () => {
    const { deps, owner, store, messages, interpret, transport } = await webSetup();
    const turn = { choice: transport, clientId: "synthetic-choice-success" };
    const first = await handleProfileTurn(owner, turn, deps);
    const replay = await handleProfileTurn(owner, turn, deps);
    expect(first.ledgerChanged).toBe(true); expect(replay.ledgerChanged).toBe(true);
    expect(first.messages?.find(message => message.role === "assistant")?.ledgerChanged).toBe(true);
    expect(replay.messages?.find(message => message.role === "assistant")?.ledgerChanged).toBe(true);
    expect(first.choices?.flat().length).toBeGreaterThan(0);
    expect(first.text).toContain("Kofi Boateng");
    expect(await store.listTransactions(owner.profileId)).toHaveLength(1);
    expect((await messages.listRecent(owner.profileId, 20)).map(message => message.role)).toEqual(["user", "assistant"]);
    expect(interpret).not.toHaveBeenCalled();
  });

  it.each(["missing", "wrong owner", "already sorted"] as const)("keeps a %s choice and its replay unchanged", async kind => {
    const { deps, owner, store, bank, interpret, transport } = await webSetup();
    if (kind === "already sorted") await handleProfileTurn(owner, { choice: transport, clientId: "synthetic-choice-initial" }, deps);
    const actor = kind === "wrong owner" ? profile(43) : owner;
    const choice = kind === "missing" ? "b:00000000-0000-4000-9000-999999999999:c0" : transport;
    const before = await store.listTransactions(owner.profileId);
    const bankBefore = await bank.listMessages(owner.profileId);
    const turn = { choice, clientId: "synthetic-choice-noop" };
    const result = await handleProfileTurn(actor, turn, deps);
    const replay = await handleProfileTurn(actor, turn, deps);
    expect(result.ledgerChanged).toBe(false); expect(replay.ledgerChanged).toBe(false);
    expect(result.messages?.find(message => message.role === "assistant")?.ledgerChanged).toBe(false);
    expect(replay.messages?.find(message => message.role === "assistant")?.ledgerChanged).toBe(false);
    expect(await store.listTransactions(owner.profileId)).toEqual(before);
    expect(await bank.listMessages(owner.profileId)).toEqual(bankBefore);
    expect(await store.listTransactions("43")).toHaveLength(0);
    expect(interpret).not.toHaveBeenCalled();
  });

  it("never reports successful financial metadata for a rejected write and retries safely", async () => {
    const { deps, owner, store, messages, interpret, transport } = await webSetup();
    const writes = vi.spyOn(store, "appendTransaction");
    const turn = { choice: transport, clientId: "synthetic-choice-write-failure" };
    store.failNextTransactionAppends(1);
    await expect(handleProfileTurn(owner, turn, deps)).rejects.toThrow("Simulated");
    expect(await store.listTransactions(owner.profileId)).toHaveLength(0);
    expect((await messages.listByClientId(owner.profileId, turn.clientId)).some(message => message.role === "assistant")).toBe(false);
    expect((await store.listProcessedUpdates()).at(-1)?.status).toBe("failed");
    const recovered = await handleProfileTurn(owner, turn, deps);
    const replay = await handleProfileTurn(owner, turn, deps);
    expect(recovered.ledgerChanged).toBe(true); expect(replay.ledgerChanged).toBe(true);
    expect(recovered.messages?.find(message => message.role === "assistant")?.ledgerChanged).toBe(true);
    expect(await store.listTransactions(owner.profileId)).toHaveLength(1);
    expect(writes).toHaveBeenCalledTimes(2);
    expect(interpret).not.toHaveBeenCalled();
  });

  it("retains a financial outcome after the label committed but saving its assistant reply failed", async () => {
    const { deps, owner, store, messages, interpret, transport } = await webSetup();
    const writes = vi.spyOn(store, "appendTransaction");
    const append = messages.append.bind(messages);
    let failAssistant = true;
    vi.spyOn(messages, "append").mockImplementation(async message => {
      if (message.role === "assistant" && failAssistant) { failAssistant = false; throw new Error("Synthetic reply persistence failure"); }
      return append(message);
    });
    const turn = { choice: transport, clientId: "synthetic-choice-partial" };
    await expect(handleProfileTurn(owner, turn, deps)).rejects.toThrow("Synthetic reply persistence failure");
    expect(await store.listTransactions(owner.profileId)).toHaveLength(1);
    const recovered = await handleProfileTurn(owner, turn, deps);
    const replay = await handleProfileTurn(owner, turn, deps);
    expect(recovered.ledgerChanged).toBe(true); expect(replay.ledgerChanged).toBe(true);
    expect(recovered.messages?.find(message => message.role === "assistant")?.ledgerChanged).toBe(true);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(await store.listTransactions(owner.profileId)).toHaveLength(1);
    expect(interpret).not.toHaveBeenCalled();
  });

  it("keeps ordinary read-only chat unchanged while payment choices exist", async () => {
    const { deps, owner, store } = await webSetup();
    const interpret = vi.fn(async () => ({ type: "chat" as const, message: "Synthetic read-only reply" }));
    const result = await handleProfileTurn(owner, { text: "How are things?", clientId: "synthetic-choice-read-only" }, { ...deps, interpret });
    expect(result.ledgerChanged).toBe(false);
    expect(result.messages?.find(message => message.role === "assistant")?.ledgerChanged).toBe(false);
    expect(await store.listTransactions(owner.profileId)).toHaveLength(0);
    expect(interpret).toHaveBeenCalledTimes(1);
  });
});
