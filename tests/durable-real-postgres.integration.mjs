import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { startLocalCluster } from '../scripts/test-durable-postgres.mjs';

// Opt-in only. This runner always creates its own new /tmp cluster through the
// helper; it never accepts a connection URL or application database settings.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const emptyState = owner => ({ ownerId: owner, revision: 0, accounts: [{ id: 'fictional-cash', label: 'Fictional cash', provider: 'Synthetic provider', currency: 'GHS', includeInCash: true, createdAt: '2026-11-05T00:00:00.000Z' }], movements: [], snapshots: [], transfers: [], settlements: [], audit: [] });

async function source(client, owner, label) {
  await client.query(`insert into public.bank_messages(id,owner_id,source,channel,text_hash,direction,kind,amount,currency,counterparty,occurred_at,status,raw)
    values($1::uuid,$2::uuid,'momo','manual',$3,'out','payment',100,'GHS',$3,'2026-11-05T12:00:00Z','recorded','Fictional local source only')`, [randomUUID(), owner, label]);
}
async function rawSource(client, owner, label) {
  await client.query(`insert into public.transactions(owner_id,transaction_id,created_at,transaction_date,user_id,type,amount,currency,category,description,status,updated_at,source_update_id)
    values($1::uuid,$2::uuid,'2026-11-05T12:00:00Z','2026-11-05',$1::text,'expense',100,'GHS','Food',$3,'active','2026-11-05T12:00:00Z',$3)`, [owner, randomUUID(), label]);
}
async function blocked(control, waitingPid, blockingPid) {
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    const { rows } = await control.query('select $2::int=any(pg_blocking_pids($1::int)) as blocked', [waitingPid, blockingPid]);
    if (rows[0].blocked) return;
    await delay(10);
  }
  throw new Error('Expected real PostgreSQL lock wait was not observed.');
}
async function pid(client) { return (await client.query('select pg_backend_pid() as pid')).rows[0].pid; }

const MODEL = 'accounting-display-v1';
const CANDIDATE = 'supabase/migrations/20261105182432_durable_accounting_display.sql';
const COMPACT_CANDIDATE = 'supabase/migrations/20261105192204_compact_accounting_writes.sql';
const KINDS = ['movement', 'snapshot', 'transfer', 'settlement', 'return', 'evidence', 'ledger'];
async function modelRead(client, owner, definition = MODEL) {
  const result = await client.query(`with fresh as materialized(select alfred_display.manifest($1::uuid,$2::text) as publication)
    select jsonb_build_object('manifest',publication->'manifest','rows',coalesce((
      select jsonb_agg(item.payload order by item.ordinal) from (
        select r.ordinal,r.payload from alfred_display.rows r
        where r.owner_id=$1::uuid and r.definition=$2 and r.token=(publication->>'token')::bigint
          and r.epoch=(publication->>'epoch')::bigint order by r.ordinal limit 25
      ) item),'[]'::jsonb)) as bundle from fresh where publication is not null`, [owner, definition]);
  return result.rows[0]?.bundle ?? null;
}
async function modelDirty(client, owner) {
  return (await client.query('select id::text from alfred_display.dirty_events where owner_id=$1::uuid order by id', [owner])).rows.map(row => row.id);
}
async function claimOwner(client, owner, token = randomUUID(), seconds = 30, definition = MODEL) {
  return (await client.query('select alfred_display.claim_owner($1::uuid,$2::text,$3::uuid,$4::integer) as job', [owner, definition, token, seconds])).rows[0].job;
}
async function modelCapture(client, job) {
  return (await client.query('select alfred_display.capture($1::uuid,$2::text,$3::uuid) as baseline', [job.ownerId, job.definition, job.leaseToken])).rows[0].baseline;
}
async function modelBuild(client, owner, marker) {
  const version = (await client.query('select alfred_accounting_source_version($1::uuid) as value', [owner])).rows[0].value;
  const revision = Number((await client.query('select revision from accounting_states where owner_id=$1::uuid', [owner])).rows[0]?.revision ?? 0);
  const payload = { ownerId: owner, marker, sourceVersion: version };
  return {
    manifest: { kind: 'accounting-display', projectorVersion: 1, ownerId: owner, revision, sourceVersion: version, rowCounts: Object.fromEntries(KINDS.map(kind => [kind, kind === 'ledger' ? 1 : 0])) },
    rows: [{ kind: 'ledger', id: 'fictional-ledger-row', ordinal: 0, date: '2026-11-05', currency: 'GHS', payload }],
  };
}
async function modelPublish(client, job, baseline, model) {
  return (await client.query('select alfred_display.publish($1::uuid,$2::text,$3::uuid,$4::jsonb,$5::jsonb,$6::jsonb) as result', [job.ownerId, job.definition, job.leaseToken, JSON.stringify(baseline), JSON.stringify(model.manifest), JSON.stringify(model.rows)])).rows[0].result;
}
async function release(client, job, code = 'build_failed') {
  return (await client.query('select alfred_display.fail($1::uuid,$2::uuid,$3::text) as result', [job.ownerId, job.leaseToken, code])).rows[0].result;
}
async function createModelOwner(client) {
  const owner = randomUUID();
  await client.query('insert into auth.users(id) values($1::uuid)', [owner]);
  await client.query('insert into accounting_states(owner_id,revision,state) values($1::uuid,0,$2::jsonb)', [owner, JSON.stringify(emptyState(owner))]);
  return owner;
}
async function modelSeed(client) {
  const owner = await createModelOwner(client), job = await claimOwner(client, owner);
  assert.equal(job.ownerId, owner);
  const baseline = await modelCapture(client, job), model = await modelBuild(client, owner, 'initial');
  assert.equal((await modelPublish(client, job, baseline, model)).status, 'saved');
  assert.deepEqual(await modelRead(client, owner), { manifest: model.manifest, rows: model.rows.map(row => row.payload) });
  return { owner, model };
}
async function financialAbi(client) {
  return (await client.query(`select oid::regprocedure::text as signature,prosrc,provolatile,prosecdef,proowner::text,proconfig,proacl::text
    from pg_proc where oid in ('alfred_accounting_document_valid(jsonb,uuid)'::regprocedure,'alfred_accounting_source_version(uuid)'::regprocedure,
      'alfred_write_accounting_state(uuid,bigint,text,text,text,jsonb)'::regprocedure,'alfred_write_account_rules(uuid,bigint,text,text,jsonb)'::regprocedure,
      'alfred_undo_finance_import(uuid,text)'::regprocedure,'alfred_confirm_finance_import(uuid,text)'::regprocedure,
      'alfred_portability_native_version(uuid)'::regprocedure) order by oid::regprocedure::text`)).rows;
}
function compactAction(state, requestId, label, action = 'update_account', accounts = [{ ...state.accounts[0], label }]) {
  const { ownerId: _owner, revision: _revision, audit: _audit, ...before } = state;
  void _owner; void _revision; void _audit;
  const fingerprint = createHash('sha256').update(JSON.stringify([requestId, label, action, accounts])).digest('hex');
  const empty = { accounts: [], movements: [], snapshots: [], transfers: [], settlements: [] };
  const next = { ...state, revision: state.revision + 1, accounts, audit: [
    ...state.audit.slice(-49).map(entry => ({ ...entry, before: empty })),
    { id: requestId, requestId, action, actionFingerprint: fingerprint, at: '2026-11-05T12:00:00.000Z', revision: state.revision + 1, before },
  ] };
  return { requestId, fingerprint, expectedRevision: state.revision, next };
}
async function compactWrite(client, owner, action, sourceVersion) {
  return (await client.query('select alfred_write_accounting_state_compact($1::uuid,$2,$3,$4,$5,$6::jsonb) as result', [owner, action.expectedRevision, action.requestId, action.fingerprint, sourceVersion, JSON.stringify(action.next)])).rows[0].result;
}

export async function runIntegratedPostgresChecks({ binaryDirectory, output } = {}) {
  const sql = await readFile(resolve(ROOT, CANDIDATE), 'utf8');
  const compactSql = await readFile(resolve(ROOT, COMPACT_CANDIDATE), 'utf8');
  const cluster = await startLocalCluster({ Client: pg.Client, binaryDirectory });
  const report = { scope: 'Actual candidate migration on fictional local PostgreSQL sessions, not a production deployment or canonical-math benchmark', migration: CANDIDATE, migrationSha256: createHash('sha256').update(sql).digest('hex'), compactMigration: COMPACT_CANDIDATE, compactMigrationSha256: createHash('sha256').update(compactSql).digest('hex'), cases: [], cluster: cluster.root, socketOnly: true };
  let control;
  async function connect(name) {
    const client = await cluster.connect(name);
    await client.query("set statement_timeout='5s'");
    return client;
  }
  async function test(name, work) {
    const started = performance.now();
    await work();
    report.cases.push({ name, status: 'passed', elapsedMs: Number((performance.now() - started).toFixed(2)) });
    console.log(`PASS ${name}`);
  }
  try {
    control = await connect('alfred-integrated-control');
    report.version = (await control.query('select version() as version')).rows[0].version;
    report.durability = (await control.query("select current_setting('fsync') as fsync,current_setting('full_page_writes') as full_page_writes,current_setting('synchronous_commit') as synchronous_commit,current_setting('listen_addresses') as listen_addresses")).rows[0];
    assert.equal(report.durability.listen_addresses, '');
    await control.query("create role anon;create role authenticated;create schema auth;create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}'::jsonb);");
    const baselineFiles = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD', '--', 'supabase/migrations'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').filter(file => file.endsWith('.sql') && file !== CANDIDATE && file !== COMPACT_CANDIDATE).sort();
    for (const file of baselineFiles) await control.query(await readFile(resolve(ROOT, file), 'utf8'));
    const abi = await financialAbi(control);
    await control.query('begin'); await control.query(sql); await control.query(compactSql); await control.query('commit');
    assert.equal((await control.query('select alfred_display.readiness() as ready')).rows[0].ready, true);
    assert.deepEqual(await financialAbi(control), abi);

    await test('exact-owner lease isolates inline rebuilds and independent global claims select separate jobs', async () => {
      const left = await createModelOwner(control), right = await createModelOwner(control);
      await control.query('select alfred_display.enqueue($1::uuid,$2)', [left, MODEL]);
      const selected = await claimOwner(control, right);
      assert.equal(selected.ownerId, right);
      assert.equal((await control.query('select lease_token from alfred_display.jobs where owner_id=$1::uuid', [left])).rows[0].lease_token, null);
      assert.equal(await modelRead(control, left), null);
      const wrongOwner = { ...selected, ownerId: left };
      assert.equal(await modelCapture(control, wrongOwner), null);
      const a = await connect('alfred-global-claim-a'), b = await connect('alfred-global-claim-b'), definition = 'real-batch-fixture';
      try {
        const owners = [await createModelOwner(control), await createModelOwner(control)];
        for (const owner of owners) await control.query('select alfred_display.enqueue($1::uuid,$2)', [owner, definition]);
        const jobs = await Promise.all([a, b].map(client => client.query('select alfred_display.claim($1,$2::uuid,30) as job', [definition, randomUUID()])));
        assert.deepEqual(new Set(jobs.map(result => result.rows[0].job.ownerId)), new Set(owners));
      } finally { await a.end(); await b.end(); }
    });

    await test('raw-source late lower-ID commit remains dirty after a higher-ID bank event is published', async () => {
      const { owner } = await modelSeed(control), a = await connect('alfred-integrated-source-low');
      try {
        await a.query('begin'); await rawSource(a, owner, 'late-low');
        const low = (await modelDirty(a, owner))[0];
        await source(control, owner, 'early-high');
        const job = await claimOwner(control, owner), baseline = await modelCapture(control, job), model = await modelBuild(control, owner, 'high-visible');
        assert.equal(baseline.events.length, 1); assert.ok(BigInt(low) < BigInt(baseline.events[0]));
        assert.equal((await modelPublish(control, job, baseline, model)).status, 'saved');
        assert.notEqual(await modelRead(control, owner), null);
        await a.query('commit');
        assert.deepEqual(await modelDirty(control, owner), [low]);
        assert.equal(await modelRead(control, owner), null);
      } finally { await a.query('rollback').catch(() => {}); await a.end(); }
    });

    await test('display APIs reject coalesced source mutations from their own current transaction', async () => {
      const { owner, model: initial } = await modelSeed(control), job = await claimOwner(control, owner), prior = await modelCapture(control, job), writer = await connect('alfred-current-source-transaction');
      try {
        await writer.query('begin'); await rawSource(writer, owner, 'same-xid-A');
        assert.equal((await writer.query('select alfred_display.enqueue($1::uuid,$2) as result', [owner, MODEL])).rows[0].result.status, 'not_ready');
        assert.equal(await claimOwner(writer, owner), null);
        assert.equal((await writer.query('select alfred_display.claim($1,$2::uuid,30) as result', [MODEL, randomUUID()])).rows[0].result, null);
        assert.equal(await modelCapture(writer, job), null);
        await rawSource(writer, owner, 'same-xid-B');
        assert.equal((await modelDirty(writer, owner)).length, 1);
        assert.equal((await modelPublish(writer, job, prior, initial)).status, 'not_ready');
        assert.equal(await modelRead(writer, owner), null);
        assert.deepEqual((await modelRead(control, owner)).rows, initial.rows.map(row => row.payload));
        await writer.query('commit');
        assert.equal((await modelDirty(control, owner)).length, 1);
        assert.equal(await modelRead(control, owner), null);
        assert.equal((await control.query('select count(*)::int as count from transactions where owner_id=$1::uuid', [owner])).rows[0].count, 2);
        assert.equal((await release(control, job, 'source_changed')).status, 'released');

        const rolledBack = await modelSeed(control), rollbackJob = await claimOwner(control, rolledBack.owner), baseline = await modelCapture(control, rollbackJob);
        await writer.query('begin'); await source(writer, rolledBack.owner, 'same-xid-rollback');
        assert.equal((await modelPublish(writer, rollbackJob, baseline, rolledBack.model)).status, 'not_ready');
        await writer.query('rollback');
        assert.deepEqual(await modelDirty(control, rolledBack.owner), []);
        assert.deepEqual((await modelRead(control, rolledBack.owner)).rows, rolledBack.model.rows.map(row => row.payload));
      } finally { await writer.query('rollback').catch(() => {}); await writer.end(); }
    });

    await test('a post-capture source change rejects publication without clearing invalidation or old rows', async () => {
      const { owner, model: initial } = await modelSeed(control), job = await claimOwner(control, owner);
      const baseline = await modelCapture(control, job), candidate = await modelBuild(control, owner, 'stale-builder');
      await source(control, owner, 'after-capture');
      const ids = await modelDirty(control, owner);
      assert.equal((await modelPublish(control, job, baseline, candidate)).status, 'stale');
      assert.deepEqual(await modelDirty(control, owner), ids);
      assert.equal(await modelRead(control, owner), null);
      assert.deepEqual((await control.query('select payload from alfred_display.rows where owner_id=$1::uuid', [owner])).rows.map(row => row.payload), initial.rows.map(row => row.payload));
      assert.equal((await release(control, job, 'source_changed')).status, 'released');
      assert.equal(await claimOwner(control, owner), null);
      await delay(2100);
      const recovered = await claimOwner(control, owner), next = await modelCapture(control, recovered), fresh = await modelBuild(control, owner, 'after-backoff');
      assert.equal((await modelPublish(control, recovered, next, fresh)).status, 'saved');
    });

    await test('concurrent duplicate publishers wait and a consumed lease cannot overwrite the newer result', async () => {
      const { owner } = await modelSeed(control), job = await claimOwner(control, owner), baseline = await modelCapture(control, job);
      const a = await connect('alfred-integrated-publish-a'), b = await connect('alfred-integrated-publish-b');
      const fresh = await modelBuild(control, owner, 'first-ack'), old = await modelBuild(control, owner, 'old-duplicate');
      try {
        await a.query('begin'); assert.equal((await modelPublish(a, job, baseline, fresh)).status, 'saved');
        await b.query('begin'); const waitingPid = await pid(b), blockerPid = await pid(a);
        const pending = modelPublish(b, job, baseline, old); pending.catch(() => {});
        await blocked(control, waitingPid, blockerPid); await a.query('commit');
        assert.equal((await pending).status, 'lease_lost'); await b.query('commit');
        assert.deepEqual((await modelRead(control, owner)).rows, fresh.rows.map(row => row.payload));
      } finally { await a.query('rollback').catch(() => {}); await b.query('rollback').catch(() => {}); await a.end(); await b.end(); }
    });

    await test('a source writer does not wait on a held publisher and its late commit gates every normalized row', async () => {
      const { owner } = await modelSeed(control), job = await claimOwner(control, owner), baseline = await modelCapture(control, job), model = await modelBuild(control, owner, 'publication-before-source');
      const publisher = await connect('alfred-integrated-held-publication'), writer = await connect('alfred-integrated-independent-source');
      try {
        await publisher.query('begin'); assert.equal((await modelPublish(publisher, job, baseline, model)).status, 'saved');
        await writer.query('begin'); await source(writer, owner, 'during-publication'); await writer.query('commit');
        await publisher.query('commit');
        assert.equal(await modelRead(control, owner), null);
        assert.equal((await modelDirty(control, owner)).length, 1);
      } finally { await publisher.query('rollback').catch(() => {}); await writer.query('rollback').catch(() => {}); await publisher.end(); await writer.end(); }
    });

    await test('source rollback and publication rollback preserve their respective committed generations', async () => {
      const { owner, model: initial } = await modelSeed(control), writer = await connect('alfred-integrated-rollback-source'), publisher = await connect('alfred-integrated-rollback-publication');
      try {
        await writer.query('begin'); await source(writer, owner, 'rolled-back-source'); await writer.query('rollback');
        assert.deepEqual((await modelRead(control, owner)).rows, initial.rows.map(row => row.payload));
        await source(control, owner, 'committed-source');
        const job = await claimOwner(control, owner), baseline = await modelCapture(control, job), candidate = await modelBuild(control, owner, 'uncommitted-model'), ids = await modelDirty(control, owner);
        await publisher.query('begin'); assert.equal((await modelPublish(publisher, job, baseline, candidate)).status, 'saved');
        assert.equal(await modelRead(control, owner), null); await publisher.query('rollback');
        assert.deepEqual(await modelDirty(control, owner), ids);
        assert.equal((await modelCapture(control, job)).publishRevision, baseline.publishRevision);
        assert.deepEqual((await control.query('select payload from alfred_display.rows where owner_id=$1::uuid', [owner])).rows.map(row => row.payload), initial.rows.map(row => row.payload));
      } finally { await writer.query('rollback').catch(() => {}); await publisher.query('rollback').catch(() => {}); await writer.end(); await publisher.end(); }
    });

    await test('bank-source and actual rule writers complete through the former shared-owner lock cycle', async () => {
      const { owner } = await modelSeed(control), bank = await connect('alfred-integrated-bank'), rules = await connect('alfred-integrated-rules');
      try {
        await rules.query('begin'); await rules.query('select state from accounting_states where owner_id=$1::uuid for share', [owner]);
        await bank.query('begin'); await source(bank, owner, 'bank-before-rule');
        const waitingPid = await pid(bank), blockerPid = await pid(rules), waiting = bank.query('update accounting_states set updated_at=now() where owner_id=$1::uuid', [owner]); waiting.catch(() => {});
        await blocked(control, waitingPid, blockerPid);
        const saved = await rules.query('select alfred_write_account_rules($1::uuid,0,$2,$3,$4::jsonb) as result', [owner, 'local-rule:integrated', 'b'.repeat(64), JSON.stringify({ ownerId: owner, revision: 1, rules: [], bindings: [] })]);
        assert.equal(saved.rows[0].result.status, 'saved'); await rules.query('commit'); await waiting; await bank.query('commit');
        assert.equal((await modelDirty(control, owner)).length, 2);
        assert.equal(await modelRead(control, owner), null);
      } finally { await bank.query('rollback').catch(() => {}); await rules.query('rollback').catch(() => {}); await bank.end(); await rules.end(); }
    });

    await test('global discovery skips an inline-owned wakeup row without a job/health lock inversion', async () => {
      const { owner } = await modelSeed(control); await source(control, owner, 'needs-wakeup');
      const inline = await connect('alfred-inline-job-holder'), global = await connect('alfred-global-wakeup');
      try {
        await inline.query('begin');
        await inline.query('select alfred_display.enqueue($1::uuid,$2)', [owner, MODEL]);
        await global.query("set statement_timeout='2s'");
        const selected = (await global.query('select alfred_display.claim($1,$2::uuid,30) as job', [MODEL, randomUUID()])).rows[0].job;
        assert.notEqual(selected?.ownerId, owner);
        const exact = await claimOwner(inline, owner);
        assert.equal(exact.ownerId, owner); await inline.query('commit');
      } finally { await inline.query('rollback').catch(() => {}); await inline.end(); await global.end(); }
    });

    await test('an inline reader returns promptly while its owner job is locked by another session', async () => {
      const { owner } = await modelSeed(control), holder = await connect('alfred-job-row-holder'), inline = await connect('alfred-fast-inline-claim');
      try {
        await holder.query('begin');
        await holder.query('select owner_id from alfred_display.jobs where owner_id=$1::uuid for update', [owner]);
        await inline.query("set statement_timeout='1s'");
        assert.equal(await claimOwner(inline, owner), null);
        await holder.query('rollback');
        assert.notEqual(await claimOwner(inline, owner), null);
      } finally { await holder.query('rollback').catch(() => {}); await holder.end(); await inline.end(); }
    });

    await test('backend death retains its lease until real expiry and a new token fences the dead worker', async () => {
      const { owner } = await modelSeed(control), worker = await connect('alfred-integrated-dead-worker'), old = await claimOwner(worker, owner, randomUUID(), 10);
      const baseline = await modelCapture(worker, old), candidate = await modelBuild(control, owner, 'dead-worker');
      await control.query('select pg_terminate_backend($1::int)', [await pid(worker)]);
      assert.equal(await claimOwner(control, owner), null);
      await delay(Math.max(0, Date.parse(old.leaseUntil) - Date.now()) + 80);
      const replacement = await claimOwner(control, owner);
      assert.notEqual(replacement.leaseToken, old.leaseToken);
      assert.equal(await modelCapture(control, old), null);
      assert.equal((await modelPublish(control, old, baseline, candidate)).status, 'lease_lost');
      assert.equal((await release(control, old)).status, 'lease_lost');
      const next = await modelCapture(control, replacement), fresh = await modelBuild(control, owner, 'replacement-worker');
      assert.equal((await modelPublish(control, replacement, next, fresh)).status, 'saved');
      report.realLeaseExpiryObserved = true;
    });

    await test('lease expiry during row insertion rolls the whole candidate back', async () => {
      const { owner, model: initial } = await modelSeed(control);
      await source(control, owner, 'source-before-slow-insert');
      const job = await claimOwner(control, owner, randomUUID(), 10), baseline = await modelCapture(control, job), candidate = await modelBuild(control, owner, 'must-not-survive-expiry'), ids = await modelDirty(control, owner);
      await control.query("create function alfred_display.fixture_delay() returns trigger language plpgsql as $$begin perform pg_sleep(11);return null;end$$;create trigger fixture_delay before insert on alfred_display.rows for each statement execute function alfred_display.fixture_delay();set statement_timeout='20s'");
      try { assert.equal((await modelPublish(control, job, baseline, candidate)).status, 'lease_lost'); }
      finally { await control.query("drop trigger fixture_delay on alfred_display.rows;drop function alfred_display.fixture_delay();set statement_timeout='5s'"); }
      assert.deepEqual(await modelDirty(control, owner), ids);
      assert.equal((await control.query('select publish_revision::text as revision from alfred_display.publications where owner_id=$1::uuid', [owner])).rows[0].revision, baseline.publishRevision);
      assert.deepEqual((await control.query('select payload from alfred_display.rows where owner_id=$1::uuid', [owner])).rows.map(row => row.payload), initial.rows.map(row => row.payload));
      assert.equal(await modelRead(control, owner), null);
      const recovered = await claimOwner(control, owner), next = await modelCapture(control, recovered), fresh = await modelBuild(control, owner, 'after-late-expiry');
      assert.equal((await modelPublish(control, recovered, next, fresh)).status, 'saved');
    });

    await test('process death before COMMIT preserves dirty events, old rows and the recoverable lease', async () => {
      const { owner, model: initial } = await modelSeed(control);
      await source(control, owner, 'durable-before-crash');
      const job = await claimOwner(control, owner), baseline = await modelCapture(control, job), model = await modelBuild(control, owner, 'uncommitted-before-crash'), ids = await modelDirty(control, owner), publisher = await connect('alfred-integrated-crash-publisher');
      await publisher.query('begin'); assert.equal((await modelPublish(publisher, job, baseline, model)).status, 'saved');
      await cluster.crashAndRestart(); control = await connect('alfred-integrated-recovery-control');
      assert.deepEqual(await modelDirty(control, owner), ids);
      assert.equal((await modelCapture(control, job)).publishRevision, baseline.publishRevision);
      assert.deepEqual((await control.query('select payload from alfred_display.rows where owner_id=$1::uuid', [owner])).rows.map(row => row.payload), initial.rows.map(row => row.payload));
      assert.equal(await modelRead(control, owner), null);
      const next = await modelCapture(control, job), recovered = await modelBuild(control, owner, 'recovered-after-crash');
      assert.equal((await modelPublish(control, job, next, recovered)).status, 'saved');
    });

    await test('acknowledged normalized publication survives immediate process death and WAL recovery', async () => {
      const { owner } = await modelSeed(control); await source(control, owner, 'committed-before-crash');
      const job = await claimOwner(control, owner), baseline = await modelCapture(control, job), model = await modelBuild(control, owner, 'committed-before-crash');
      assert.equal((await modelPublish(control, job, baseline, model)).status, 'saved');
      await cluster.crashAndRestart(); control = await connect('alfred-integrated-ack-recovery');
      assert.deepEqual(await modelDirty(control, owner), []);
      assert.deepEqual(await modelRead(control, owner), { manifest: model.manifest, rows: model.rows.map(row => row.payload) });
      assert.match(await readFile(cluster.log, 'utf8'), /automatic recovery in progress/);
      report.crashRecovery = { immediateProcessDeaths: 2, uncommittedPublicationRolledBack: true, acknowledgedPublicationSurvived: true };
    });

    await test('invalid partial row insertion rolls back without consuming the lease or invalidation', async () => {
      const { owner, model: initial } = await modelSeed(control); await source(control, owner, 'before-invalid-batch');
      const job = await claimOwner(control, owner), baseline = await modelCapture(control, job), model = await modelBuild(control, owner, 'invalid-partial-batch'), ids = await modelDirty(control, owner);
      const invalid = { manifest: { ...model.manifest, rowCounts: { ...model.manifest.rowCounts, ledger: 2 } }, rows: [model.rows[0], { ...model.rows[0], id: 'another-id-same-ordinal' }] };
      assert.equal((await modelPublish(control, job, baseline, invalid)).status, 'invalid');
      assert.deepEqual(await modelDirty(control, owner), ids);
      assert.notEqual(await modelCapture(control, job), null);
      assert.deepEqual((await control.query('select payload from alfred_display.rows where owner_id=$1::uuid', [owner])).rows.map(row => row.payload), initial.rows.map(row => row.payload));
      assert.equal(await modelRead(control, owner), null);
      assert.equal((await modelPublish(control, job, baseline, model)).status, 'saved');
    });

    await test('actual import confirmation, import Undo and accounting write/Undo retain authoritative history', async () => {
      const { owner } = await modelSeed(control), before = emptyState(owner), receipt = 'real-session-import', archiveId = 'c'.repeat(64);
      const movement = { id: 'import:local-fixture', ownerId: owner, accountId: 'fictional-cash', direction: 'out', status: 'confirmed', amountMinor: 10000, feeMinor: 0,
        currency: 'GHS', date: '2026-11-05', occurredAt: '2026-11-05T12:00:00.000Z', description: 'Fictional imported payment', category: 'Food', sourceId: 'local-external-source', sourceKind: 'manual',
        sourceFingerprint: 'fictional-local-fingerprint', sourceText: 'Fictional retained import evidence', legacyTransactionId: null, feeTransactionId: null, legacyClassification: null };
      const beforeData = { accounts: before.accounts, movements: before.movements, snapshots: before.snapshots, transfers: before.transfers, settlements: before.settlements };
      const event = { id: `import:${receipt}`, requestId: `import:${receipt}`, action: 'import', actionFingerprint: archiveId, at: '2026-11-05T12:00:00.000Z', revision: 1, before: beforeData };
      const after = { ...before, revision: 1, movements: [movement], audit: [event] };
      const sourceVersion = (await control.query('select alfred_accounting_source_version($1::uuid) as value', [owner])).rows[0].value;
      const nativeVersion = (await control.query('select alfred_portability_native_version($1::uuid) as value', [owner])).rows[0].value;
      await control.query(`insert into finance_import_previews(owner_id,id,archive_id,source_version,native_version,expected_revision,base_hash,before_state,next_state,sources,archive,summary,expires_at)
        values($1::uuid,$2,$3,$4,$5,0,'fictional-reviewed-base',$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,'{"canConfirm":true}',clock_timestamp()+interval '5 minutes')`,
      [owner, receipt, archiveId, sourceVersion, nativeVersion, JSON.stringify(before), JSON.stringify(after), JSON.stringify([movement]), JSON.stringify({ archiveId })]);
      const imported = (await control.query('select alfred_confirm_finance_import($1::uuid,$2) as result', [owner, receipt])).rows[0].result;
      assert.equal(imported.status, 'saved');
      assert.equal(await modelRead(control, owner), null);
      assert.equal((await control.query('select count(*)::int as count from imported_finance_sources where owner_id=$1::uuid', [owner])).rows[0].count, 1);
      const hashes = async () => (await control.query('select alfred_accounting_source_version($1::uuid) as source,alfred_portability_native_version($1::uuid) as native', [owner])).rows[0];
      const beforeProjection = await hashes(), job = await claimOwner(control, owner), baseline = await modelCapture(control, job), model = await modelBuild(control, owner, 'after-confirmed-import');
      assert.equal((await modelPublish(control, job, baseline, model)).status, 'saved');
      assert.deepEqual(await hashes(), beforeProjection);
      const undone = (await control.query('select alfred_undo_finance_import($1::uuid,$2) as result', [owner, receipt])).rows[0].result;
      assert.equal(undone.status, 'saved');
      assert.equal(await modelRead(control, owner), null);
      assert.equal((await control.query('select count(*)::int as count from imported_finance_sources where owner_id=$1::uuid', [owner])).rows[0].count, 0);
      const restored = (await control.query('select state from accounting_states where owner_id=$1::uuid', [owner])).rows[0].state;
      assert.equal(restored.revision, 2); assert.equal(restored.movements.length, 0);
      assert.deepEqual(restored.audit.at(-1).before.movements, [movement]);
      assert.deepEqual((await control.query('select archive from finance_import_receipts where owner_id=$1::uuid and id=$2', [owner, receipt])).rows[0].archive, { archiveId });

      async function accountingWrite(state, requestId, action, accounts, fingerprint) {
        const { ownerId: _owner, revision: _revision, audit: _audit, ...data } = state;
        void _owner; void _revision; void _audit;
        const next = { ...state, revision: state.revision + 1, accounts, audit: [...state.audit, { id: requestId, requestId, action, actionFingerprint: fingerprint,
          at: '2026-11-05T12:00:00.000Z', revision: state.revision + 1, before: data }] };
        const version = (await hashes()).source;
        const result = (await control.query('select alfred_write_accounting_state($1::uuid,$2,$3,$4,$5,$6::jsonb) as result', [owner, state.revision, requestId, fingerprint, version, JSON.stringify(next)])).rows[0].result;
        assert.equal(result.status, 'saved');
        return { next, version };
      }
      const fingerprint = 'd'.repeat(64), requestId = 'local:account-update';
      const saved = await accountingWrite(restored, requestId, 'update_account', [{ ...restored.accounts[0], label: 'Fictional updated account' }], fingerprint);
      const ids = await modelDirty(control, owner);
      const duplicate = (await control.query('select alfred_write_accounting_state($1::uuid,$2,$3,$4,$5,$6::jsonb) as result', [owner, restored.revision, requestId, fingerprint, saved.version, JSON.stringify(saved.next)])).rows[0].result;
      assert.equal(duplicate.status, 'duplicate'); assert.deepEqual(await modelDirty(control, owner), ids);
      const conflict = (await control.query('select alfred_write_accounting_state($1::uuid,$2,$3,$4,$5,$6::jsonb) as result', [owner, restored.revision, requestId, 'e'.repeat(64), saved.version, JSON.stringify(saved.next)])).rows[0].result;
      assert.equal(conflict.status, 'conflict');
      const undo = await accountingWrite(saved.next, 'local:account-undo', 'undo', restored.accounts, 'f'.repeat(64));
      assert.deepEqual(undo.next.accounts, restored.accounts);
      assert.equal(undo.next.audit.at(-1).before.accounts[0].label, 'Fictional updated account');
      const events = (await control.query('select action,before_state,after_state from accounting_events where owner_id=$1::uuid order by revision', [owner])).rows;
      assert.deepEqual(events.map(entry => entry.action), ['import', 'undo_import', 'update_account', 'undo']);
      assert.deepEqual(events[1].before_state.movements, [movement]);
      report.actualFinancialPaths = { importConfirmation: true, importUndo: true, projectionDidNotChangeImportGuards: true, accountingWriteAndUndo: true, requestIdDuplicateAndConflict: true, fullEventStatesRetained: true };
    });

    await test('compact writer serializes concurrent expected revisions and preserves permanent request IDs', async () => {
      const owner = await createModelOwner(control), state = (await control.query('select state from accounting_states where owner_id=$1::uuid', [owner])).rows[0].state;
      const version = (await control.query('select alfred_accounting_source_version($1::uuid) as value', [owner])).rows[0].value;
      const first = compactAction(state, 'compact:concurrent-a', 'Fictional A'), second = compactAction(state, 'compact:concurrent-b', 'Fictional B');
      const a = await connect('alfred-compact-a'), b = await connect('alfred-compact-b');
      try {
        const results = await Promise.all([compactWrite(a, owner, first, version), compactWrite(b, owner, second, version)]);
        assert.deepEqual(results.map(result => result.status).sort(), ['saved', 'stale']);
        const winner = results[0].status === 'saved' ? first : second, response = results.find(result => result.status === 'saved');
        assert.deepEqual(response.state.audit[0].before, { accounts: [], movements: [], snapshots: [], transfers: [], settlements: [] });
        const stored = (await control.query('select state from accounting_states where owner_id=$1::uuid', [owner])).rows[0].state;
        assert.equal(stored.revision, 1); assert.deepEqual(stored.audit[0].before.accounts, state.accounts);
        const ids = await modelDirty(control, owner);
        assert.equal((await compactWrite(control, owner, winner, version)).status, 'duplicate');
        assert.equal((await compactWrite(control, owner, { ...winner, fingerprint: 'f'.repeat(64) }, version)).status, 'conflict');
        assert.deepEqual(await modelDirty(control, owner), ids);
        assert.equal((await control.query('select count(*)::int as count from accounting_events where owner_id=$1::uuid', [owner])).rows[0].count, 1);
      } finally { await a.end(); await b.end(); }
    });

    await test('compact history restoration, full Undo and source-change rejection leave durable evidence intact', async () => {
      const owner = await createModelOwner(control);
      const fullState = async () => (await control.query('select state from accounting_states where owner_id=$1::uuid', [owner])).rows[0].state;
      const version = async () => (await control.query('select alfred_accounting_source_version($1::uuid) as value', [owner])).rows[0].value;
      const initial = await fullState(), first = compactAction(initial, 'compact:history-one', 'Fictional first label');
      assert.equal((await compactWrite(control, owner, first, await version())).status, 'saved');
      const one = await fullState(), second = compactAction(one, 'compact:history-two', 'Fictional second label');
      const result = await compactWrite(control, owner, second, await version());
      assert.equal(result.status, 'saved'); assert.ok(result.state.audit.every(entry => entry.before.accounts.length === 0));
      const two = await fullState();
      assert.deepEqual(two.audit[0].before.accounts, initial.accounts);
      assert.deepEqual(two.audit[1].before.accounts, one.accounts);
      const tampered = compactAction(two, 'compact:tamper-history', 'Rejected label');
      tampered.next.audit[0].requestId = 'forged:history';
      await assert.rejects(compactWrite(control, owner, tampered, await version()), /audit metadata changed/);
      assert.deepEqual(await fullState(), two);
      const undo = compactAction(two, 'compact:real-undo', 'Undo to first label', 'undo', two.audit.at(-1).before.accounts);
      assert.equal((await compactWrite(control, owner, undo, await version())).status, 'saved');
      const restored = await fullState();
      assert.deepEqual(restored.accounts, one.accounts);
      assert.deepEqual(restored.audit.at(-1).before.accounts, two.accounts);
      const beforeSourceChange = await version(), stale = compactAction(restored, 'compact:source-stale', 'Must not save');
      await source(control, owner, 'source-before-compact-write');
      assert.equal((await compactWrite(control, owner, stale, beforeSourceChange)).status, 'source_changed');
      assert.deepEqual(await fullState(), restored);
      const events = (await control.query('select before_state,after_state from accounting_events where owner_id=$1::uuid order by revision', [owner])).rows;
      assert.equal(events.length, 3);
      assert.deepEqual(events[2].before_state.accounts, two.accounts);
      assert.deepEqual(events[2].after_state.audit[0].before.accounts, initial.accounts);
      report.compactFinancialPaths = { concurrentCAS: true, permanentRequestIds: true, compactAcknowledgementOnly: true, historicalBeforeRestoredFromDatabase: true, fullUndoAndEventsPreserved: true, metadataTamperRejected: true, sourceChangeRejected: true };
    });

    await test('cleanup removes orphan invalidations and auth deletion cascades private rows without clearing another owner', async () => {
      const removed = await modelSeed(control), retained = await modelSeed(control);
      await source(control, removed.owner, 'deleted-owner-source'); await source(control, retained.owner, 'retained-owner-source');
      const retainedIds = await modelDirty(control, retained.owner);
      await control.query('delete from auth.users where id=$1::uuid', [removed.owner]);
      assert.equal((await control.query('select count(*)::int as count from alfred_display.rows where owner_id=$1::uuid', [removed.owner])).rows[0].count, 0);
      assert.equal((await control.query('select count(*)::int as count from alfred_display.jobs where owner_id=$1::uuid', [removed.owner])).rows[0].count, 0);
      assert.ok((await modelDirty(control, removed.owner)).length > 0);
      await control.query('select alfred_display.cleanup(100)');
      assert.deepEqual(await modelDirty(control, removed.owner), []);
      assert.deepEqual(await modelDirty(control, retained.owner), retainedIds);
      const status = (await control.query('select alfred_display.status() as value')).rows[0].value;
      assert.equal(status.ready, true); assert.ok(status.modelOwners > 0);
      assert.equal(JSON.stringify(status).includes('retained-owner-source'), false);
      await control.query('begin;set local role anon');
      await assert.rejects(control.query('select alfred_display.manifest($1::uuid,$2)', [retained.owner, MODEL]), /permission denied/);
      await control.query('rollback');
    });

    await test('TRUNCATE invalidates every old epoch and an empty-table rebuild can recover', async () => {
      const { owner } = await modelSeed(control), oldEpoch = (await control.query('select epoch::text as value from alfred_display.clock')).rows[0].value;
      await control.query('truncate account_rule_states cascade');
      const newEpoch = (await control.query('select epoch::text as value from alfred_display.clock')).rows[0].value;
      assert.equal(BigInt(newEpoch), BigInt(oldEpoch) + BigInt(1));
      assert.equal(await modelRead(control, owner), null);
      const job = await claimOwner(control, owner), baseline = await modelCapture(control, job), model = await modelBuild(control, owner, 'after-truncate');
      assert.equal((await modelPublish(control, job, baseline, model)).status, 'saved');
      assert.deepEqual((await modelRead(control, owner)).rows, model.rows.map(row => row.payload));
    });

    assert.deepEqual(await financialAbi(control), abi);
    report.financialFunctionAbiUnchanged = true;
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    await cluster.stop();
    if (output) await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ status: report.status, passed: report.cases.length, migration: CANDIDATE, output: output ?? null, cluster: cluster.root }));
  }
  return report;
}
