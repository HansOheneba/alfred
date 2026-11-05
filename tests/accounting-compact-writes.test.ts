import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseSettings } from "@/lib/config";
import { DatabaseError } from "@/lib/errors";
import { browserAccountingState } from "@/lib/finance/accounting/browser-state";
import { loadAccountingState, saveAccountingAction } from "@/lib/finance/accounting/persisted-store";
import { accountingUndoTarget, actionFingerprint, applyAccountingAction } from "@/lib/finance/accounting/reducer";
import { emptyAccountingState, type AccountingAction, type AccountingState } from "@/lib/finance/accounting/types";
import { buildAlfredExport, scrubNativeOwnership } from "@/lib/portability/export";
import { confirmFinanceImport, previewFinanceImport, undoFinanceImport } from "@/lib/portability/service";
import { journeyArchive } from "./fixtures/portability/journey-archive";

const transport = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/supabase/connection", () => ({ query: transport.query }));
const OWNER = "50000000-0000-4000-8000-000000000001", OTHER = "50000000-0000-4000-8000-000000000002";
const AT = "2026-11-05T12:00:00.000Z", MIGRATION = "20261105192204_compact_accounting_writes.sql";
const settings = {} as SupabaseSettings;
let db: PGlite, oldAbi: unknown;
let loseCommitResponse = false;
const stateReads: { sql: string; bytes: number }[] = [];
async function legacyAbi() {
  return (await db.query("select oid::regprocedure::text as signature,pg_get_functiondef(oid) as definition,proowner,proacl::text from pg_proc where oid in ('public.alfred_accounting_document_valid(jsonb,uuid)'::regprocedure,'public.alfred_accounting_source_version(uuid)'::regprocedure,'public.alfred_write_accounting_state(uuid,bigint,text,text,text,jsonb)'::regprocedure) order by oid::regprocedure::text")).rows;
}
async function stored(ownerId = OWNER): Promise<AccountingState> { return (await db.query<{ state: AccountingState }>("select state from accounting_states where owner_id=$1::uuid", [ownerId])).rows[0].state; }
async function version(ownerId = OWNER) { return (await db.query<{ version: string }>("select alfred_accounting_source_version($1::uuid) as version", [ownerId])).rows[0].version; }
async function events() { return (await db.query<{ count: number }>("select count(*)::int as count from accounting_events where owner_id=$1::uuid", [OWNER])).rows[0].count; }
const change = (revision: number, requestId = "fictional-compact:save"): Extract<AccountingAction, { type: "update_account" }> => ({ type: "update_account", accountId: "fictional-cash", changes: { label: `Fictional changed ${revision}` }, expectedRevision: revision, requestId });
function stripHistory(next: AccountingState): AccountingState {
  const compact = browserAccountingState(next);
  compact.audit[compact.audit.length - 1] = next.audit.at(-1)!;
  return compact;
}
async function rpc(next: AccountingState, expected = next.revision - 1, source?: string, ownerId = OWNER, fingerprint = next.audit.at(-1)!.actionFingerprint) {
  return (await db.query<{ result: { status: string; state?: AccountingState } }>("select alfred_write_accounting_state_compact($1::uuid,$2::bigint,$3,$4,$5,$6::jsonb) as result",
    [ownerId, expected, next.audit.at(-1)!.requestId, fingerprint, source ?? await version(), JSON.stringify(next)])).rows[0].result;
}
async function seed(count = 12, historyCount = 5): Promise<AccountingState> {
  await db.query(`insert into transactions(transaction_id,created_at,transaction_date,user_id,owner_id,type,amount,currency,category,description,payment_method,notes,status,updated_at,source_update_id)
    select ('60000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,$2::timestamptz,$2::timestamptz::date,$1::text,$1::uuid,'expense',10,'GHS','Food','Fictional payment '||i,'Fictional bank','','active',$2::timestamptz,
      'bank:'||('70000000-0000-4000-8000-'||lpad(i::text,12,'0')) from generate_series(1,$3::int) i`, [OWNER, AT, count]);
  await db.query(`insert into bank_messages(id,owner_id,source,channel,text_hash,direction,kind,amount,fee,currency,counterparty,balance,occurred_at,status,transaction_id,raw)
    select ('70000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,$1::uuid,'momo','manual','fictional-hash:'||i,'out','payment',10,0,'GHS','Fictional payee',1000,$2::timestamptz,'recorded',
      ('60000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,repeat('Fictional source evidence only. ',30) from generate_series(1,$3::int) i`, [OWNER, AT, count]);
  const loaded = await loadAccountingState(settings, OWNER);
  let state: AccountingState = { ...loaded.state, accounts: [{ id: "fictional-cash", label: "Fictional cash", provider: "Fictional", currency: "GHS", includeInCash: true, createdAt: AT }],
    movements: loaded.state.movements.map(row => ({ ...row, accountId: "fictional-cash" })), snapshots: [{ id: "fictional-opening", accountId: "fictional-cash", balanceMinor: 100000, occurredAt: AT, sourceId: "manual", sourceMovementId: null }] };
  for (let index = 0; index < historyCount; index += 1) state = applyAccountingAction(state, change(state.revision, `fictional-history:${index}`), AT);
  if (state.audit[0]) Object.assign(state.audit[0], { fictionalAuditExtension: { preserved: true } });
  await db.query("insert into accounting_states(owner_id,revision,state) values($1::uuid,$2,$3::jsonb)", [OWNER, state.revision, JSON.stringify(state)]);
  transport.query.mockClear(); stateReads.length = 0;
  return state;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec("create role anon;create role authenticated;create schema auth;create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}'::jsonb);");
  for (const file of readdirSync("supabase/migrations").filter(file => file.endsWith(".sql") && file !== MIGRATION).sort()) await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
  oldAbi = await legacyAbi();
  await db.exec(readFileSync(`supabase/migrations/${MIGRATION}`, "utf8"));
  await db.query("insert into auth.users(id) values($1::uuid),($2::uuid)", [OWNER, OTHER]);
  transport.query.mockImplementation(async (_settings, sql: string, values: unknown[] = []) => {
    const result = await db.query(sql, values);
    if (sql.includes("as state from public.accounting_states") || sql.startsWith("select state from public.accounting_states") || sql.includes("as before from public.accounting_states")) stateReads.push({ sql, bytes: Buffer.byteLength(JSON.stringify(result.rows)) });
    if (loseCommitResponse && sql.startsWith("select public.alfred_write_accounting_state_compact(")) { loseCommitResponse = false; throw new DatabaseError("Fictional commit response was lost.", "08006"); }
    return result.rows;
  });
}, 30_000);
beforeEach(async () => {
  loseCommitResponse = false;
  await db.exec("reset role; truncate profiles cascade");
  await db.query("insert into profiles(id) values($1::uuid),($2::uuid)", [OWNER, OTHER]);
  await seed();
});
afterAll(async () => { await db?.close(); });

describe("additive compact accounting SQL transport", () => {
  it("leaves original validator, writer, source hash, ownership and ACL definitions byte-for-byte unchanged", async () => {
    expect(await legacyAbi()).toEqual(oldAbi);
    expect((await db.query("select prosecdef,provolatile,proconfig,proacl::text from pg_proc where oid='alfred_write_accounting_state_compact(uuid,bigint,text,text,text,jsonb)'::regprocedure")).rows[0]).toMatchObject({ prosecdef: false, provolatile: "v", proconfig: ["search_path=public"] });
    await db.exec("set role authenticated");
    await expect(db.query("select alfred_write_accounting_state_compact($1::uuid,0,'x','x','x','{}'::jsonb)", [OWNER])).rejects.toThrow(/permission denied/i);
    await db.exec("reset role;set role anon");
    await expect(db.query("select alfred_write_accounting_state_compact($1::uuid,0,'x','x','x','{}'::jsonb)", [OWNER])).rejects.toThrow(/permission denied/i);
    await db.exec("reset role");
  });

  it("stores every complete historical before copy while loading and returning compact audit metadata", async () => {
    const before = await loadAccountingState(settings, OWNER); transport.query.mockClear(); stateReads.length = 0;
    const action = change(before.state.revision), saved = await saveAccountingAction(settings, OWNER, action);
    const expected = applyAccountingAction(before.state, action, saved.state.audit.at(-1)!.at);
    expect(await stored()).toEqual(expected); expect(saved.state).toEqual(browserAccountingState(expected));
    expect(saved.state.audit.every(entry => entry.before.movements.length === 0)).toBe(true);
    expect(stateReads).toHaveLength(1); expect(stateReads[0].sql).toContain("jsonb_set");
    expect(transport.query.mock.calls.some(([, sql]) => sql === "select state from public.accounting_states where owner_id=$1::uuid")).toBe(false);
    expect(transport.query.mock.calls.filter(([, sql]) => sql.startsWith("select public.alfred_write_accounting_state_compact("))).toHaveLength(1);
    const event = (await db.query<{ before_state: AccountingState; after_state: AccountingState }>("select before_state,after_state from accounting_events where owner_id=$1::uuid", [OWNER])).rows[0];
    expect(event.after_state).toEqual(expected); expect(event.before_state.audit[0].before.movements).toHaveLength(12);
  });

  it("restores historical before from the database even if supplied history copies are fabricated", async () => {
    const current = await loadAccountingState(settings, OWNER), next = applyAccountingAction(current.state, change(current.state.revision), AT), compact = stripHistory(next);
    compact.audit[0].before = { ...emptyAccountingState(OWNER), accounts: [] };
    expect((await rpc(compact)).status).toBe("saved"); expect(await stored()).toEqual(next);
  });

  it("rejects tampered historical metadata, missing history and cross-owner documents atomically", async () => {
    const current = await loadAccountingState(settings, OWNER), next = applyAccountingAction(current.state, change(current.state.revision), AT);
    const tampered = stripHistory(next); tampered.audit[0].action = "fictional-tamper";
    await expect(rpc(tampered)).rejects.toThrow(/audit metadata changed/);
    const missing = stripHistory(next); missing.audit.splice(0, 1);
    await expect(rpc(missing)).rejects.toThrow(/audit lineage changed/);
    await expect(rpc({ ...stripHistory(next), ownerId: OTHER })).rejects.toThrow(/Invalid accounting state/);
    expect(await events()).toBe(0); expect((await stored()).revision).toBe(current.state.revision);
  });

  it("retains duplicate/conflict, stale revision and source-changed result semantics", async () => {
    const current = await loadAccountingState(settings, OWNER), action = change(current.state.revision), next = stripHistory(applyAccountingAction(current.state, action, AT));
    expect((await rpc(next, action.expectedRevision - 1)).status).toBe("stale");
    const originalVersion = await version();
    await db.query("update bank_messages set raw=raw||' Fictional correction' where owner_id=$1::uuid", [OWNER]);
    expect((await rpc(next, action.expectedRevision, originalVersion)).status).toBe("source_changed");
    const saved = await saveAccountingAction(settings, OWNER, action);
    expect((await rpc(next, action.expectedRevision, originalVersion)).status).toBe("duplicate");
    expect((await rpc(next, action.expectedRevision, originalVersion, OWNER, "fictional-conflicting-fingerprint")).status).toBe("conflict");
    expect(await events()).toBe(1); expect((await stored()).revision).toBe(saved.state.revision);
  });

  it("keeps permanent duplicate request IDs beyond the bounded audit history", async () => {
    const current = await loadAccountingState(settings, OWNER), action = change(current.state.revision, "fictional-permanent");
    await saveAccountingAction(settings, OWNER, action);
    const state = await stored(); state.audit = [];
    await db.query("update accounting_states set state=$2::jsonb where owner_id=$1::uuid", [OWNER, JSON.stringify(state)]);
    transport.query.mockClear();
    const duplicate = await saveAccountingAction(settings, OWNER, action);
    expect(duplicate.state.revision).toBe(state.revision); expect(await events()).toBe(1);
    expect(transport.query.mock.calls.some(([, sql]) => sql.startsWith("select public.alfred_write_accounting_state_compact("))).toBe(false);
    await expect(saveAccountingAction(settings, OWNER, { ...action, changes: { label: "Fictional different command" } })).rejects.toMatchObject({ code: "conflict" });
  });

  it("preserves the exact retained49 history entries when the full50-entry audit ring rolls over", async () => {
    await db.exec("truncate profiles cascade"); await db.query("insert into profiles(id) values($1::uuid),($2::uuid)", [OWNER, OTHER]);
    await seed(4, 55);
    const full = await loadAccountingState(settings, OWNER), action = change(full.state.revision), saved = await saveAccountingAction(settings, OWNER, action);
    expect(full.state.audit).toHaveLength(50); expect(saved.state.audit).toHaveLength(50);
    expect(await stored()).toEqual(applyAccountingAction(full.state, action, saved.state.audit.at(-1)!.at));
    expect((await stored()).audit.slice(0, -1)).toEqual(full.state.audit.slice(1));
  });
});

describe("selective Undo and exact authoritative exports", () => {
  it("fetches only the eligible before copy and supports repeated Undo without losing old audit evidence", async () => {
    for (let iteration = 0; iteration < 3; iteration += 1) {
      const full = await loadAccountingState(settings, OWNER), action: AccountingAction = { type: "undo", expectedRevision: full.state.revision, requestId: `fictional-undo:${iteration}` };
      const target = accountingUndoTarget(full.state); transport.query.mockClear(); stateReads.length = 0;
      const saved = await saveAccountingAction(settings, OWNER, action), expected = applyAccountingAction(full.state, action, saved.state.audit.at(-1)!.at);
      expect(await stored()).toEqual(expected); expect(saved.state).toEqual(browserAccountingState(expected));
      const targeted = transport.query.mock.calls.filter(([, sql]) => sql.includes("as before from public.accounting_states"));
      const { before: _before, ...metadata } = target; void _before;
      expect(targeted).toHaveLength(1); expect(targeted[0][2]).toEqual([OWNER, full.state.revision, full.state.audit.indexOf(target), JSON.stringify(metadata)]);
      expect(stateReads).toHaveLength(2); expect(stateReads.some(row => row.sql.startsWith("select state from public.accounting_states"))).toBe(false);
    }
    const complete = await loadAccountingState(settings, OWNER), exported = await buildAlfredExport(settings, OWNER), native = exported.datasets["alfred.native"];
    expect(native.tables.accountingStates[0].state).toEqual(scrubNativeOwnership(complete.state));
    const durableEvents = (await db.query("select before_state,after_state from accounting_events where owner_id=$1::uuid order by revision", [OWNER])).rows;
    expect(native.tables.accountingEvents.map(row => ({ before_state: row.before_state, after_state: row.after_state }))).toEqual(scrubNativeOwnership(durableEvents));
    expect(complete.state.audit[0].before.movements).toHaveLength(12);
  });

  it.each(["import", "undo_import", "automatic_pair_transfer", "reject_automatic_transfer", "resolve_payment_no_money", "resolve_payment_return", "reopen_payment_resolution"])("retains the canonical %s Undo barrier without fetching a history body", async blockedAction => {
    const state = await stored(); state.audit[state.audit.length - 1].action = blockedAction;
    await db.query("update accounting_states set state=$2::jsonb where owner_id=$1::uuid", [OWNER, JSON.stringify(state)]); transport.query.mockClear();
    await expect(saveAccountingAction(settings, OWNER, { type: "undo", expectedRevision: state.revision, requestId: "fictional-blocked-undo" })).rejects.toMatchObject({ code: "conflict" });
    expect(transport.query.mock.calls.some(([, sql]) => sql.includes("as before from public.accounting_states"))).toBe(false); expect(await events()).toBe(0);
  });

  it("does not bypass source-fingerprint protection when an old Undo copy refers to changed evidence", async () => {
    const state = await stored(); await db.query("update bank_messages set raw=raw||' Fictional changed evidence' where owner_id=$1::uuid", [OWNER]);
    await expect(saveAccountingAction(settings, OWNER, { type: "undo", expectedRevision: state.revision, requestId: "fictional-stale-undo" })).rejects.toMatchObject({ code: "stale" });
    expect(await events()).toBe(0); expect((await stored()).revision).toBe(state.revision);
  });

  it("rejects an Undo copy lookup if another committed action changes its bound revision", async () => {
    const full = await loadAccountingState(settings, OWNER), concurrentAction = change(full.state.revision, "fictional-concurrent-save"), concurrent = applyAccountingAction(full.state, concurrentAction, AT);
    const execute = transport.query.getMockImplementation()!;
    let changed = false;
    transport.query.mockImplementation(async (...args) => {
      if (!changed && args[1].includes("as before from public.accounting_states")) {
        changed = true;
        await db.query("select alfred_write_accounting_state($1::uuid,$2::bigint,$3,$4,$5,$6::jsonb)", [OWNER, concurrentAction.expectedRevision, concurrentAction.requestId, actionFingerprint(concurrentAction), full.sourceVersion, JSON.stringify(concurrent)]);
      }
      return execute(...args);
    });
    try {
      await expect(saveAccountingAction(settings, OWNER, { type: "undo", expectedRevision: full.state.revision, requestId: "fictional-raced-undo" })).rejects.toMatchObject({ code: "stale" });
      expect(await stored()).toEqual(concurrent); expect(await events()).toBe(1);
    } finally { transport.query.mockImplementation(execute); }
  });

  it("leaves native import Undo rules intact after a compact ordinary write", async () => {
    const preview = await previewFinanceImport(settings, OWNER, await journeyArchive("2026-11-05"));
    expect(preview.canConfirm).toBe(true);
    const receipt = await confirmFinanceImport(settings, OWNER, preview.id), imported = await loadAccountingState(settings, OWNER);
    await expect(saveAccountingAction(settings, OWNER, { type: "undo", expectedRevision: imported.state.revision, requestId: "fictional-import-regular-undo" })).rejects.toMatchObject({ code: "conflict" });
    await saveAccountingAction(settings, OWNER, change(imported.state.revision, "fictional-after-import"));
    await expect(undoFinanceImport(settings, OWNER, receipt.id)).rejects.toMatchObject({ code: "stale" });
    expect((await db.query<{ count: number }>("select count(*)::int as count from imported_finance_sources where owner_id=$1::uuid", [OWNER])).rows[0].count).toBeGreaterThan(0);
  });
});

describe("compact transport rollout and uncertain responses", () => {
  it("retains the entire existing full-state path when the additive schema marker is absent", async () => {
    await db.exec("alter function alfred_compact_accounting_schema_20261105_v1() rename to fictional_compact_marker_disabled");
    try {
      const current = await loadAccountingState(settings, OWNER); transport.query.mockClear(); stateReads.length = 0;
      const action = change(current.state.revision), saved = await saveAccountingAction(settings, OWNER, action);
      expect(saved.state).toEqual(applyAccountingAction(current.state, action, saved.state.audit.at(-1)!.at));
      expect(saved.state.audit[0].before.movements).toHaveLength(12);
      expect(stateReads.some(row => row.sql.startsWith("select state from public.accounting_states"))).toBe(true);
      expect(transport.query.mock.calls.some(([, sql]) => sql.startsWith("select public.alfred_write_accounting_state("))).toBe(true);
    } finally { await db.exec("alter function fictional_compact_marker_disabled() rename to alfred_compact_accounting_schema_20261105_v1"); }
  });

  it("never replays a write when its committed response is lost", async () => {
    const before = await stored(), action = change(before.revision); loseCommitResponse = true;
    await expect(saveAccountingAction(settings, OWNER, action)).rejects.toMatchObject({ sqlState: "08006" });
    expect((await stored()).revision).toBe(before.revision + 1); expect(await events()).toBe(1);
    expect(transport.query.mock.calls.filter(([, sql]) => sql.startsWith("select public.alfred_write_accounting_state_compact("))).toHaveLength(1);
    // A separate explicit retry can observe the permanent receipt; the failed call itself never retries.
    transport.query.mockClear(); const recovered = await saveAccountingAction(settings, OWNER, action);
    expect(recovered.state.audit.at(-1)?.requestId).toBe(action.requestId); expect(await events()).toBe(1);
    expect(transport.query.mock.calls.some(([, sql]) => sql.startsWith("select public.alfred_write_accounting_state_compact("))).toBe(false);
  });

  it("avoids transferring every historical before copy on an ordinary populated save", async () => {
    await db.exec("truncate profiles cascade"); await db.query("insert into profiles(id) values($1::uuid),($2::uuid)", [OWNER, OTHER]);
    await seed(100, 20);
    const full = await loadAccountingState(settings, OWNER), fullBytes = Buffer.byteLength(JSON.stringify(full.state));
    transport.query.mockClear(); stateReads.length = 0;
    const saved = await saveAccountingAction(settings, OWNER, change(full.state.revision));
    expect(stateReads).toHaveLength(1); expect(stateReads[0].bytes).toBeLessThan(fullBytes / 10);
    expect(Buffer.byteLength(JSON.stringify(saved.state))).toBeLessThan(fullBytes / 10);
    const call = transport.query.mock.calls.find(([, sql]) => sql.startsWith("select public.alfred_write_accounting_state_compact("))!;
    const sent = JSON.parse(call[2][5]) as AccountingState;
    expect(sent.audit.slice(0, -1).every(entry => entry.before.movements.length === 0)).toBe(true);
    expect(sent.audit.at(-1)!.before.movements).toHaveLength(100);
    expect((await stored()).audit.every(entry => entry.before.movements.length === 100)).toBe(true);
  });
});
