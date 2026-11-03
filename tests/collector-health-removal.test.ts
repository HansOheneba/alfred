import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ query: vi.fn(), owner: vi.fn() }));
vi.mock("@/lib/supabase/connection", () => ({ query: mocks.query }));
vi.mock("@/lib/web/api", () => ({ requireOwner: mocks.owner }));
import { DELETE } from "@/app/api/collector/health/devices/route";
import { removeSavedCollectorStatus } from "@/app/settings/collector-health-section";
import { removeCollectorHealth } from "@/lib/bank/collector-health";
import type { SupabaseSettings } from "@/lib/config";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", device = "11111111-1111-4111-8111-111111111111";
const settings = { fixture: true } as unknown as SupabaseSettings;
const url = "https://alfred.example/api/collector/health/devices";
function request(value: unknown = { deviceId: device }, headers: Record<string, string> = {}) {
  return new Request(url, { method: "DELETE", headers: { origin: "https://alfred.example", "x-alfred-owner": owner, "content-type": "application/json", ...headers }, body: JSON.stringify(value) });
}
beforeEach(() => {
  mocks.owner.mockResolvedValue({ profile: { profileId: owner }, settings: { supabase: settings } });
  mocks.query.mockResolvedValue([{ removed: true }]);
});
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("owner-confirmed saved Mac status removal", () => {
  it("uses only the signed-in owner and exact selected device", async () => {
    const response = await DELETE(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ownerId: owner, deviceId: device, removed: true });
    expect(mocks.query).toHaveBeenCalledOnce();
    expect(mocks.query).toHaveBeenCalledWith(settings, "select public.alfred_forget_collector_health($1::uuid,$2::uuid) as removed", [owner, device]);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toContain("Cookie");
  });
  it("returns idempotent absence without treating another owner as a target", async () => {
    mocks.query.mockResolvedValue([{ removed: false }]);
    const response = await DELETE(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ownerId: owner, deviceId: device, removed: false });
  });
  it.each(["", "https://other.example", "null"])("rejects missing or foreign origin %s before authentication or storage", async origin => {
    expect((await DELETE(request(undefined, { origin }))).status).toBe(403);
    expect(mocks.owner).not.toHaveBeenCalled(); expect(mocks.query).not.toHaveBeenCalled();
  });
  it("does not accept a forwarding key instead of an authenticated session", async () => {
    mocks.owner.mockResolvedValue(Response.json({ ok: false }, { status: 401 }));
    const response = await DELETE(request(undefined, { authorization: "Bearer alf_" + "x".repeat(24) }));
    expect(response.status).toBe(401); expect(mocks.query).not.toHaveBeenCalled();
  });
  it("rejects a changed or unbound displayed account before reading the body or writing", async () => {
    for (const displayed of [other, ""]) expect((await DELETE(request(undefined, { "x-alfred-owner": displayed }))).status).toBe(409);
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it.each([{ deviceId: "not-a-device" }, { deviceId: device, ownerId: other }, { deviceId: device, raw: "private-fixture" }, { deviceId: device, stopCollector: true }])("rejects arbitrary body fields or invalid selection %j", async body => {
    expect((await DELETE(request(body))).status).toBe(400); expect(mocks.query).not.toHaveBeenCalled();
  });
  it("bounds the actual JSON bytes and rejects query parameters", async () => {
    expect((await DELETE(request({ deviceId: device, extra: "x".repeat(4097) }, { "content-length": "1" }))).status).toBe(400);
    const queryRequest = new Request(url + "?owner=" + other, { method: "DELETE", headers: { origin: "https://alfred.example" } });
    expect((await DELETE(queryRequest)).status).toBe(403); expect(mocks.query).not.toHaveBeenCalled();
  });
  it("fails closed without reflecting database details or pretending success", async () => {
    mocks.query.mockRejectedValue(Error("private-fixture forwarded key"));
    const response = await DELETE(request());
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("private-fixture");
    mocks.query.mockResolvedValue([]); await expect(removeCollectorHealth(settings, owner, device)).rejects.toThrow("unavailable");
    mocks.query.mockResolvedValue([{ removed: "true" }]); await expect(removeCollectorHealth(settings, owner, device)).rejects.toThrow("unavailable");
  });
});

describe("private status-removal browser request", () => {
  it("binds the selected device to the displayed account and carries cancellation", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async () => Response.json({ ok: true, ownerId: owner, deviceId: device, removed: true })); vi.stubGlobal("fetch", fetcher);
    expect(await removeSavedCollectorStatus(owner, device, controller.signal)).toBe(true);
    expect(fetcher).toHaveBeenCalledWith("/api/collector/health/devices", expect.objectContaining({ method: "DELETE", credentials: "same-origin", cache: "no-store", signal: controller.signal, headers: { "content-type": "application/json", "x-alfred-owner": owner }, body: JSON.stringify({ deviceId: device }) }));
  });
  it.each([{ ok: true, ownerId: other, deviceId: device, removed: true }, { ok: true, ownerId: owner, deviceId: other, removed: true }, { ok: true, ownerId: owner, deviceId: device, removed: "yes" }, { ok: false, text: "private-fixture" }])("rejects stale-account/device or malformed responses %j", async result => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(result)));
    await expect(removeSavedCollectorStatus(owner, device)).rejects.toThrow("could not be removed");
  });
  it("keeps absent status retries successful and preserves request failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, ownerId: owner, deviceId: device, removed: false })));
    expect(await removeSavedCollectorStatus(owner, device)).toBe(false);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ text: "private-fixture" }, { status: 503 })));
    await expect(removeSavedCollectorStatus(owner, device)).rejects.toThrow("could not be removed");
  });
});
