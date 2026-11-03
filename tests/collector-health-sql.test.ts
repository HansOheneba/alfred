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
  await db.exec(readFileSync("supabase/migrations/20261103230000_collector_health_removal.sql", "utf8"));
});
afterEach(async () => { await db.close(); });
type Draft = { owner?: string; id?: string; state?: string; source?: number; unreadable?: number; incomplete?: number; held?: number; pending?: number; captured?: string | null; accepted?: string | null };
async function record(value: Draft = {}) {
  const params = [value.owner ?? a, value.id ?? device(), value.state ?? "ready", value.source ?? 0, value.unreadable ?? 0, value.incomplete ?? 0, value.held ?? 0, value.pending ?? 0, value.captured === undefined ? new Date(Date.now() - 60_000).toISOString() : value.captured, value.accepted ?? null];
  return (await db.query<{ result: string }>("select public.alfred_record_collector_health($1::uuid,$2::uuid,$3,$4::integer,$5::integer,$6::integer,$7::integer,$8::integer,$9::timestamptz,$10::timestamptz) as result", params)).rows[0].result;
}
async function allowNextReport(owner = a, id = device()) { await db.query("update collector_health set last_seen_at=now()-interval '1 minute' where owner_id=$1::uuid and device_id=$2::uuid", [owner, id]); }
async function forget(owner = a, id = device()) { return (await db.query<{ removed: boolean }>("select public.alfred_forget_collector_health($1::uuid,$2::uuid) as removed", [owner, id])).rows[0].removed; }

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
  it("frees a capped account's selected stale slot without evicting another Mac", async () => {
    for (let index = 1; index <= 5; index++) await record({ id: device(index) });
    expect(await record({ id: device(6) })).toBe("device_limit");
    const preserved = (await db.query("select * from collector_health where device_id<>$1::uuid order by device_id", [device(3)])).rows;
    expect(await forget(a, device(3))).toBe(true);
    expect((await db.query("select * from collector_health order by device_id")).rows).toEqual(preserved);
    expect(await record({ id: device(6) })).toBe("stored");
    expect((await db.query<{ device_id: string }>("select device_id from collector_health order by device_id")).rows.map(row => row.device_id)).toEqual([device(1), device(2), device(4), device(5), device(6)]);
  });
  it("removes only the authenticated owner namespace and is safe to retry", async () => {
    await record({ owner: a }); await record({ owner: b, state: "capture_error", captured: null });
    const other = (await db.query("select * from collector_health where owner_id=$1::uuid", [b])).rows;
    expect(await forget(a, device(2))).toBe(false);
    expect(await forget(a)).toBe(true); expect(await forget(a)).toBe(false);
    expect((await db.query("select * from collector_health")).rows).toEqual(other);
    expect((await db.query("select * from profiles order by id")).rows).toEqual([{ id: a }, { id: b }]);
  });
  it("does not revoke collection: the same active Mac can check in again", async () => {
    await record(); expect(await forget()).toBe(true); expect(await record()).toBe("stored");
    expect((await db.query("select * from collector_health")).rows).toHaveLength(1);
  });
  it("rolls back removal with its transaction and uses the reporter's owner lock", async () => {
    await record(); const before = (await db.query("select * from collector_health")).rows;
    await db.exec("begin"); expect(await forget()).toBe(true); await db.exec("rollback");
    expect((await db.query("select * from collector_health")).rows).toEqual(before);
    const definitions = (await db.query<{ body: string }>("select prosrc as body from pg_proc where proname in ('alfred_forget_collector_health','alfred_record_collector_health')")).rows;
    for (const { body } of definitions) expect(body).toContain("pg_advisory_xact_lock(hashtextextended(owner::text,92351))");
  });
  it("blocks removal from direct client roles even with a known owner and device", async () => {
    await record();
    for (const role of ["anon", "authenticated"]) {
      expect((await db.query<{ allowed: boolean }>("select has_function_privilege($1,'public.alfred_forget_collector_health(uuid,uuid)','execute') as allowed", [role])).rows[0].allowed).toBe(false);
      await db.exec(`set role ${role}`); await expect(forget()).rejects.toThrow(); await db.exec("reset role");
    }
    expect((await db.query("select * from collector_health")).rows).toHaveLength(1);
  });
});
