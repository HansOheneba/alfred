import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { emptyAccountingState, type AccountingState } from "@/lib/finance/accounting/types";

// Optional isolated test tool; never loads application config, a connection URL or live records.
const pgliteModule = process.env.ALFRED_PGLITE_MODULE ?? resolve("node_modules/@electric-sql/pglite/dist/index.js");
if (process.env.ALFRED_PGLITE_MODULE && !existsSync(pgliteModule)) throw new Error("ALFRED_PGLITE_MODULE must point to an installed PGlite ES module.");
interface EmbeddedDatabase {
  exec(sql: string): Promise<unknown>;
  query<T = Record<string, unknown>>(sql: string, parameters?: unknown[]): Promise<{ rows: T[] }>;
  close(): Promise<void>;
}
const OWNER = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const UNKNOWN = "00000000-0000-4000-8000-000000000003";
const NOW = "2026-11-02T12:00:00Z";

function nextState(owner = OWNER, revision = 1, request = "request-1", fingerprint = "fingerprint-1"): AccountingState {
  const state = emptyAccountingState(owner);
  return { ...state, revision, audit: [{
    id: `revision:${revision}`, requestId: request, action: "create_account", actionFingerprint: fingerprint,
    at: NOW, revision, before: { accounts: [], movements: [], snapshots: [], transfers: [], settlements: [] },
  }] };
}

describe.skipIf(!existsSync(pgliteModule))("accounting SQL on an ephemeral synthetic Postgres", () => {
  let db: EmbeddedDatabase;
  beforeAll(async () => {
    const moduleUrl = pathToFileURL(pgliteModule).href;
    const imported = await import(/* @vite-ignore */ moduleUrl) as { PGlite: new () => EmbeddedDatabase };
    db = new imported.PGlite();
    await db.exec(`
      create role anon;
      create role authenticated;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid
      $$;
      grant usage on schema auth to authenticated;
      grant execute on function auth.uid() to authenticated;
      create table public.profiles(id uuid primary key);
      create table public.transactions(id text primary key, owner_id uuid references public.profiles(id), amount numeric not null default 0, note text);
      create table public.bank_messages(id text primary key, owner_id uuid references public.profiles(id), raw text);
    `);
    await db.exec(readFileSync(resolve("supabase/migrations/20261102160000_financial_accounting.sql"), "utf8"));
  }, 30_000);
  beforeEach(async () => {
    await db.exec("reset role; truncate public.profiles cascade;");
    await db.query("insert into public.profiles(id) values($1),($2)", [OWNER, OTHER]);
  });
  afterAll(async () => { await db?.close(); });

  async function sourceVersion(owner = OWNER): Promise<string> {
    return (await db.query<{ version: string }>("select public.alfred_accounting_source_version($1) as version", [owner])).rows[0].version;
  }
  async function write(state = nextState(), expected = state.revision - 1, version?: string, owner = state.ownerId) {
    const event = state.audit.at(-1)!;
    const result = await db.query<{ result: { status: string; state?: AccountingState } }>(
      "select public.alfred_write_accounting_state($1,$2,$3,$4,$5,$6::jsonb) as result",
      [owner, expected, event.requestId, event.actionFingerprint, version ?? await sourceVersion(owner), JSON.stringify(state)],
    );
    return result.rows[0].result;
  }
  async function counts() {
    return (await db.query<{ states: number; events: number }>(
      "select (select count(*)::int from public.accounting_states) states,(select count(*)::int from public.accounting_events) events",
    )).rows[0];
  }
  async function valid(document: unknown, owner = OWNER) {
    return (await db.query<{ valid: boolean }>("select public.alfred_accounting_document_valid($1::jsonb,$2) valid", [JSON.stringify(document), owner])).rows[0].valid;
  }

  it("applies the migration and commits state plus immutable event in one write", async () => {
    expect((await write()).status).toBe("saved");
    expect(await counts()).toEqual({ states: 1, events: 1 });
    const event = (await db.query<{ before_state: AccountingState; after_state: AccountingState }>("select before_state,after_state from public.accounting_events")).rows[0];
    expect(event.before_state).toMatchObject({ ownerId: OWNER, revision: 0 });
    expect(event.after_state).toEqual(nextState());
  });

  it("enforces the profile owner FK and rejects cross-owner state payloads atomically", async () => {
    await expect(write(nextState(UNKNOWN))).rejects.toThrow(/foreign key/i);
    await expect(write(nextState(OTHER), 0, await sourceVersion(), OWNER)).rejects.toThrow(/Invalid accounting state/i);
    expect(await counts()).toEqual({ states: 0, events: 0 });
  });

  it("guards compare-and-swap when two callers submit the same revision", async () => {
    const version = await sourceVersion();
    // PGlite queues one connection: this verifies CAS results, not multi-session lock scheduling.
    const results = await Promise.all([
      write(nextState(OWNER, 1, "request-a", "fingerprint-a"), 0, version),
      write(nextState(OWNER, 1, "request-b", "fingerprint-b"), 0, version),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["saved", "stale"]);
    expect(await counts()).toEqual({ states: 1, events: 1 });
  });

  it("retains permanent idempotency after a request leaves the document's audit ring", async () => {
    const first = nextState();
    expect((await write(first)).status).toBe("saved");
    const second = nextState(OWNER, 2, "request-2", "fingerprint-2");
    expect((await write(second)).status).toBe("saved");
    const retry = await write(first, 0);
    expect(retry.status).toBe("duplicate");
    expect(retry.state?.revision).toBe(2);
    expect(retry.state?.audit.some((event) => event.requestId === "request-1")).toBe(false);
    expect((await write(nextState(OWNER, 1, "request-1", "changed-payload"), 0)).status).toBe("conflict");
    expect(await counts()).toEqual({ states: 1, events: 2 });
  });

  it("detects source inserts and edits without treating another owner's records as this owner's version", async () => {
    const emptyVersion = await sourceVersion();
    await db.query("insert into public.transactions(id,owner_id,amount,note) values('t1',$1,100,'synthetic')", [OWNER]);
    expect((await write(nextState(), 0, emptyVersion)).status).toBe("source_changed");
    const insertedVersion = await sourceVersion();
    await db.query("update public.transactions set note='corrected synthetic source' where id='t1'");
    expect((await write(nextState(), 0, insertedVersion)).status).toBe("source_changed");
    const ownerVersion = await sourceVersion();
    await db.query("insert into public.bank_messages(id,owner_id,raw) values('foreign-source',$1,'synthetic')", [OTHER]);
    expect(await sourceVersion()).toBe(ownerVersion);
    expect((await write(nextState(), 0, ownerVersion)).status).toBe("saved");
    expect(await counts()).toEqual({ states: 1, events: 1 });
  });

  it("rolls back the state update if the event insert fails its request-key constraint", async () => {
    await expect(write(nextState(OWNER, 1, "bad request key", "fingerprint"))).rejects.toThrow(/check constraint/i);
    expect(await counts()).toEqual({ states: 0, events: 0 });
    expect((await write()).status).toBe("saved");
    await expect(write(nextState(OWNER, 2, "bad request key", "fingerprint"))).rejects.toThrow(/check constraint/i);
    expect(await counts()).toEqual({ states: 1, events: 1 });
    expect((await db.query<{ revision: number }>("select revision::int from public.accounting_states")).rows[0].revision).toBe(1);
  });

  it("exposes only the authenticated owner's state/events through RLS and denies browser writes/RPC", async () => {
    await write();
    await write(nextState(OTHER));
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [OWNER]);
    await db.exec("set role authenticated");
    expect((await db.query<{ owner_id: string }>("select owner_id from public.accounting_states")).rows).toEqual([{ owner_id: OWNER }]);
    expect((await db.query<{ owner_id: string }>("select owner_id from public.accounting_events")).rows).toEqual([{ owner_id: OWNER }]);
    await expect(db.query("delete from public.accounting_states where owner_id=$1", [OWNER])).rejects.toThrow(/permission denied/i);
    await expect(db.query("select public.alfred_write_accounting_state($1,0,'x','x','x','{}'::jsonb)", [OWNER])).rejects.toThrow(/permission denied/i);
    await db.exec("reset role; set role anon");
    await expect(db.query("select * from public.accounting_states")).rejects.toThrow(/permission denied/i);
  });

  it("rejects missing owner/revision and structurally invalid owner-scoped documents", async () => {
    const state = nextState();
    const noOwner = { ...state } as Partial<AccountingState>;
    delete noOwner.ownerId;
    const noRevision = { ...state } as Partial<AccountingState>;
    delete noRevision.revision;
    expect(await valid(noOwner)).toBe(false);
    expect(await valid(noRevision)).toBe(false);
    expect(await valid({ ...state, ownerId: OTHER })).toBe(false);
    expect(await valid({ ...state, revision: 1.5 })).toBe(false);
    expect(await valid({ ...state, movements: {} })).toBe(false);
    expect(await valid({ ...state, audit: Array.from({ length: 51 }, () => state.audit[0]) })).toBe(false);
    expect(await valid({ ...state, snapshots: [{ id: "orphan", accountId: "missing" }] })).toBe(false);
  });

  it("rejects missing monetary fields, foreign movement owners and unresolved account references", async () => {
    const state = nextState();
    const movement = { id: "movement", ownerId: OWNER, amountMinor: 100, feeMinor: 0, currency: "GHS", accountId: null };
    expect(await valid({ ...state, movements: [movement] })).toBe(true);
    for (const key of ["feeMinor", "amountMinor", "currency", "ownerId"]) {
      const missing = { ...movement } as Record<string, unknown>;
      delete missing[key];
      expect(await valid({ ...state, movements: [missing] })).toBe(false);
    }
    for (const changes of [{ ownerId: OTHER }, { amountMinor: 0 }, { amountMinor: 1.2 }, { feeMinor: -1 }, { currency: "ghs" }, { accountId: "missing" }]) {
      expect(await valid({ ...state, movements: [{ ...movement, ...changes }] })).toBe(false);
    }
  });
});
