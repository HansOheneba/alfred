import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseSettings } from "@/lib/config";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/supabase/connection", () => ({ query: mocks.query }));
import { collectorRequestAllowed, logCollectorRejection } from "@/lib/bank/collector-requests";

const settings = { projectRef: "fixture" } as unknown as SupabaseSettings;
const key = "alf_" + "x".repeat(24), otherKey = "alf_" + "y".repeat(24);
const now = Date.parse("2026-11-03T18:00:00.000Z");
const entries = new Map<string, { start: number; hits: number }>();
const request = (endpoint = "account", ip = "192.0.2.7") => new Request(`https://alfred.test/api/collector/${endpoint}`, { headers: { "x-forwarded-for": ip } });
const allow = (token: string | null = key, endpoint = "account", ip = "192.0.2.7", time = now) => collectorRequestAllowed(settings, request(endpoint, ip), token, time);
beforeEach(() => {
  entries.clear();
  mocks.query.mockImplementation(async (_settings: unknown, _sql: string, [bucket, time, window]: [string, number, number]) => {
    const current = entries.get(bucket);
    const entry = !current || current.start < time - window ? { start: time, hits: 1 } : { start: current.start, hits: current.hits + 1 };
    entries.set(bucket, entry);
    return [{ hits: entry.hits }];
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("bounded collector request throttling", () => {
  it("shares the exact key's 60/min allowance between account identity and health", async () => {
    for (let n = 0; n < 60; n++) expect(await allow(key, n % 2 ? "account" : "health")).toBe(true);
    expect(await allow(key, "health")).toBe(false);
    expect(await allow(otherKey, "account")).toBe(true);
    expect(await allow(key, "account", "192.0.2.8")).toBe(false);
  });
  it("shares a client's 120/min allowance across different keys and endpoints", async () => {
    for (let n = 0; n < 120; n++) expect(await allow(null, n % 2 ? "account" : "health")).toBe(true);
    expect(await allow(otherKey, "health")).toBe(false);
    expect(await allow(otherKey, "health", "192.0.2.8")).toBe(true);
  });
  it("enforces the global ceiling before any client or key bucket", async () => {
    entries.set("collector:requests", { start: now, hits: 1200 });
    expect(await allow(otherKey, "health", "192.0.2.50")).toBe(false);
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect([...entries.keys()]).toEqual(["collector:requests"]);
  });
  it("recovers a request allowance only after its window expires", async () => {
    for (let n = 0; n < 60; n++) expect(await allow()).toBe(true);
    expect(await allow()).toBe(false);
    expect(await allow(key, "health", "192.0.2.7", now + 60_001)).toBe(true);
  });
  it("a deliberate synthetic hash-slot collision only throttles earlier", async () => {
    const first = "alf_000000000000000000000004", second = "alf_000000000000000000000018";
    for (let n = 0; n < 59; n++) expect(await allow(first)).toBe(true);
    expect(await allow(second)).toBe(true);
    expect(await allow(first)).toBe(false);
    expect(await allow(second)).toBe(false);
    expect(entries.get("collector:key:a9b")?.hits).toBe(62);
    expect([...entries.keys()].filter(value => value.startsWith("collector:key:"))).toEqual(["collector:key:a9b"]);
  });
  it("keeps request headers, keys and addresses out of database parameters and logs", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {}), error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await allow()).toBe(true);
    for (const [, sql, values] of mocks.query.mock.calls) {
      expect(sql).toContain("public.api_rate_limits");
      expect(sql).not.toMatch(/ingest_tokens|profiles|auth\.users|collector_health|transactions|bank_messages/);
      expect(values[0]).toMatch(/^collector:(requests|client:[0-9a-f]{2}|key:[0-9a-f]{3})$/);
    }
    expect(JSON.stringify(mocks.query.mock.calls)).not.toMatch(/alf_|192\.0\.2|Bearer/);
    expect(info).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
  });
  it.each(["", "not-an-ip", "192.0.2.7".repeat(40)])("groups missing or invalid addresses into one fallback: %s", async ip => {
    expect(await allow(null, "account", ip)).toBe(true);
    expect([...entries.keys()]).toContain("collector:client:unknown");
  });
  it("uses the first advisory address but a rotated header never bypasses a key budget", async () => {
    expect(await allow(key, "account", "192.0.2.7, 192.0.2.8")).toBe(true);
    for (let n = 1; n < 60; n++) expect(await allow(key, "health", `192.0.2.${n}`)).toBe(true);
    expect(await allow(key, "account", "192.0.2.200")).toBe(false);
  });
  it("bounds cardinality when syntactically valid fake credentials and client headers rotate", async () => {
    // Every value could be an unauthenticated guess. No raw-token-addressed row
    // can accumulate forever; both classes use a finite bucket namespace.
    for (let n = 0; n < 1200; n++) {
      await allow("alf_" + n.toString().padStart(24, "0"), "account", `198.51.${Math.floor(n / 256)}.${n % 256}`);
    }
    expect([...entries.keys()].filter(value => value.startsWith("collector:client:")).length).toBeLessThanOrEqual(256);
    expect([...entries.keys()].filter(value => value.startsWith("collector:key:")).every(value => /^collector:key:[0-9a-f]{3}$/.test(value))).toBe(true);
    const count = entries.size;
    expect(await allow("alf_" + "z".repeat(24), "health", "203.0.113.42")).toBe(false);
    expect(entries.size).toBe(count);
  });
  it("makes no key bucket for missing or malformed credentials", async () => {
    expect(await allow(null)).toBe(true); expect(await allow("Bearer bad")).toBe(true);
    expect([...entries.keys()].some(value => value.startsWith("collector:key:"))).toBe(false);
  });
  it("propagates limiter failures without logging the database exception", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {}), error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.query.mockRejectedValue(Error(`${key} private@example.invalid`));
    await expect(allow()).rejects.toThrow();
    expect(info).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
  });
  it("logs fixed reason fields alone", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    logCollectorRejection("account", "invalid_key"); logCollectorRejection("health", "rate_limited");
    expect(info.mock.calls.map(call => JSON.parse(call[0]))).toEqual([
      { level: "info", event: "collector_request_rejected", endpoint: "account", reason: "invalid_key" },
      { level: "info", event: "collector_request_rejected", endpoint: "health", reason: "rate_limited" },
    ]);
  });
});
