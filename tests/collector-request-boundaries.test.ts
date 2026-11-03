import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/supabase/connection", () => ({ query: mocks.query }));
vi.mock("@/lib/env", () => ({ getDatabaseSettings: () => ({ projectRef: "fixture" }) }));
vi.mock("@/lib/web/api", () => ({ requireOwner: vi.fn(async () => Response.json({ ok: false }, { status: 401 })) }));
import { GET as account } from "@/app/api/collector/account/route";
import { POST as health } from "@/app/api/collector/health/route";
import { hashIngestToken } from "@/lib/bank/store";

const token = "alf_" + "x".repeat(24), owner = "11111111-1111-4111-8111-111111111111";
const buckets = new Map<string, number>();
const headers = { authorization: `Bearer ${token}`, "x-alfred-collector-owner": owner, "content-type": "application/json", "x-forwarded-for": "192.0.2.7" };
const report = () => ({ version: 1, deviceId: owner, state: "ready", counts: { sourceQuarantine: 0, unreadable: 0, incomplete: 0, heldForReview: 0, pending: 0 }, lastSuccessfulCaptureAt: new Date().toISOString(), lastAcceptedAt: null });
const accountRequest = (authorization = `Bearer ${token}`) => new Request("https://alfred.test/api/collector/account", { headers: { ...headers, authorization } });
const healthRequest = () => new Request("https://alfred.test/api/collector/health", { method: "POST", headers, body: JSON.stringify(report()) });
const identityCalls = () => mocks.query.mock.calls.filter(([, sql]) => /from public\.ingest_tokens|join public\.profiles/.test(sql));

beforeEach(() => {
  buckets.clear();
  vi.spyOn(console, "info").mockImplementation(() => {});
  mocks.query.mockImplementation(async (_settings: unknown, sql: string, values: unknown[]) => {
    if (sql.includes("insert into public.api_rate_limits")) {
      const bucket = values[0] as string, hits = (buckets.get(bucket) ?? 0) + 1;
      buckets.set(bucket, hits); return [{ hits }];
    }
    if (sql.includes("from public.ingest_tokens")) {
      return values[0] !== hashIngestToken(token) ? [] : [{ owner_id: owner, preferred_name: "Fictional reviewer", email: "fixture@example.invalid" }];
    }
    if (sql.includes("alfred_record_collector_health")) return [{ result: "stored" }];
    throw Error("Unexpected synthetic query.");
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("collector route boundaries with real request limiter", () => {
  it("stops an exhausted key before further identity reads or health writes across both routes", async () => {
    for (let n = 0; n < 60; n++) expect((await account(accountRequest())).status).toBe(200);
    expect(identityCalls()).toHaveLength(60);
    const calls = mocks.query.mock.calls.length;
    expect((await health(healthRequest())).status).toBe(429);
    expect(identityCalls()).toHaveLength(60);
    expect(mocks.query.mock.calls.slice(calls).every(([, sql]) => sql.includes("public.api_rate_limits"))).toBe(true);
    expect(mocks.query.mock.calls.some(([, sql]) => sql.includes("alfred_record_collector_health"))).toBe(false);
  });
  it("throttles repeated malformed authentication and performs no account or token lookups", async () => {
    for (let n = 0; n < 120; n++) expect((await account(accountRequest("Bearer wrong"))).status).toBe(401);
    const response = await account(accountRequest("Bearer wrong"));
    expect(response.status).toBe(429); expect(identityCalls()).toHaveLength(0);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect([...buckets.keys()].some(value => value.startsWith("collector:key:"))).toBe(false);
  });
  it("does not disclose identity for unknown syntactically valid keys and logs fixed reason fields", async () => {
    const info = vi.spyOn(console, "info");
    const guessed = "alf_" + "z".repeat(24);
    const response = await account(accountRequest(`Bearer ${guessed}`));
    expect(response.status).toBe(401);
    const output = JSON.stringify({ body: await response.json(), logs: info.mock.calls, queries: mocks.query.mock.calls });
    expect(output).not.toContain(guessed); expect(output).not.toContain("192.0.2.7"); expect(output).not.toContain("fixture@example.invalid");
    expect(info).toHaveBeenCalledWith(JSON.stringify({ level: "info", event: "collector_request_rejected", endpoint: "account", reason: "invalid_key" }));
  });
  it("fails closed before identity lookup when the limiter database fails", async () => {
    const info = vi.spyOn(console, "info");
    mocks.query.mockRejectedValue(Error(`${token} fixture@example.invalid 192.0.2.7`));
    const response = await account(accountRequest());
    expect(response.status).toBe(503); expect(identityCalls()).toHaveLength(0);
    expect(await response.text()).not.toMatch(/alf_|fixture@example|192\.0\.2/);
    expect(info).toHaveBeenCalledWith(JSON.stringify({ level: "info", event: "collector_request_rejected", endpoint: "account", reason: "unavailable" }));
  });
});
