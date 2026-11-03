import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ owner: vi.fn(), ingest: vi.fn(), claim: vi.fn(), complete: vi.fn(), release: vi.fn(), after: vi.fn(), query: vi.fn() }));
vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/lib/bank/service", () => ({ ownerForToken: mocks.owner, ingestBankMessages: mocks.ingest, announceWhenQuiet: vi.fn() }));
vi.mock("@/lib/bank/automation", () => ({ deliverBankAutomation: vi.fn() }));
vi.mock("@/lib/bank/collector-receipts", async (load) => ({ ...await load<typeof import("@/lib/bank/collector-receipts")>(), createCollectorReceiptStore: () => ({ claim: mocks.claim, complete: mocks.complete, release: mocks.release }) }));
vi.mock("@/lib/env", () => ({ getDatabaseSettings: () => ({ projectRef: "fixture" }) }));
vi.mock("@/lib/supabase/connection", () => ({ query: mocks.query }));
vi.mock("@/lib/security/db-rate-limit", () => ({ DbRateLimiter: class { async allow() { return true; } } }));
import { POST } from "@/app/api/ingest/sms/route";
import { collectorPayloadHash } from "@/lib/bank/collector-receipts";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", eventId = "a".repeat(64), receiptId = "11111111-1111-4111-8111-111111111111", messageId = "22222222-2222-4222-8222-222222222222", claimToken = "33333333-3333-4333-8333-333333333333";
const input = () => ({ protocol: 2, eventId, source: "mac", sender: "mobilemoney", receivedAt: new Date(Date.now() - 60_000).toISOString(), text: "Fictional payment GHS 25" });
async function send(body: Record<string, unknown> = input(), expectedOwner: string | null = owner) { return POST(new Request("https://alfred.test/api/ingest/sms", { method: "POST", headers: { authorization: "Bearer alf_fixture_only", "content-type": "application/json", ...(expectedOwner !== null ? { "x-alfred-collector-owner": expectedOwner } : {}) }, body: JSON.stringify(body) })); }
beforeEach(() => {
  mocks.owner.mockResolvedValue({ profileId: owner });
  mocks.ingest.mockResolvedValue({ outcomes: [], found: 1, duplicates: 0, durableMessageIds: [messageId] });
  mocks.claim.mockResolvedValue({ status: "acquired", claimToken }); mocks.complete.mockResolvedValue(receiptId); mocks.release.mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {}); vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

describe("collector v2 ingestion boundary", () => {
  it("returns deletion authority only after the owned durable receipt completes", async () => {
    const body = input(), response = await send(body), payload = await response.json();
    expect(response.status).toBe(200);
    expect(mocks.claim).toHaveBeenCalledWith(owner, { eventId, payloadHash: collectorPayloadHash(body.sender, body.receivedAt, body.text) });
    expect(mocks.complete).toHaveBeenCalledWith(owner, expect.anything(), claimToken, [messageId]);
    expect(payload.collectorReceipt).toEqual({ version: 2, ownerId: owner, eventId, payloadHash: collectorPayloadHash(body.sender, body.receivedAt, body.text), receiptId, disposition: "stored" });
    expect(mocks.release).not.toHaveBeenCalled();
    expect(JSON.stringify(payload)).not.toContain(body.text); expect(JSON.stringify(payload)).not.toContain(body.sender);
  });
  it("serves a lost-ACK retry from its original receipt without running ingestion again", async () => {
    mocks.claim.mockResolvedValue({ status: "stored", receiptId });
    const response = await send(); expect(response.status).toBe(200);
    expect((await response.json()).collectorReceipt).toMatchObject({ disposition: "duplicate", receiptId, ownerId: owner, eventId });
    expect(mocks.ingest).not.toHaveBeenCalled(); expect(mocks.complete).not.toHaveBeenCalled();
  });
  it.each(["busy", "conflict"])("retains %s events before invoking financial ingestion", async (status) => {
    mocks.claim.mockResolvedValue({ status }); const response = await send();
    expect(response.status).toBe(409); expect(mocks.ingest).not.toHaveBeenCalled(); expect(mocks.complete).not.toHaveBeenCalled(); expect(mocks.release).not.toHaveBeenCalled();
  });
  it.each([{ found: 0, duplicates: 0, durableMessageIds: [] }, { found: 1, duplicates: 0, durableMessageIds: [] }, { found: 2, duplicates: 1, durableMessageIds: [messageId] }])("holds unrecognized, ignored or partially evidenced text without a receipt", async (result) => {
    mocks.ingest.mockResolvedValue({ outcomes: [], ...result });
    const response = await send(), payload = await response.json();
    expect(response.status).toBe(202); expect(payload.collectorReceipt.disposition).toBe("pending_review"); expect(payload.collectorReceipt.receiptId).toBeUndefined();
    expect(mocks.complete).not.toHaveBeenCalled(); expect(mocks.release).toHaveBeenCalledWith(owner, expect.anything(), claimToken);
  });
  it.each([null, new Error("fixture commit failed")])("cannot acknowledge a failed durable receipt commit", async (failure) => {
    if (failure) mocks.complete.mockRejectedValue(failure); else mocks.complete.mockResolvedValue(null);
    const response = await send(), payload = await response.json();
    expect(response.status).toBe(500); expect(payload.collectorReceipt).toBeUndefined(); expect(mocks.release).toHaveBeenCalled();
  });
  it("keeps a failed ingestion pending and never returns a receipt", async () => {
    mocks.ingest.mockRejectedValue(new Error("fixture ingest failed")); const response = await send();
    expect(response.status).toBe(500); expect(mocks.complete).not.toHaveBeenCalled(); expect(mocks.release).toHaveBeenCalled();
  });
  it("ignores a submitted owner selector and uses only forwarding-key ownership", async () => {
    const response = await send({ ...input(), ownerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
    expect(response.status).toBe(200); expect(mocks.claim.mock.calls[0][0]).toBe(owner); expect((await response.json()).collectorReceipt.ownerId).toBe(owner);
  });
  it("uses only the exact top-level hashed fields even when legacy aliases appear first", async () => {
    const canonical = input();
    const body = { message: "Different fictional GHS 999", from: "Different Sender", body: "Another alias", ...canonical };
    const response = await send(body), payload = await response.json();
    expect(response.status).toBe(200);
    expect(mocks.ingest).toHaveBeenCalledWith(expect.anything(), expect.anything(), canonical.text, { channel: "mac", sender: canonical.sender, receivedAt: new Date(canonical.receivedAt) });
    expect(payload.collectorReceipt.payloadHash).toBe(collectorPayloadHash(canonical.sender, canonical.receivedAt, canonical.text));
  });
  it.each([
    { text: undefined, message: { content: "Nested fictional GHS 9" } },
    { sender: undefined, message: { text: "Nested fictional text", from: "mobilemoney" } },
    { receivedAt: undefined, message: { receivedAt: new Date(Date.now() - 60_000).toISOString() } },
  ])("rejects nested-only protocol fields instead of accepting a wrapper", async (patch) => {
    const response = await send({ ...input(), ...patch });
    expect(response.status).toBe(400); expect(mocks.ingest).not.toHaveBeenCalled(); expect(mocks.claim).not.toHaveBeenCalled();
  });
  it.each(["  Fictional GHS 25 👩🏽‍💻 e\u0301\n", "😀".repeat(2000), "x".repeat(4000)])("does not trim, normalize or truncate protocol text before ingestion", async (text) => {
    const body = { ...input(), sender: " MobileMoney ", text };
    const response = await send(body), payload = await response.json();
    expect(response.status).toBe(200);
    expect(mocks.ingest).toHaveBeenCalledWith(expect.anything(), expect.anything(), text, expect.objectContaining({ sender: body.sender }));
    expect(payload.collectorReceipt.payloadHash).toBe(collectorPayloadHash(body.sender, body.receivedAt, text));
    expect(JSON.stringify(payload)).not.toContain(text);
  });
  it("checks the confirmed recipient assertion before any ingestion or receipt claim", async () => {
    const response = await send(input(), "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    expect(response.status).toBe(409); expect(mocks.ingest).not.toHaveBeenCalled(); expect(mocks.claim).not.toHaveBeenCalled();
  });
  it.each([null, "invalid-owner", ""]) ("requires a valid protocol2 recipient assertion: %j", async (expectedOwner) => {
    const response = await send(input(), expectedOwner); expect(response.status).toBe(400);
    expect(mocks.ingest).not.toHaveBeenCalled(); expect(mocks.owner).not.toHaveBeenCalled();
  });
  it.each([{ eventId: "bad" }, { protocol: true }, { source: "shortcut" }, { text: "x".repeat(4001) }, { receivedAt: "2099-01-01T00:00:00Z" }])("rejects malformed protocol metadata instead of truncating or changing it", async (patch) => {
    const response = await send({ ...input(), ...patch }); expect(response.status).toBe(400); expect(mocks.ingest).not.toHaveBeenCalled(); expect(mocks.claim).not.toHaveBeenCalled();
  });
  it("preserves legacy Shortcut response behavior without pretending it is a v2 receipt", async () => {
    const response = await send({ text: "Fictional legacy GHS 25" });
    expect(response.status).toBe(200); expect((await response.json()).collectorReceipt).toBeUndefined(); expect(mocks.claim).not.toHaveBeenCalled();
  });
});
