import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET, POST } from "@/app/api/chat/route";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), connection: vi.fn(), open: vi.fn(), profile: vi.fn(), history: vi.fn(), choices: vi.fn(), turn: vi.fn(), allow: vi.fn(), network: vi.fn(), paymentEntry: vi.fn() }));
vi.mock("@/app/chat/payment-entry", async importOriginal => ({ ...await importOriginal<typeof import("@/app/chat/payment-entry")>(), loadPaymentChatEntry: mocks.paymentEntry }));
vi.mock("next/server", () => ({ connection: mocks.connection }));
vi.mock("@/lib/supabase/session", () => ({ getAuthUser: mocks.auth }));
vi.mock("@/lib/env", () => ({ getStudioSettings: () => ({ supabase: { projectRef: "synthetic-only" } }) }));
vi.mock("@/lib/accounts/settings-store", () => ({ openAccount: mocks.open }));
vi.mock("@/lib/accounts/supabase-directory", () => ({ createSupabaseAccountDirectory: () => ({ loadOwner: mocks.profile }) }));
vi.mock("@/lib/accounts/supabase-messages", () => ({ createSupabaseMessageLog: () => ({ listRecent: mocks.history }) }));
vi.mock("@/lib/studio/handle", () => ({ createStudioDeps: () => ({ synthetic: true }), handleProfileTurn: mocks.turn, openChoices: mocks.choices }));
vi.mock("@/lib/security/db-rate-limit", () => ({ DbRateLimiter: class { allow = mocks.allow; } }));
vi.mock("@/lib/log", () => ({ logError: vi.fn() }));

const ownerId = "00000000-0000-4000-8000-000000000001";
const profile = { profileId: ownerId, preferredName: "Synthetic reviewer" };
const message = { id: "synthetic-message", role: "assistant", body: "Which category?", channel: "web", createdAt: "2026-11-03T08:00:00.000Z", clientId: "synthetic-client", intent: "bank:label", ledgerChanged: true };
const choice = { label: "Transport", choice: "b:00000000-0000-4000-8000-000000000002:c0" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ id: ownerId }); mocks.connection.mockResolvedValue(undefined);
  mocks.open.mockResolvedValue("ready"); mocks.profile.mockResolvedValue(profile);
  mocks.history.mockResolvedValue([message]); mocks.choices.mockResolvedValue([[choice]]);
  mocks.allow.mockResolvedValue(true);
  mocks.turn.mockResolvedValue({ text: "Filed", messages: [message], choices: [[choice]], ledgerChanged: true });
  mocks.paymentEntry.mockResolvedValue({ state: "unavailable" });
  mocks.network.mockImplementation(() => { throw new Error("Synthetic API tests must never request a network service"); });
  vi.stubGlobal("fetch", mocks.network);
});
afterEach(() => { expect(mocks.network).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe("owner-stamped private Chat history and payment choices", () => {
  it("returns history and answer choices for the authenticated owner with private no-store headers", async () => {
    const response = await GET();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body).toMatchObject({ ok: true, ownerId, choices: [[choice]], messages: [{ id: message.id, ledgerChanged: true }] });
    expect(mocks.history).toHaveBeenCalledExactlyOnceWith(ownerId, 80);
    expect(mocks.profile).toHaveBeenCalledExactlyOnceWith(ownerId);
    expect(mocks.choices).toHaveBeenCalledExactlyOnceWith(profile, { synthetic: true }, message);
  });

  it("keeps history usable when optional answer-choice lookup fails", async () => {
    mocks.choices.mockRejectedValue(new Error("Synthetic choice lookup unavailable"));
    const response = await GET();
    expect(await response.json()).toMatchObject({ ok: true, ownerId, choices: [], messages: [{ id: message.id }] });
  });

  it.each([401, 403])("does not load private history for a denied session (%s)", async status => {
    if (status === 401) mocks.auth.mockResolvedValue(null);
    else mocks.open.mockResolvedValue("not_invited");
    const response = await GET();
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).not.toHaveProperty("ownerId");
    expect(mocks.history).not.toHaveBeenCalled(); expect(mocks.choices).not.toHaveBeenCalled();
  });

  it("preserves framework request-time cancellation before auth or error conversion", async () => {
    const cancellation = new Error("Synthetic prerender cancellation");
    mocks.connection.mockRejectedValue(cancellation);
    await expect(GET()).rejects.toBe(cancellation);
    expect(mocks.auth).not.toHaveBeenCalled();
  });

  it("keeps failed history responses private and uncached", async () => {
    mocks.history.mockRejectedValue(new Error("Synthetic history unavailable"));
    const response = await GET();
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).not.toHaveProperty("messages");
  });

  it("opens the requested owned payment older than recent history and derives its own answer choices", async () => {
    const bankMessageId = "11111111-1111-4111-8111-111111111111";
    const target = { ...message, id: "older-source-message", clientId: "older-source-client", body: "Current fictional payment question", createdAt: "2026-11-02T08:00:00Z", paymentNotice: { bankMessageId, requiresPurpose: true } };
    mocks.paymentEntry.mockResolvedValue({ state: "ready", bankMessageId, message: target });
    const response = await GET(new Request(`https://fictional.example/api/chat?payment=${bankMessageId}`));
    const body = await response.json();
    expect(body.messages.map((row: { id: string }) => row.id)).toEqual([target.id, message.id]);
    expect(body.paymentEntry).toMatchObject({ state: "ready", bankMessageId });
    expect(mocks.paymentEntry).toHaveBeenCalledExactlyOnceWith(expect.any(Object), ownerId, bankMessageId);
    expect(mocks.choices).toHaveBeenCalledExactlyOnceWith(profile, { synthetic: true }, target);
    expect(mocks.turn).not.toHaveBeenCalled();
  });

  it("keeps missing and foreign alert links neutral and never substitutes a later payment's answer choices", async () => {
    const response = await GET(new Request("https://fictional.example/api/chat?payment=11111111-1111-4111-8111-111111111111"));
    expect(await response.json()).toMatchObject({ ok: true, paymentEntry: { state: "unavailable" } });
    expect(mocks.choices).toHaveBeenCalledExactlyOnceWith(profile, { synthetic: true }, undefined);
  });

  it("does not resolve the source before authentication or invitation checks", async () => {
    for (const status of [401, 403]) {
      mocks.auth.mockResolvedValue(status === 401 ? null : { id: ownerId });
      mocks.open.mockResolvedValue("not_invited");
      const response = await GET(new Request("https://fictional.example/api/chat?payment=11111111-1111-4111-8111-111111111111"));
      expect(response.status).toBe(status);
      expect(mocks.paymentEntry).not.toHaveBeenCalled();
    }
  });

  it("loads the selected payment independently without history, profile or answer-choice work", async () => {
    const payment = "11111111-1111-4111-8111-111111111111";
    const target = { ...message, paymentNotice: { bankMessageId: payment, requiresPurpose: true } };
    mocks.paymentEntry.mockResolvedValue({ state: "ready", bankMessageId: payment, sourceVersion: "fictional-version", message: target });
    const response = await GET(new Request(`https://fictional.example/api/chat?payment=${payment}&part=payment`));
    expect(await response.json()).toMatchObject({ ok: true, part: "payment", messages: [{ id: target.id }], paymentEntry: { sourceVersion: "fictional-version" } });
    expect(mocks.history).not.toHaveBeenCalled(); expect(mocks.profile).not.toHaveBeenCalled(); expect(mocks.choices).not.toHaveBeenCalled();
    expect(mocks.paymentEntry).toHaveBeenCalledExactlyOnceWith(expect.any(Object), ownerId, payment);
  });

  it("loads optional history without repeating the selected source or choices", async () => {
    const response = await GET(new Request("https://fictional.example/api/chat?part=history"));
    expect(await response.json()).toMatchObject({ ok: true, part: "history", messages: [{ id: message.id }] });
    expect(mocks.history).toHaveBeenCalledExactlyOnceWith(ownerId, 80);
    expect(mocks.paymentEntry).not.toHaveBeenCalled(); expect(mocks.profile).not.toHaveBeenCalled(); expect(mocks.choices).not.toHaveBeenCalled();
  });

  it.each([
    ["no history", [], false],
    ["ordinary assistant", [{ ...message, intent: "chat:money" }], false],
    ["latest user", [{ ...message, role: "user" }], false],
    ["bank question", [message], true],
    ["open payment purpose", [{ ...message, paymentNotice: { bankMessageId: "11111111-1111-4111-8111-111111111111", requiresPurpose: true } }], true],
    ["closed payment purpose", [{ ...message, paymentNotice: { bankMessageId: "11111111-1111-4111-8111-111111111111", requiresPurpose: false } }], false],
    ["notice without purpose metadata", [{ ...message, intent: "automation:outgoing-payment" }], false],
  ])("derives the choices hint from the same owned history for %s", async (_scenario, history, choicesNeeded) => {
    mocks.history.mockResolvedValue(history);
    const response = await GET(new Request("https://fictional.example/api/chat?part=history"));
    expect(await response.json()).toMatchObject({ ok: true, ownerId, part: "history", choicesNeeded });
    expect(mocks.history).toHaveBeenCalledExactlyOnceWith(ownerId, 80);
    expect(mocks.profile).not.toHaveBeenCalled(); expect(mocks.choices).not.toHaveBeenCalled();
  });

  it("loads current selected choices without repeating 80-message history or transfer augmentation", async () => {
    const payment = "11111111-1111-4111-8111-111111111111";
    const target = { ...message, paymentNotice: { bankMessageId: payment, requiresPurpose: true } };
    mocks.paymentEntry.mockResolvedValue({ state: "ready", bankMessageId: payment, sourceVersion: "fictional-version", message: target });
    const response = await GET(new Request(`https://fictional.example/api/chat?payment=${payment}&part=choices`));
    expect(await response.json()).toMatchObject({ ok: true, part: "choices", messages: [], choices: [[choice]], choiceTarget: payment, sourceVersion: "fictional-version" });
    expect(mocks.history).not.toHaveBeenCalled();
    expect(mocks.paymentEntry).toHaveBeenCalledExactlyOnceWith(expect.any(Object), ownerId, payment, expect.objectContaining({ loadTransfer: expect.any(Function) }));
  });

  it("bounds stalled auth as unavailable rather than falsely treating the user as signed out", async () => {
    vi.useFakeTimers();
    try {
      mocks.auth.mockReturnValue(new Promise(() => undefined));
      const pending = GET(new Request("https://fictional.example/api/chat?part=payment"));
      await vi.advanceTimersByTimeAsync(8000);
      const response = await pending;
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ ok: false, text: expect.stringContaining("check your sign-in") });
      expect(mocks.history).not.toHaveBeenCalled(); expect(mocks.paymentEntry).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});

describe("Chat choice submission contract", () => {
  it("rejects an old UI's owner assertion before any account, rate-limit or financial action", async () => {
    const response = await POST(new Request("https://fictional.example/api/chat", { method: "POST", body: JSON.stringify({ text: "yes", clientId: "old-owner-turn", expectedOwnerId: "00000000-0000-4000-8000-000000000002", replyToPayment: { bankMessageId: "11111111-1111-4111-8111-111111111111", requiresPurpose: true } }) }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, sessionChanged: true });
    expect(mocks.open).not.toHaveBeenCalled(); expect(mocks.allow).not.toHaveBeenCalled(); expect(mocks.profile).not.toHaveBeenCalled(); expect(mocks.turn).not.toHaveBeenCalled();
  });

  it("accepts a matching owner fence without passing it into action interpretation", async () => {
    const response = await POST(new Request("https://fictional.example/api/chat", { method: "POST", body: JSON.stringify({ choice: choice.choice, clientId: "same-owner-turn", expectedOwnerId: ownerId.toUpperCase() }) }));
    expect(response.status).toBe(200);
    expect(mocks.turn).toHaveBeenCalledExactlyOnceWith(profile, { choice: choice.choice, clientId: "same-owner-turn" }, { synthetic: true });
  });
  it("preserves both next-payment choices and actual-write metadata", async () => {
    const response = await POST(new Request("http://localhost/api/chat", { method: "POST", body: JSON.stringify({ choice: choice.choice, clientId: "synthetic-choice-submit" }) }));
    expect(response.status).toBe(200);
    expect(mocks.turn).toHaveBeenCalledExactlyOnceWith(profile, { choice: choice.choice, clientId: "synthetic-choice-submit" }, { synthetic: true });
    expect(await response.json()).toMatchObject({ ok: true, choices: [[choice]], ledgerChanged: true, messages: [{ ledgerChanged: true }] });
  });

  it("forwards a no-op outcome without turning it into a financial change", async () => {
    mocks.turn.mockResolvedValue({ text: "Already sorted", messages: [], choices: [], ledgerChanged: false });
    const response = await POST(new Request("http://localhost/api/chat", { method: "POST", body: JSON.stringify({ choice: choice.choice, clientId: "synthetic-choice-noop" }) }));
    expect(await response.json()).toMatchObject({ ok: true, choices: [], ledgerChanged: false });
  });
});
