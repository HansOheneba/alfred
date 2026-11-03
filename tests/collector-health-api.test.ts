import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ query: vi.fn(), owner: vi.fn() }));
vi.mock("@/lib/supabase/connection", () => ({ query: mocks.query }));
vi.mock("@/lib/web/api", () => ({ requireOwner: mocks.owner }));
vi.mock("@/lib/env", () => ({ getDatabaseSettings: () => ({ fixture: true }) }));
import { GET, POST } from "@/app/api/collector/health/route";
import { collectorHealthOwner, loadCollectorHealth, parseCollectorHealth, readCollectorHealthBody } from "@/lib/bank/collector-health";
import { hashIngestToken } from "@/lib/bank/store";
import type { SupabaseSettings } from "@/lib/config";

const a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", device = "11111111-1111-4111-8111-111111111111";
const token = "alf_" + "x".repeat(24), base = "https://alfred.test/api/collector/health";
const settings = { fixture: true } as unknown as SupabaseSettings;
const counts = () => ({ sourceQuarantine: 0, unreadable: 0, incomplete: 0, heldForReview: 0, pending: 0 });
const report = () => ({ version: 1, deviceId: device, state: "ready", counts: counts(), lastSuccessfulCaptureAt: new Date(Date.now() - 60_000).toISOString(), lastAcceptedAt: null });
const headers = () => ({ authorization: `Bearer ${token}`, "x-alfred-collector-owner": a, "content-type": "application/json" });
const request = (body: unknown = report(), patch: Record<string, string> = {}) => new Request(base, { method: "POST", headers: { ...headers(), ...patch }, body: JSON.stringify(body) });
const row = () => ({ device_id: device, state: "ready", source_quarantine_count: 0, unreadable_count: 0, incomplete_count: 0, held_for_review_count: 0, pending_count: 0, last_seen_at: new Date(), last_successful_capture_at: new Date(Date.now() - 60_000), last_accepted_at: null });
function streaming(chunks: Uint8Array[], patch: Record<string, string> = {}, cancel = vi.fn()) {
  const body = new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); }, cancel });
  return { request: new Request(base, { method: "POST", headers: { ...headers(), ...patch }, body, duplex: "half" } as RequestInit), cancel };
}
beforeEach(() => {
  mocks.owner.mockResolvedValue({ profile: { profileId: a }, settings: { supabase: settings } });
  mocks.query.mockImplementation(async (_settings: unknown, sql: string) => sql.includes("from public.ingest_tokens") ? [{ owner_id: a }] : sql.includes("alfred_record_collector_health") ? [{ result: "stored" }] : [row()]);
});
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("collector health authentication and privacy", () => {
  it("stores only safe counts for the authenticated and confirmed owner", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true });
    expect(mocks.query).toHaveBeenCalledTimes(2);
    const [auth, write] = mocks.query.mock.calls;
    expect(auth[1]).toMatch(/^select owner_id/); expect(auth[2]).toEqual([hashIngestToken(token)]);
    expect(write[1]).toContain("alfred_record_collector_health"); expect(write[2].slice(0, 8)).toEqual([a, device, "ready", 0, 0, 0, 0, 0]);
    expect(JSON.stringify(mocks.query.mock.calls)).not.toContain(token);
    expect(JSON.stringify(mocks.query.mock.calls)).not.toMatch(/last_used_at|last_empty_at|bank_messages|transactions/);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it.each(["", "Bearer wrong", `Basic ${token}`])("rejects malformed authentication %s before any read/write", async authorization => {
    expect((await POST(request(report(), { authorization }))).status).toBe(401); expect(mocks.query).not.toHaveBeenCalled();
  });
  it("does not let a caller select another owner", async () => {
    expect((await POST(request(report(), { "x-alfred-collector-owner": b }))).status).toBe(409);
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls[0][1]).toMatch(/^select /);
  });
  it.each(["", "other"]) ("requires a confirmed owner UUID %s", async expectedOwner => {
    expect((await POST(request(report(), { "x-alfred-collector-owner": expectedOwner }))).status).toBe(400); expect(mocks.query).not.toHaveBeenCalled();
  });
  it("rejects invalid and ambiguously owned keys", async () => {
    mocks.query.mockResolvedValue([]); expect((await POST(request())).status).toBe(401);
    mocks.query.mockResolvedValue([{ owner_id: a }, { owner_id: b }]); expect(await collectorHealthOwner(settings, token)).toBeNull();
  });
  it("rejects a foreign browser origin and URL parameters", async () => {
    expect((await POST(request(report(), { origin: "https://other.invalid" }))).status).toBe(403);
    expect((await POST(new Request(base + "?ownerId=" + b, { method: "POST", headers: headers(), body: JSON.stringify(report()) }))).status).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it.each(["raw", "sender", "guid", "rowId", "credentialHash", "error", "ownerId", "key"])("never accepts extra private field %s", async field => {
    expect((await POST(request({ ...report(), [field]: "private-fixture" }))).status).toBe(400); expect(mocks.query).not.toHaveBeenCalled();
  });
  it("rejects private or arbitrary nested count fields", async () => {
    expect((await POST(request({ ...report(), counts: { ...counts(), raw: "private-fixture" } }))).status).toBe(400); expect(mocks.query).not.toHaveBeenCalled();
  });
  it.each([-1, 1.5, 1_000_001, "1"])("rejects unsafe count %s", async pending => {
    expect((await POST(request({ ...report(), state: "needs_review", counts: { ...counts(), pending } }))).status).toBe(400); expect(mocks.query).not.toHaveBeenCalled();
  });
  it("keeps observed problems visible and requires an actual successful capture before ready", () => {
    expect(() => parseCollectorHealth({ ...report(), counts: { ...counts(), sourceQuarantine: 1 } })).toThrow();
    expect(() => parseCollectorHealth({ ...report(), lastSuccessfulCaptureAt: null })).toThrow();
    expect(() => parseCollectorHealth({ ...report(), state: "needs_review", counts: { ...counts(), sourceQuarantine: 1, unreadable: 1, incomplete: 1 } })).toThrow();
    expect(() => parseCollectorHealth({ ...report(), state: "needs_review", counts: { ...counts(), heldForReview: 1 } })).toThrow();
    expect(parseCollectorHealth({ ...report(), state: "capture_error", lastSuccessfulCaptureAt: null }).state).toBe("capture_error");
  });
  it("rejects future, invalid-calendar and free-form error timestamps", () => {
    for (const value of [new Date(Date.now() + 6 * 60_000).toISOString(), "2026-02-31T00:00:00.000Z", "private error detail"]) expect(() => parseCollectorHealth({ ...report(), lastSuccessfulCaptureAt: value })).toThrow();
  });
  it.each([["too_soon", 429], ["device_limit", 409]])("reports bounded storage outcome %s", async (result, status) => {
    mocks.query.mockImplementation(async (_settings: unknown, sql: string) => sql.includes("from public.ingest_tokens") ? [{ owner_id: a }] : [{ result }]);
    expect((await POST(request())).status).toBe(status);
  });
  it("does not reflect credentials, SMS or arbitrary database errors", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {}), info = vi.spyOn(console, "info").mockImplementation(() => {});
    mocks.query.mockRejectedValue(Error(`${token} private-SMS-fixture raw-key`));
    const response = await POST(request()); expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/alf_|private-SMS|raw-key/); expect(error).not.toHaveBeenCalled(); expect(info).not.toHaveBeenCalled();
  });
  it("GET requires a signed-in owner even with a valid collector key", async () => {
    mocks.owner.mockResolvedValue(Response.json({ ok: false }, { status: 401 }));
    const response = await GET(new Request(base, { headers: { authorization: `Bearer ${token}` } }));
    expect(response.status).toBe(401); expect(mocks.query).not.toHaveBeenCalled(); expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it("returns only the signed-in owner's count metadata and an authoritative check time", async () => {
    mocks.query.mockResolvedValue([{ ...row(), raw: "never-return", credential_hash: "never-return", firstQuarantinedSourceRowID: 999 }]);
    const response = await GET(new Request(base)), body = await response.json();
    expect(body).toMatchObject({ ok: true, ownerId: a, devices: [{ deviceId: device, state: "ready", counts: counts(), lastAcceptedAt: null }] });
    expect(Number.isFinite(Date.parse(body.checkedAt))).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/never-return|QuarantinedSourceRowID|credential_hash|raw/);
    expect(mocks.query.mock.calls[0][1]).toContain("where owner_id=$1::uuid"); expect(mocks.query.mock.calls[0][2]).toEqual([a]);
  });
  it("rejects caller-chosen GET account parameters and handles absent status rows", async () => {
    expect((await GET(new Request(base + "?ownerId=" + b))).status).toBe(400); expect(mocks.query).not.toHaveBeenCalled();
    mocks.query.mockResolvedValue([]); expect(await loadCollectorHealth(settings, a)).toEqual([]);
  });
});

describe("bounded health request parsing", () => {
  it("enforces actual bytes and cancels oversized streams despite a false small length", async () => {
    const value = streaming([new Uint8Array(4097)], { "content-length": "1" });
    expect((await POST(value.request)).status).toBe(400); expect(value.cancel).toHaveBeenCalled(); expect(mocks.query).not.toHaveBeenCalled();
  });
  it("counts UTF-8 bytes and permits exactly the byte boundary", async () => {
    const prefix = '{"padding":"', suffix = '"}', payload = prefix + "x".repeat(4096 - prefix.length - suffix.length) + suffix;
    expect(await readCollectorHealthBody(new Request(base, { method: "POST", headers: headers(), body: payload }))).toHaveProperty("padding");
    const tooLarge = streaming([new TextEncoder().encode(JSON.stringify({ padding: "₵".repeat(1400) }))]);
    await expect(readCollectorHealthBody(tooLarge.request)).rejects.toThrow("too large"); expect(tooLarge.cancel).toHaveBeenCalled();
  });
  it("rejects unsupported content types, invalid UTF-8 and oversized declared lengths", async () => {
    await expect(readCollectorHealthBody(request(report(), { "content-type": "text/plain" }))).rejects.toThrow();
    const bytes = streaming([new Uint8Array([0xff])]);
    const reader = bytes.request.body!.getReader(); await reader.cancel(); reader.releaseLock();
    const malformed = new Request(base, { method: "POST", headers: headers(), body: new Uint8Array([0xff]) });
    await expect(readCollectorHealthBody(malformed)).rejects.toThrow();
    await expect(readCollectorHealthBody(request(report(), { "content-length": "4097" }))).rejects.toThrow();
  });
  it("bounds a stalled request independently of content length", async () => {
    vi.useFakeTimers();
    const value = streaming([]);
    const pending = expect(readCollectorHealthBody(value.request)).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(5_000); await pending; expect(value.cancel).toHaveBeenCalled();
  });
});
