import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ owner: vi.fn(), ingest: vi.fn(), claim: vi.fn(), complete: vi.fn(), release: vi.fn(), after: vi.fn(), query: vi.fn(), preferences: vi.fn(), mentions: vi.fn(), recover: vi.fn(), drain: vi.fn() }));
vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/lib/bank/service", () => ({ ownerForToken: mocks.owner, ingestBankMessages: mocks.ingest, announceWhenQuiet: vi.fn() }));
vi.mock("@/lib/bank/collector-receipts", async (load) => ({ ...await load<typeof import("@/lib/bank/collector-receipts")>(), createCollectorReceiptStore: () => ({ claim: mocks.claim, complete: mocks.complete, release: mocks.release }) }));
vi.mock("@/lib/env", () => ({ getDatabaseSettings: () => ({ projectRef: "fixture" }) }));
vi.mock("@/lib/supabase/connection", () => ({ query: mocks.query }));
vi.mock("@/lib/security/db-rate-limit", () => ({ DbRateLimiter: class { async allow() { return true; } } }));
vi.mock("@/lib/notifications/store", () => ({ loadNotificationPreferences: mocks.preferences }));
vi.mock("@/lib/bank/notices", () => ({ recoverIncomingPaymentMentions: mocks.mentions }));
vi.mock("@/lib/notifications/service", () => ({ recoverPaymentNotifications: mocks.recover, drainOwnerNotifications: mocks.drain }));
vi.mock("@/lib/bank/automation", async (load) => {
  const actual = await load<typeof import("@/lib/bank/automation")>();
  return { deliverBankAutomation: vi.fn(actual.deliverBankAutomation) };
});
import { POST, maxDuration } from "@/app/api/ingest/sms/route";
import { deliverBankAutomation } from "@/lib/bank/automation";

const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", receiptId = "11111111-1111-4111-8111-111111111111", messageId = "22222222-2222-4222-8222-222222222222", claimToken = "33333333-3333-4333-8333-333333333333";
const start = new Date("2026-11-03T12:00:00Z");
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(start);
  mocks.owner.mockImplementation(async () => { vi.setSystemTime(start.getTime() + 3_000); return { profileId: ownerId }; });
  mocks.claim.mockImplementation(async () => { vi.setSystemTime(start.getTime() + 7_000); return { status: "acquired", claimToken }; });
  mocks.ingest.mockImplementation(async () => { vi.setSystemTime(start.getTime() + 12_000); return { outcomes: [], found: 1, duplicates: 0, durableMessageIds: [messageId] }; });
  mocks.complete.mockResolvedValue(receiptId); mocks.release.mockResolvedValue(undefined);
  mocks.preferences.mockResolvedValue({ paymentMentions: false, paymentPush: false, billReminders: false, weeklyOverview: false });
});
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

async function receive(duplicate: boolean) {
  if (duplicate) mocks.claim.mockImplementation(async () => { vi.setSystemTime(start.getTime() + 7_000); return { status: "stored", receiptId }; });
  const response = await POST(new Request("https://alfred.test/api/ingest/sms", { method: "POST", headers: { authorization: "Bearer alf_fixture_only", "content-type": "application/json", "x-alfred-collector-owner": ownerId }, body: JSON.stringify({ protocol: 2, eventId: "a".repeat(64), source: "mac", sender: "mobilemoney", receivedAt: new Date(start.getTime() - 60_000).toISOString(), text: "Fictional payment GHS 25" }) }));
  expect(response.status).toBe(200);
  expect(mocks.after).toHaveBeenCalledOnce();
  return mocks.after.mock.calls[0][0] as () => Promise<void>;
}

describe("SMS background work keeps the original request budget", () => {
  it("retains the original thirty-second route duration", () => { expect(maxDuration).toBe(30); });
  it.each([false, true])("delayed callback keeps the request-start deadline, duplicate=%s", async (duplicate) => {
    const callback = await receive(duplicate);
    expect(deliverBankAutomation).not.toHaveBeenCalled();
    vi.setSystemTime(start.getTime() + 20_000);
    await callback();
    expect(deliverBankAutomation).toHaveBeenCalledExactlyOnceWith(expect.anything(), { profileId: ownerId }, start.getTime() + 25_000);
    expect(mocks.preferences).toHaveBeenCalledOnce();
    expect(mocks.mentions).not.toHaveBeenCalled(); expect(mocks.recover).not.toHaveBeenCalled(); expect(mocks.drain).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it.each([false, true])("expired callback cannot obtain a fresh budget or start preference queries, duplicate=%s", async (duplicate) => {
    const callback = await receive(duplicate);
    vi.setSystemTime(start.getTime() + 26_000);
    await callback();
    expect(deliverBankAutomation).toHaveBeenCalledExactlyOnceWith(expect.anything(), { profileId: ownerId }, start.getTime() + 25_000);
    expect(mocks.preferences).not.toHaveBeenCalled(); expect(mocks.mentions).not.toHaveBeenCalled(); expect(mocks.recover).not.toHaveBeenCalled(); expect(mocks.drain).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
