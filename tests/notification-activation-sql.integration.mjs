// Pure in-memory database rehearsal. Never loads .env or opens a network connection.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const directory = new URL('../supabase/migrations/', import.meta.url);
const expected = [
  '20261103110000_notifications.sql',
  '20261103113000_bank_notice_receipts.sql',
  '20261103150000_collector_event_receipts.sql',
  '20261103200000_notification_recovery.sql',
  '20261103210000_collector_health.sql',
  '20261103220000_immediate_payment_nudges.sql',
  '20261103230000_collector_health_removal.sql',
];
const all = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
assert.deepEqual(all.filter(name => name.startsWith('20261103')), expected, 'Review the activation batch when migrations change');
const db = new PGlite();
let assertions = 1;
const check = (value, wanted, message) => { assert.deepEqual(value, wanted, message); assertions++; };
const rows = async (text, values = []) => (await db.query(text, values)).rows;
const scalar = async (text, values = []) => (await rows(text, values))[0].value;
const tables = ['notification_preferences', 'push_subscriptions', 'notification_deliveries', 'bank_notice_receipts', 'collector_event_receipts', 'notification_recovery_health', 'collector_health'];
try {
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;
    create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}'::jsonb);`);
  for (const name of all.filter(name => name < expected[0])) {
    await db.exec(await readFile(new URL(name, directory), 'utf8'));
    await db.query('insert into alfred_schema_migrations(filename) values($1)', [name]);
  }
  const statements = await Promise.all(expected.map(async name =>
    `${await readFile(new URL(name, directory), 'utf8')}\ninsert into public.alfred_schema_migrations(filename) values('${name}');`));
  // Rehearse an interrupted batch after every draft has run. Schema and ledger
  // must roll back together; no finance records or private notification data exist.
  await assert.rejects(db.exec(`begin; ${statements.join('\n')} select 1/0; commit;`), /division by zero/);
  assertions++;
  await db.exec('rollback');
  for (const name of tables) check(await scalar('select to_regclass($1) as value', [`public.${name}`]), null, `${name} rolled back`);
  check(await scalar("select count(*)::int as value from alfred_schema_migrations where filename like '20261103%'"), 0, 'Activation ledger rolled back');
  await db.exec(`begin; ${statements.join('\n')} commit;`);
  check((await rows("select filename from alfred_schema_migrations where filename like '20261103%' order by filename")).map(row => row.filename), expected, 'Exactly the reviewed seven drafts committed');
  const applied = new Set((await rows('select filename from alfred_schema_migrations')).map(row => row.filename));
  check(expected.filter(name => !applied.has(name)), [], 'A repeated deployment skips all seven recorded migrations');
  for (const name of tables) {
    check(await scalar('select relrowsecurity as value from pg_class where oid=to_regclass($1)', [`public.${name}`]), true, `${name} has RLS`);
    check(await scalar(`select count(*)::int as value from public.${name}`), 0, `${name} starts without subscriptions, preferences or work`);
  }
  const owner = '00000000-0000-4000-8000-000000000001';
  await db.query('insert into auth.users(id) values($1::uuid)', [owner]);
  await db.query('insert into profiles(id) values($1::uuid) on conflict do nothing', [owner]);
  await db.query('insert into notification_preferences(owner_id) values($1::uuid)', [owner]);
  check((await rows('select payment_mentions,payment_push,bill_reminders,weekly_overview from notification_preferences'))[0],
    {payment_mentions:false,payment_push:false,bill_reminders:false,weekly_overview:false}, 'Every preference remains off');
  for (const name of ['push_subscriptions', 'notification_deliveries', 'collector_event_receipts', 'collector_health', 'notification_recovery_health'])
    check(await scalar('select has_table_privilege($1,$2,$3) as value', ['authenticated', `public.${name}`, 'SELECT']), false, `${name} is unavailable to client role`);
  check(await scalar('select count(*)::int as value from transactions'), 0, 'Activation creates no financial transaction');
  check(await scalar('select count(*)::int as value from bank_messages'), 0, 'Activation creates no source alert');
  check(await scalar('select count(*)::int as value from messages'), 0, 'Activation posts no message');
  const preflight = (await db.exec(await readFile(new URL('../docs/automation-activation-preflight.sql', import.meta.url), 'utf8'))).flatMap(result => result.rows);
  const functions = preflight.filter(row => typeof row.signature === 'string');
  check(functions.length, 7, 'Read-only preflight covers every reviewed function signature');
  check(functions.every(row => row.present === true), true, 'Preflight signatures match the actual migration functions');
  const catalogTables = preflight.filter(row => typeof row.name === 'string');
  check(catalogTables.length, 7, 'Read-only preflight covers all new operational tables');
  check(catalogTables.every(row => row.present === true && row.row_security === true), true, 'Preflight table names and RLS match actual migration objects');
  // Raw migration files are deliberately not a rerun mechanism. The applied
  // ledger, not CREATE TABLE IF NOT EXISTS, must govern repeat deployments.
  await assert.rejects(db.exec(await readFile(new URL(expected[0], directory), 'utf8')), /already exists/);
  assertions++;
  console.log(`Notification activation rehearsal: ${assertions} assertions passed; in-memory only, no credentials or external requests.`);
} finally {
  await db.close();
}
