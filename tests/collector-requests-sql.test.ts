import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseSettings } from "@/lib/config";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/supabase/connection", () => ({ query: mocks.query }));
import { collectorRequestAllowed } from "@/lib/bank/collector-requests";

const settings = { projectRef: "synthetic" } as unknown as SupabaseSettings;
const key = "alf_" + "x".repeat(24), otherKey = "alf_" + "y".repeat(24);
const now = Date.parse("2026-11-03T18:00:00.000Z");
const request = new Request("https://alfred.test/api/collector/account", { headers: { "x-forwarded-for": "192.0.2.7" } });
let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  // Use the shipped operational table declaration with the actual DbRateLimiter
  // SQL. This is an embedded database, not a live or multi-session load test.
  const migration = readFileSync("supabase/migrations/20261011170000_accounts.sql", "utf8");
  const table = migration.match(/create table if not exists public\.api_rate_limits \([\s\S]+?\n\);/i)?.[0];
  if (!table) throw Error("Operational rate-limit table declaration is missing.");
  await db.exec(table);
});
beforeEach(async () => {
  await db.exec("truncate public.api_rate_limits");
  mocks.query.mockImplementation(async (_settings: unknown, sql: string, values: unknown[]) => (await db.query(sql, values)).rows);
});
afterAll(async () => { await db.close(); });

describe("collector limits with actual embedded PostgreSQL", () => {
  it("atomically counts requests, limits each key and resets after its window", async () => {
    for (let n = 0; n < 60; n++) expect(await collectorRequestAllowed(settings, request, key, now)).toBe(true);
    expect(await collectorRequestAllowed(settings, request, key, now)).toBe(false);
    expect(await collectorRequestAllowed(settings, request, otherKey, now)).toBe(true);
    expect(await collectorRequestAllowed(settings, request, key, now + 60_000)).toBe(false);
    expect(await collectorRequestAllowed(settings, request, key, now + 60_001)).toBe(true);
    const rows = (await db.query<{ bucket: string; hits: number }>("select bucket,hits from public.api_rate_limits order by bucket")).rows;
    expect(rows).toHaveLength(4);
    expect(rows.filter(row => row.bucket.startsWith("collector:key:")).map(row => row.hits).sort()).toEqual([1, 1]);
    expect(JSON.stringify(rows)).not.toMatch(/alf_|192\.0\.2/);
  });
  it("the global budget rejects before a random key can create a new row", async () => {
    await db.query("insert into public.api_rate_limits(bucket,window_start,hits) values('collector:requests',to_timestamp($1::double precision/1000),1200)", [now]);
    expect(await collectorRequestAllowed(settings, request, key, now)).toBe(false);
    expect((await db.query("select bucket,hits from public.api_rate_limits")).rows).toEqual([{ bucket: "collector:requests", hits: 1201 }]);
  });
});
