import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { emptyAccountRuleState } from "@/lib/account-rules/types";
import { actionFingerprint, applyAccountingAction } from "@/lib/finance/accounting/reducer";
import { emptyAccountingState, type AccountingState } from "@/lib/finance/accounting/types";

// Isolated PGlite protocol/permission rehearsal; real multi-session tests are separate.
const FILE = "20261105182432_durable_accounting_display.sql";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DEFINITION = "accounting-display-v1", AT = "2026-11-05T12:00:00.000Z";
const TX = "10000000-0000-4000-8000-000000000001";
const BANK = "20000000-0000-4000-8000-000000000001";
type Baseline = { token: string; publishRevision: string; epoch: string; events: string[] };
type Job = { ownerId: string; definition: string; leaseToken: string; leaseUntil: string; attempts: number };
type Outcome = { status: string; token?: string };
let db: PGlite, originalAbis: unknown, absentBeforeMigration: boolean;
async function one<T>(sql: string, values: unknown[] = []) { return (await db.query<{ value: T }>(sql, values)).rows[0].value; }
function model(ownerId = OWNER, label = "Fictional") {
  const rows = [{ kind: "ledger", id: "fictional-entry", ordinal: 0, date: "2026-11-05", currency: "GHS", direction: "out", amount_minor: 100,
    search_text: "fictional", rank_date_asc: 0, rank_date_desc: 0, rank_amount_asc: 0, rank_amount_desc: 0, payload: { label } }];
  const manifest = { ownerId, revision: 0, sourceVersion: "fictional-source", label,
    rowCounts: { movement: 0, snapshot: 0, transfer: 0, settlement: 0, return: 0, evidence: 0, ledger: 1 } };
  return { manifest, rows };
}
async function take(owner = OWNER, definition = DEFINITION): Promise<Job> {
  const value = await one<Job>("select alfred_display.claim_owner($1::uuid,$2,$3::uuid,120) as value", [owner, definition, randomUUID()]);
  expect(value).toBeTruthy(); return value!;
}
const capture = (job: Job) => one<Baseline>("select alfred_display.capture($1::uuid,$2,$3::uuid) as value", [job.ownerId, job.definition, job.leaseToken]);
async function publish(job: Job, baseline: Baseline, input = model(job.ownerId)) {
  return one<Outcome>("select alfred_display.publish($1::uuid,$2,$3::uuid,$4::jsonb,$5::jsonb,$6::jsonb) as value",
    [job.ownerId, job.definition, job.leaseToken, JSON.stringify(baseline), JSON.stringify(input.manifest), JSON.stringify(input.rows)]);
}
const read = (owner = OWNER, definition = DEFINITION) => one<{ token: string; epoch: string; manifest: ReturnType<typeof model>["manifest"] } | null>("select alfred_display.manifest($1::uuid,$2) as value", [owner, definition]);
const events = (owner = OWNER) => db.query<{ id: string }>("select id::text from alfred_display.dirty_events where owner_id=$1::uuid order by id", [owner]);
async function warm(owner = OWNER) { const job = await take(owner); const baseline = (await capture(job))!; expect((await publish(job, baseline))?.status).toBe("saved"); return { job, baseline }; }
async function abi() {
  return (await db.query("select oid::regprocedure::text signature,pg_get_functiondef(oid) definition,proowner,proacl::text from pg_proc where oid in ('public.alfred_accounting_document_valid(jsonb,uuid)'::regprocedure,'public.alfred_accounting_source_version(uuid)'::regprocedure,'public.alfred_write_accounting_state(uuid,bigint,text,text,text,jsonb)'::regprocedure,'public.alfred_write_account_rules(uuid,bigint,text,text,jsonb)'::regprocedure) order by oid::regprocedure::text")).rows;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec("create role anon;create role authenticated;create schema auth;create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}'::jsonb);");
  for (const file of readdirSync("supabase/migrations").filter(file => file.endsWith(".sql") && file !== FILE).sort()) await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
  absentBeforeMigration = await one<boolean>("select to_regprocedure('alfred_display.readiness()') is null as value");
  originalAbis = await abi();
  await db.exec(readFileSync(`supabase/migrations/${FILE}`, "utf8"));
}, 30_000);
beforeEach(async () => {
  await db.exec("drop trigger if exists test_expire_rows on alfred_display.rows;drop function if exists alfred_display.test_expire_rows();drop sequence if exists alfred_display.test_insert_trace;truncate auth.users cascade;truncate alfred_display.dirty_events;update alfred_display.worker_health set last_worker_at=null,last_published_at=null,last_failed_at=null;");
  await db.query("insert into auth.users(id) values($1),($2)", [OWNER, OTHER]);
  await db.query("insert into accounting_states(owner_id,revision,state) values($1,0,$2::jsonb)", [OWNER, JSON.stringify(emptyAccountingState(OWNER))]);
  await db.query("insert into account_rule_states(owner_id,revision,state) values($1,0,$2::jsonb)", [OWNER, JSON.stringify(emptyAccountRuleState(OWNER))]);
  await db.query(`insert into transactions(owner_id,transaction_id,created_at,transaction_date,user_id,type,amount,currency,category,description,status,updated_at,source_update_id)
    values($1::uuid,$2::uuid,$3::timestamptz,'2026-11-05',$1::text,'expense',1,'GHS','Other','Fictional','active',$3::timestamptz,'display-test')`, [OWNER, TX, AT]);
  await db.query(`insert into bank_messages(id,owner_id,source,channel,text_hash,direction,kind,amount,currency,occurred_at,status,raw)
    values($1,$2,'momo','manual','fictional','out','payment',1,'GHS',$3,'recorded','Fictional evidence')`, [BANK, OWNER, AT]);
  await db.query("insert into finance_import_receipts(owner_id,id,archive_id,archive,summary,before_state,after_state,source_version_after) values($1,'display-import',$2,jsonb_build_object('archiveId',$2::text),'{}',$3::jsonb,$3::jsonb,'fictional')", [OWNER, "a".repeat(64), JSON.stringify(emptyAccountingState(OWNER))]);
  await db.query("insert into imported_finance_sources(owner_id,movement_id,receipt_id,movement) values($1,'import:fictional','display-import',$2::jsonb)", [OWNER, JSON.stringify({ id: "import:fictional", ownerId: OWNER })]);
  // No published model exists yet; isolate each test from fixture creation events.
  await db.exec("truncate alfred_display.dirty_events");
});
afterAll(async () => { await db?.close(); });

describe("durable display migration on fictional PGlite", () => {
  it("is optional before installation and preserves every existing financial ABI", async () => {
    expect(absentBeforeMigration).toBe(true);
    expect(await one("select alfred_display.readiness() as value")).toBe(true);
    expect(await abi()).toEqual(originalAbis);
  });

  it("claims only the requested owner and publishes one complete normalized model", async () => {
    await one("select alfred_display.enqueue($1::uuid,$2) as value", [OTHER, DEFINITION]);
    const job = await take(); expect(job.ownerId).toBe(OWNER);
    const baseline = (await capture(job))!;
    expect([baseline.token, baseline.publishRevision, baseline.epoch].every(value => typeof value === "string")).toBe(true);
    expect((await publish(job, baseline))?.status).toBe("saved");
    const fresh = (await read())!;
    expect(fresh.manifest).toEqual(model().manifest);
    expect(await read(OTHER)).toBeNull();
    expect(await one("select count(*)::int as value from alfred_display.rows where owner_id=$1::uuid and token=$2::bigint", [OWNER, fresh.token])).toBe(1);
    expect(await one("select alfred_display.status() as value")).toMatchObject({ leasedOwners: 0, modelOwners: 1, lastWorkerAt: expect.any(String), lastPublishedAt: expect.any(String) });
  });

  it.each([
    ["transactions", "update transactions set description='Changed' where owner_id=$1::uuid"],
    ["bank_messages", "update bank_messages set raw='Changed fictional evidence' where owner_id=$1::uuid"],
    ["accounting_states", "update accounting_states set state=state where owner_id=$1::uuid"],
    ["account_rule_states", "update account_rule_states set state=state where owner_id=$1::uuid"],
    ["imported_finance_sources", "update imported_finance_sources set movement=jsonb_set(movement,'{description}','\"Changed\"') where owner_id=$1::uuid"],
  ])("invalidates the model and discovers work for %s changes", async (_table, sql) => {
    await warm(); await db.query(sql, [OWNER]);
    expect(await read()).toBeNull(); expect((await events()).rows).toHaveLength(1);
    const claimed = await one<Job>("select alfred_display.claim($1,$2::uuid,120) as value", [DEFINITION, randomUUID()]);
    expect(claimed?.ownerId).toBe(OWNER);
  });

  it("source writes append only, coalesce within their transaction and never touch jobs or heartbeat", async () => {
    await db.exec("begin");
    try {
      await db.query("update transactions set description='One' where owner_id=$1::uuid", [OWNER]);
      await db.query("update bank_messages set raw='Two' where owner_id=$1::uuid", [OWNER]);
      expect((await events()).rows).toHaveLength(1);
    } finally { await db.exec("commit"); }
    expect(await one("select count(*)::int as value from alfred_display.jobs")).toBe(0);
    expect(await one("select last_worker_at as value from alfred_display.worker_health")).toBeNull();
  });

  it("the existing source hash already detects an actual account-rule write without any accounting revision change", async () => {
    const base = { ...emptyAccountingState(OWNER), accounts: [{ id: "cash", label: "Fictional cash", provider: "Fictional", currency: "GHS", includeInCash: true, createdAt: AT }] };
    await db.query("update accounting_states set state=$2::jsonb where owner_id=$1::uuid", [OWNER, JSON.stringify(base)]);
    await warm();
    const before = await one<string>("select public.alfred_accounting_source_version($1::uuid) as value", [OWNER]);
    const rules = { ...emptyAccountRuleState(OWNER), revision: 1, rules: [{ id: "30000000-0000-4000-8000-000000000001", accountId: "cash", matchMode: "exact", merchantExact: "fictional merchant", direction: "out", category: "Transport", active: true, priority: 0, effectiveFrom: AT, createdAt: AT, revision: 1 }] };
    expect(await one("select public.alfred_write_account_rules($1::uuid,0,'display-rule-write',$2,$3::jsonb) as value", [OWNER, "1".repeat(64), JSON.stringify(rules)])).toMatchObject({ status: "saved" });
    const after = await one<string>("select public.alfred_accounting_source_version($1::uuid) as value", [OWNER]);
    expect(after).not.toBe(before);
    expect(await one("select revision::int as value from accounting_states where owner_id=$1::uuid", [OWNER])).toBe(0);
    expect(await read()).toBeNull();
  });

  it("tracks both owners on reassignment and permits legacy NULL-owner rows", async () => {
    await db.query("update transactions set owner_id=$2::uuid where owner_id=$1::uuid", [OWNER, OTHER]);
    expect((await events(OWNER)).rows).toHaveLength(1); expect((await events(OTHER)).rows).toHaveLength(1);
    await db.query("update transactions set owner_id=null where owner_id=$1::uuid", [OTHER]);
    expect((await events(OTHER)).rows).toHaveLength(2);
    await db.query("update transactions set description='Legacy ownerless' where owner_id is null");
    expect(await one("select count(*)::int as value from alfred_display.dirty_events")).toBe(3);
  });

  it("handles physical source deletion, import-source deletion and source rollback", async () => {
    await warm(); await db.exec("begin");
    await db.query("delete from transactions where owner_id=$1::uuid", [OWNER]);
    await db.exec("rollback");
    expect(await read()).toBeTruthy(); expect((await events()).rows).toHaveLength(0);
    await db.query("delete from imported_finance_sources where owner_id=$1::uuid", [OWNER]);
    expect(await read()).toBeNull();
  });

  it("rejects a source change between capture and publication without deleting its event", async () => {
    const job = await take(), baseline = (await capture(job))!;
    await db.query("update transactions set description='After capture' where owner_id=$1::uuid", [OWNER]);
    expect((await publish(job, baseline))?.status).toBe("stale");
    expect((await events()).rows).toHaveLength(1); expect(await read()).toBeNull();
  });

  it("forbids a builder inside a source-writing transaction so coalesced later writes cannot disappear", async () => {
    await warm();
    const job = await take(), baseline = (await capture(job))!;
    const original = (await db.query("select token::text,manifest from alfred_display.publications where owner_id=$1::uuid", [OWNER])).rows;
    await db.exec("begin");
    try {
      await db.query("update transactions set description='Write A' where owner_id=$1::uuid", [OWNER]);
      expect(await capture(job)).toBeNull();
      expect(await one("select alfred_display.enqueue($1::uuid,$2) as value", [OWNER, DEFINITION])).toEqual({ status: "not_ready" });
      expect(await one("select alfred_display.claim_owner($1::uuid,$2,$3::uuid,120) as value", [OWNER, DEFINITION, randomUUID()])).toBeNull();
      expect(await one("select alfred_display.claim($1,$2::uuid,120) as value", [DEFINITION, randomUUID()])).toBeNull();
      await db.query("update transactions set description='Write B' where owner_id=$1::uuid", [OWNER]);
      expect((await publish(job, baseline, model(OWNER, "Must not become current")))?.status).toBe("not_ready");
      expect((await events()).rows).toHaveLength(1);
    } finally { await db.exec("commit"); }
    expect((await db.query("select token::text,manifest from alfred_display.publications where owner_id=$1::uuid", [OWNER])).rows).toEqual(original);
    expect(await read()).toBeNull();
    expect(await one("select description as value from transactions where owner_id=$1::uuid", [OWNER])).toBe("Write B");
  });

  it("fences expired and superseded workers and prevents old-definition publication", async () => {
    const first = await take(), baseline = (await capture(first))!;
    await db.query("update alfred_display.jobs set lease_until=clock_timestamp()-interval '1 second' where owner_id=$1::uuid", [OWNER]);
    expect((await publish(first, baseline))?.status).toBe("lease_lost");
    const replacement = await take();
    expect(await capture(first)).toBeNull();
    expect((await publish(first, baseline))?.status).toBe("lease_lost");
    await one("select alfred_display.enqueue($1::uuid,$2) as value", [OWNER, "accounting-display-v2"]);
    expect((await publish(replacement, (await one<Baseline>("select jsonb_build_object('token','0','publishRevision','0','epoch',epoch::text,'events','[]'::jsonb) as value from alfred_display.clock"))!))?.status).toBe("lease_lost");
    expect(await one("select alfred_display.fail($1::uuid,$2::uuid,'source_changed') as value", [OWNER, replacement.leaseToken])).toMatchObject({ status: "released" });
    expect((await take(OWNER, "accounting-display-v2")).definition).toBe("accounting-display-v2");
  });

  it("rolls back replacement rows/manifest/events if the lease expires during insertion", async () => {
    const { baseline: oldBaseline } = await warm();
    await db.query("update transactions set description='Dirty before expiry rehearsal' where owner_id=$1::uuid", [OWNER]);
    const job = await take(), baseline = (await capture(job))!;
    const before = (await db.query("select token::text,manifest from alfred_display.publications where owner_id=$1::uuid", [OWNER])).rows;
    await db.exec("create sequence alfred_display.test_insert_trace;create function alfred_display.test_expire_rows() returns trigger language plpgsql as $$begin perform nextval('alfred_display.test_insert_trace');perform pg_sleep(0.15);return new;end$$;create trigger test_expire_rows after insert on alfred_display.rows for each row execute function alfred_display.test_expire_rows();");
    await db.query("update alfred_display.jobs set lease_until=clock_timestamp()+interval '100 milliseconds' where owner_id=$1::uuid", [OWNER]);
    expect((await publish(job, baseline, model(OWNER, "Must roll back")))?.status).toBe("lease_lost");
    expect(await one("select is_called as value from alfred_display.test_insert_trace")).toBe(true);
    expect((await db.query("select token::text,manifest from alfred_display.publications where owner_id=$1::uuid", [OWNER])).rows).toEqual(before);
    expect((await events()).rows.map(row => row.id)).toEqual(baseline.events);
    expect(await one("select payload->>'label' as value from alfred_display.rows where owner_id=$1::uuid", [OWNER])).toBe("Fictional");
    expect(oldBaseline).toBeTruthy();
  });

  it("rejects missing rows, duplicate identities and cross-owner manifests atomically", async () => {
    const job = await take(), baseline = (await capture(job))!, missing = model(); missing.rows = [];
    expect((await publish(job, baseline, missing))?.status).toBe("invalid");
    const duplicate = model(); duplicate.rows.push({ ...duplicate.rows[0], ordinal: 1 }); duplicate.manifest.rowCounts.ledger = 2;
    expect((await publish(job, baseline, duplicate))?.status).toBe("invalid");
    expect((await publish(job, baseline, model(OTHER)))?.status).toBe("invalid");
    expect(await one("select count(*)::int as value from alfred_display.rows")).toBe(0);
  });

  it("keeps bounded generic failure metadata, preserves events and respects enqueue backoff", async () => {
    await db.query("update transactions set description='Dirty' where owner_id=$1::uuid", [OWNER]);
    const job = await take();
    expect(await one("select alfred_display.fail($1::uuid,$2::uuid,$3) as value", [OWNER, job.leaseToken, "DO NOT STORE private finance details"])).toEqual({ status: "released" });
    expect(await one("select last_error_code as value from alfred_display.jobs where owner_id=$1::uuid", [OWNER])).toBe("build_failed");
    await one("select alfred_display.enqueue($1::uuid,$2) as value", [OWNER, DEFINITION]);
    expect(await one("select alfred_display.claim_owner($1::uuid,$2,$3::uuid,120) as value", [OWNER, DEFINITION, randomUUID()])).toBeNull();
    expect((await events()).rows).toHaveLength(1);
  });

  it("invalidates on TRUNCATE and rejects disabled/replaced trigger contracts", async () => {
    await warm(); await db.exec("truncate bank_messages cascade"); expect(await read()).toBeNull();
    await db.exec("begin");
    try {
      await db.exec("alter table transactions disable trigger display_update");
      expect(await one("select alfred_display.readiness() as value")).toBe(false);
      expect(await read()).toBeNull();
    } finally { await db.exec("rollback"); }
    await db.exec("begin");
    try {
      await db.exec("create or replace function alfred_display.changed() returns trigger language plpgsql security invoker set search_path='' as $$begin return null;end$$");
      expect(await one("select alfred_display.readiness() as value")).toBe(false);
    } finally { await db.exec("rollback"); }
  });

  it("enforces private ACL/RLS and serves a fresh model without any source-table SELECT privileges", async () => {
    await warm();
    const protectedTables = (await db.query<{ relname: string; relrowsecurity: boolean }>("select c.relname,c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='alfred_display' and c.relkind='r'")).rows;
    expect(protectedTables.every(table => table.relrowsecurity)).toBe(true);
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      try { await expect(db.query("select alfred_display.manifest($1::uuid,$2)", [OWNER, DEFINITION])).rejects.toThrow(/permission denied/); }
      finally { await db.exec("reset role"); }
    }
    await db.exec("begin");
    try {
      await db.exec("create role display_sql_reader bypassrls;grant usage on schema alfred_display to display_sql_reader;grant select on all tables in schema alfred_display to display_sql_reader;grant execute on all functions in schema alfred_display to display_sql_reader;set local role display_sql_reader;savepoint denied_source");
      await expect(db.query("select 1 from transactions limit 0")).rejects.toThrow(/permission denied/);
      await db.exec("rollback to savepoint denied_source;release savepoint denied_source");
      expect((await read())?.manifest.label).toBe("Fictional");
    } finally { await db.exec("rollback"); }
  });

  it("cleans only orphan invalidation metadata and leaves financial records unchanged", async () => {
    const orphan = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await db.query("insert into alfred_display.dirty_events(owner_id,transaction_id) values($1,123)", [orphan]);
    expect(await one("select alfred_display.cleanup(100) as value")).toBe(1);
    expect(await one("select count(*)::int as value from transactions")).toBe(1);
  });

  it("actual financial saves and Undo still use complete authoritative state and invalidate display", async () => {
    const base: AccountingState = { ...emptyAccountingState(OWNER), accounts: [{ id: "cash", label: "Original", provider: "Fictional", currency: "GHS", includeInCash: true, createdAt: AT }] };
    await db.query("update accounting_states set state=$2::jsonb where owner_id=$1::uuid", [OWNER, JSON.stringify(base)]);
    await warm();
    const action = { type: "update_account" as const, expectedRevision: 0, requestId: "durable-save", accountId: "cash", changes: { label: "Updated" } };
    const next = applyAccountingAction(base, action, AT), source = await one<string>("select alfred_accounting_source_version($1::uuid) as value", [OWNER]);
    expect(await one("select alfred_write_accounting_state($1::uuid,0,$2,$3,$4,$5::jsonb) as value", [OWNER, action.requestId, actionFingerprint(action), source, JSON.stringify(next)])).toMatchObject({ status: "saved" });
    expect(await read()).toBeNull();
    const undo = { type: "undo" as const, expectedRevision: 1, requestId: "durable-undo" }, restored = applyAccountingAction(next, undo, AT);
    expect(await one("select alfred_write_accounting_state($1::uuid,1,$2,$3,$4,$5::jsonb) as value", [OWNER, undo.requestId, actionFingerprint(undo), source, JSON.stringify(restored)])).toMatchObject({ status: "saved" });
    const saved = await one<AccountingState>("select state as value from accounting_states where owner_id=$1::uuid", [OWNER]);
    expect(saved.accounts[0].label).toBe("Original");
    expect(saved.audit[0].before.accounts[0].label).toBe("Original");
    expect(saved.audit[1].before.accounts[0].label).toBe("Updated");
  });
});
