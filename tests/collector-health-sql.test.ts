import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const device = (index = 1) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
let db: PGlite;
beforeEach(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create table public.profiles(id uuid primary key); insert into profiles values('${a}'),('${b}');`);
  await db.exec(readFileSync("supabase/migrations/20261103210000_collector_health.sql", "utf8"));
});
afterEach(async () => { await db.close(); });
type Draft = { owner?: string; id?: string; state?: string; source?: number; unreadable?: number; incomplete?: number; held?: number; pending?: number; captured?: string | null; accepted?: string | null };
async function record(value: Draft = {}) {
  const params = [value.owner ?? a, value.id ?? device(), value.state ?? "ready", value.source ?? 0, value.unreadable ?? 0, value.incomplete ?? 0, value.held ?? 0, value.pending ?? 0, value.captured === undefined ? new Date(Date.now() - 60_000).toISOString() : value.captured, value.accepted ?? null];
  return (await db.query<{ result: string }>("select public.alfred_record_collector_health($1::uuid,$2::uuid,$3,$4::integer,$5::integer,$6::integer,$7::integer,$8::integer,$9::timestamptz,$10::timestamptz) as result", params)).rows[0].result;
}
async function allowNextReport(owner = a, id = device()) { await db.query("update collector_health set last_seen_at=now()-interval '1 minute' where owner_id=$1::uuid and device_id=$2::uuid", [owner, id]); }

describe("bounded owner-scoped collector operational status", () => {
  it("stores counts, enum, opaque ID and separate timestamps without any payload fields", async () => {
    expect(await record()).toBe("stored");
    const rows = (await db.query<{ last_seen_at: Date; last_successful_capture_at: Date; last_accepted_at: Date | null }>("select * from collector_health")).rows;
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ owner_id: a, device_id: device(), state: "ready", source_quarantine_count: 0, held_for_review_count: 0 });
    expect(rows[0].last_seen_at).not.toBeNull(); expect(rows[0].last_successful_capture_at).not.toBeNull(); expect(rows[0].last_accepted_at).toBeNull();
    const columns = (await db.query<{ column_name: string }>("select column_name from information_schema.columns where table_name='collector_health'")).rows.map(row => row.column_name);
    expect(columns.join(",")).not.toMatch(/raw|sender|guid|rowid|hash|token|error|email|name/i);
  });
  it("does not overwrite status for reports faster than the configured cadence", async () => {
    await record();
    const before = (await db.query("select * from collector_health")).rows;
    expect(await record({ state: "capture_error", captured: null })).toBe("too_soon");
    expect((await db.query("select * from collector_health")).rows).toEqual(before);
  });
  it("keeps successful capture and accepted delivery independent of a later error check-in", async () => {
    const captured = new Date(Date.now() - 120_000).toISOString(), accepted = new Date(Date.now() - 60_000).toISOString();
    await record({ captured, accepted }); await allowNextReport();
    expect(await record({ state: "capture_error", captured: null, accepted: null })).toBe("stored");
    const row = (await db.query<{ state: string; last_seen_at: Date; last_successful_capture_at: Date; last_accepted_at: Date }>("select * from collector_health")).rows[0];
    expect(row.state).toBe("capture_error");
    expect(row.last_successful_capture_at.toISOString()).toBe(captured); expect(row.last_accepted_at.toISOString()).toBe(accepted);
    expect(row.last_seen_at.getTime()).toBeGreaterThan(Date.parse(accepted));
  });
  it("cannot regress capture or acceptance timestamps with a delayed older report", async () => {
    const latest = new Date(Date.now() - 60_000).toISOString();
    await record({ captured: latest, accepted: latest }); await allowNextReport();
    expect(await record({ captured: new Date(Date.now() - 180_000).toISOString(), accepted: new Date(Date.now() - 120_000).toISOString() })).toBe("stored");
    const row = (await db.query<{ last_successful_capture_at: Date; last_accepted_at: Date }>("select last_successful_capture_at,last_accepted_at from collector_health")).rows[0];
    expect(row.last_successful_capture_at.toISOString()).toBe(latest); expect(row.last_accepted_at.toISOString()).toBe(latest);
  });
  it("caps each owner independently while allowing existing Macs to report", async () => {
    for (let index = 1; index <= 5; index++) expect(await record({ id: device(index) })).toBe("stored");
    expect(await record({ id: device(6) })).toBe("device_limit");
    expect(await record({ owner: b, id: device(6) })).toBe("stored");
    await allowNextReport(a, device()); expect(await record()).toBe("stored");
    expect((await db.query<{ owner_id: string; count: number }>("select owner_id,count(*)::integer as count from collector_health group by owner_id order by owner_id")).rows).toEqual([{ owner_id: a, count: 5 }, { owner_id: b, count: 1 }]);
  });
  it("isolates the same nonsecret device UUID in different account namespaces", async () => {
    await record({ owner: a });
    expect(await record({ owner: b, state: "capture_error", captured: null })).toBe("stored");
    const own = (await db.query<{ state: string }>("select state from collector_health where owner_id=$1::uuid", [a])).rows;
    expect(own).toEqual([{ state: "ready" }]);
  });
  it.each([
    { state: "other" }, { source: -1 }, { pending: 1_000_001 }, { state: "needs_review", source: 1, unreadable: 1, incomplete: 1 },
    { state: "needs_review", held: 1 }, { source: 1 }, { captured: null }, { accepted: "2099-01-01T00:00:00.000Z" },
  ])("rejects invalid or misleading status without writing: %j", async draft => {
    await expect(record(draft)).rejects.toThrow(); expect((await db.query("select * from collector_health")).rows).toHaveLength(0);
  });
  it("keeps health reporting separate from financial or SMS tables", async () => {
    // The minimal fixture deliberately provides no ledger or SMS schema.
    expect(await record({ state: "needs_review", source: 2, unreadable: 1, incomplete: 1, pending: 1, held: 1 })).toBe("stored");
    expect((await db.query("select * from collector_health")).rows).toHaveLength(1);
  });
  it("blocks direct browser-role reads and function writes even with a known owner/device", async () => {
    await record();
    const privileges = (await db.query<{ read: boolean; execute: boolean }>(`select has_table_privilege('authenticated','public.collector_health','select') as read,
      has_function_privilege('authenticated','public.alfred_record_collector_health(uuid,uuid,text,integer,integer,integer,integer,integer,timestamptz,timestamptz)','execute') as execute`)).rows[0];
    expect(privileges).toEqual({ read: false, execute: false });
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      await expect(db.query("select * from public.collector_health")).rejects.toThrow();
      await expect(record({ owner: b, id: device(2) })).rejects.toThrow();
      await db.exec("reset role");
    }
    expect((await db.query("select * from collector_health")).rows).toHaveLength(1);
  });
  it("has RLS enabled with no direct client read policies", async () => {
    expect((await db.query<{ relrowsecurity: boolean }>("select relrowsecurity from pg_class where oid='public.collector_health'::regclass")).rows[0].relrowsecurity).toBe(true);
    expect((await db.query("select * from pg_policies where tablename='collector_health'")).rows).toHaveLength(0);
  });
});
