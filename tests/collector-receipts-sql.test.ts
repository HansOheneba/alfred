import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", rowA = "11111111-1111-4111-8111-111111111111", rowB = "22222222-2222-4222-8222-222222222222";
const event = "a".repeat(64), hash = "b".repeat(64);
let db: PGlite;
type Claim = { status: "acquired" | "stored" | "busy" | "conflict"; receipt_id: string | null; claim_token: string | null };
async function claim(owner = a, payload = hash): Promise<Claim> { return (await db.query<Claim>("select * from alfred_claim_collector_event($1::uuid,$2,$3)", [owner, event, payload])).rows[0]; }
async function complete(token: string | null, ids: string[] = [rowA], owner = a, payload = hash) { return (await db.query<{ receipt: string | null }>("select alfred_complete_collector_event($1::uuid,$2,$3,$4::uuid,$5::uuid[])::text as receipt", [owner, event, payload, token, ids])).rows[0].receipt; }
async function release(token: string | null, owner = a) { await db.query("select alfred_release_collector_event($1::uuid,$2,$3,$4::uuid)", [owner, event, hash, token]); }
beforeEach(async () => {
  db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create table profiles(id uuid primary key);create table bank_messages(id uuid primary key,owner_id uuid not null references profiles(id));
    create table transactions(id uuid primary key,amount numeric);insert into profiles values('${a}'),('${b}');insert into bank_messages values('${rowA}','${a}'),('${rowB}','${b}');insert into transactions values('${rowA}',7);`);
  await db.exec(readFileSync("supabase/migrations/20261103150000_collector_event_receipts.sql", "utf8"));
});
afterEach(async () => { await db.close(); });
describe("durable owner/event/payload receipts", () => {
  it("serializes concurrent retries before any new ingestion", async () => {
    const first = await claim(); expect(first.status).toBe("acquired"); expect(first.claim_token).toBeTruthy();
    expect(await claim()).toEqual({ status: "busy", receipt_id: null, claim_token: null });
    expect((await db.query("select * from collector_event_receipts")).rows).toHaveLength(1);
  });
  it("confirms only stored owned messages and returns the same receipt after a lost acknowledgement", async () => {
    const first = await claim(), receipt = await complete(first.claim_token);
    expect(receipt).toMatch(/^[0-9a-f-]{36}$/);
    expect(await claim()).toEqual({ status: "stored", receipt_id: receipt, claim_token: null });
    expect(await complete(first.claim_token)).toBe(receipt);
    expect((await db.query("select * from transactions")).rows).toEqual([{ id: rowA, amount: "7" }]);
  });
  it("rejects same-event changed content before ingestion or acknowledgement", async () => {
    const first = await claim();
    expect((await claim(a, "c".repeat(64))).status).toBe("conflict");
    expect(await complete(first.claim_token, [rowA], a, "c".repeat(64))).toBeNull();
    expect((await db.query("select state from collector_event_receipts")).rows[0]).toEqual({ state: "pending" });
  });
  it("isolates equal source identifiers across accounts and refuses foreign evidence", async () => {
    const first = await claim(), other = await claim(b);
    expect(other.status).toBe("acquired");
    expect(await complete(other.claim_token, [rowA], b)).toBeNull();
    expect(await complete(first.claim_token, [rowB])).toBeNull();
    expect(await complete(other.claim_token, [rowB], b)).toBeTruthy();
    expect(await complete(first.claim_token, [rowA])).toBeTruthy();
    expect((await db.query("select owner_id from collector_event_receipts where state='stored'")).rows).toHaveLength(2);
  });
  it("cannot complete empty, absent or partly foreign evidence", async () => {
    const first = await claim();
    for (const ids of [[], ["33333333-3333-4333-8333-333333333333"], [rowA, rowB]]) expect(await complete(first.claim_token, ids)).toBeNull();
    expect((await db.query("select state from collector_event_receipts")).rows[0]).toEqual({ state: "pending" });
  });
  it("releases an unrecognized event without inventing a durable disposition", async () => {
    const first = await claim(); await release(first.claim_token);
    const second = await claim(); expect(second.status).toBe("acquired"); expect(second.claim_token).not.toBe(first.claim_token);
    expect(await complete(first.claim_token)).toBeNull();
    expect((await db.query("select state,message_ids,stored_at from collector_event_receipts")).rows[0]).toEqual({ state: "pending", message_ids: [], stored_at: null });
  });
  it("expires a crashed worker's lease and rejects its later stale commit", async () => {
    const first = await claim(); await db.exec("update collector_event_receipts set claim_until=now()-interval '1 minute'");
    expect(await complete(first.claim_token)).toBeNull();
    const second = await claim(); expect(second.status).toBe("acquired");
    expect(await complete(first.claim_token)).toBeNull(); expect(await complete(second.claim_token)).toBeTruthy();
  });
  it("never acknowledges after a receipt commit failure", async () => {
    const first = await claim();
    await db.exec("create function fixture_reject_receipt() returns trigger language plpgsql as $$begin raise exception 'synthetic commit failure';end$$;create trigger fixture_receipt_failure before update of state on collector_event_receipts for each row execute function fixture_reject_receipt();");
    await expect(complete(first.claim_token)).rejects.toThrow("synthetic commit failure");
    expect((await db.query("select state,message_ids,stored_at from collector_event_receipts")).rows[0]).toEqual({ state: "pending", message_ids: [], stored_at: null });
    await release(first.claim_token); expect((await claim()).status).toBe("acquired");
  });
  it("keeps receipt dedupe after history deletion without storing SMS or credentials", async () => {
    const first = await claim(), receipt = await complete(first.claim_token); await db.exec("delete from bank_messages");
    expect((await claim()).receipt_id).toBe(receipt);
    const columns = (await db.query<{ column_name: string }>("select column_name from information_schema.columns where table_name='collector_event_receipts'")).rows.map(row => row.column_name);
    expect(columns).not.toContain("raw"); expect(columns).not.toContain("body"); expect(columns).not.toContain("sender"); expect(columns).not.toContain("key");
    await db.exec("set role authenticated");
    await expect(db.query("select * from collector_event_receipts")).rejects.toThrow(/permission denied/);
    await expect(claim()).rejects.toThrow(/permission denied/);
  });
});
