import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ownerId = "11111111-1111-4111-8111-111111111111", messageId = "22222222-2222-4222-8222-222222222222", presenceId = "33333333-3333-4333-8333-333333333333";
const snapshot = { initialized: true, unreadCount: 2, latestMessageId: messageId, preferences: { messagePush: false, messagePreview: false, messagePushSince: null } };
const mocks = vi.hoisted(() => ({ owner: vi.fn(), available: vi.fn(), snapshot: vi.fn(), initialize: vi.fn(), read: vi.fn(), update: vi.fn(), ready: vi.fn(), push: vi.fn() }));
vi.mock("@/lib/web/api", () => ({ requireOwner: mocks.owner }));
vi.mock("@/lib/notifications/messages", () => ({ createMessageNotificationStore: () => mocks }));
vi.mock("@/lib/notifications/recovery", () => ({ loadRecoveryStatus: mocks.ready }));
vi.mock("@/lib/notifications/push", () => ({ pushConfiguration: mocks.push }));
import { GET, PATCH, POST } from "@/app/api/chat/notifications/route";

function request(method: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://example.test/api/chat/notifications", { method, headers: { origin: "https://example.test", "content-type": "application/json", "x-alfred-owner": ownerId, ...headers }, body: JSON.stringify(body) });
}
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("ALFRED_PUSH_DELIVERY_ENABLED", "true");
  mocks.owner.mockResolvedValue({ profile: { profileId: ownerId }, settings: { supabase: {} } });
  mocks.available.mockResolvedValue(true); mocks.snapshot.mockResolvedValue(snapshot); mocks.read.mockResolvedValue(true);
  mocks.ready.mockResolvedValue({ ready: true }); mocks.push.mockReturnValue({ ready: true });
  mocks.update.mockResolvedValue(snapshot.preferences);
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("owned message notification API", () => {
  it("returns only owned cursor/preferences metadata with private cache controls", async () => {
    const response = await GET(); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ownerId, ...snapshot });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.snapshot).toHaveBeenCalledExactlyOnceWith(ownerId);
  });
  it("does not expose data when signed out or when the local migration is absent", async () => {
    mocks.owner.mockResolvedValueOnce(new Response(null, { status: 401 })); expect((await GET()).status).toBe(401); expect(mocks.snapshot).not.toHaveBeenCalled();
    mocks.available.mockResolvedValueOnce(false); expect((await GET()).status).toBe(503); expect(mocks.snapshot).not.toHaveBeenCalled();
  });
  it("rejects cross-origin and stale-owner mutations before they can read or write state", async () => {
    expect((await POST(request("POST", { op: "initialize" }, { origin: "https://other.test" }))).status).toBe(403);
    expect((await POST(request("POST", { op: "initialize" }, { "x-alfred-owner": messageId }))).status).toBe(409);
    expect(mocks.initialize).not.toHaveBeenCalled(); expect(mocks.snapshot).not.toHaveBeenCalled();
  });
  it("initializes once and records only an exact owned assistant read marker", async () => {
    expect((await POST(request("POST", { op: "initialize" }))).status).toBe(200); expect(mocks.initialize).toHaveBeenCalledExactlyOnceWith(ownerId);
    expect((await POST(request("POST", { op: "read", messageId, presenceId, active: true }))).status).toBe(200);
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith(ownerId, messageId, presenceId, true);
    mocks.read.mockResolvedValueOnce(false); expect((await POST(request("POST", { op: "read", messageId, presenceId, active: true }))).status).toBe(404);
    expect((await POST(request("POST", { op: "read", messageId, presenceId, active: true, ownerId: messageId }))).status).toBe(400);
  });
  it("requires recovery/configuration for new push opt-in but always permits muting", async () => {
    mocks.ready.mockResolvedValueOnce({ ready: false });
    expect((await PATCH(request("PATCH", { messagePush: true }))).status).toBe(503); expect(mocks.update).not.toHaveBeenCalled();
    expect((await PATCH(request("PATCH", { messagePush: false, messagePreview: false }))).status).toBe(200);
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith(ownerId, { messagePush: false, messagePreview: false });
  });
  it("requires explicit preview consent and returns no device endpoints or message body", async () => {
    expect((await PATCH(request("PATCH", { messagePreview: true }))).status).toBe(200);
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith(ownerId, { messagePreview: true });
    expect((await PATCH(request("PATCH", { messagePreview: true, body: "Arbitrary injected copy" }))).status).toBe(400);
  });
});
