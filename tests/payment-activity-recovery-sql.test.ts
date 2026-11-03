import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseSettings } from '@/lib/config';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/supabase/connection', () => ({ query: mocks.query }));
import { paymentActivityMention, recoverAllPaymentActivityMentions, recoverPaymentActivityMentions, type MentionCandidate } from '@/lib/bank/notices';

const settings = {} as SupabaseSettings;
const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
let db: PGlite, now: Date;

async function addOwner(id: string) {
  await db.query('insert into profiles values($1)', [id]);
  await db.query('insert into conversations(owner_id) values($1)', [id]);
  await db.query(`insert into notification_preferences(owner_id,payment_mentions,payment_mentions_since,outgoing_mentions,outgoing_mentions_since)
    values($1,true,now()-interval '2 hours',true,now()-interval '2 hours')`, [id]);
}
async function addAlert(index: number, direction: 'in'|'out', kind: 'payment'|'card_hold'|'hold_settle', who = owner) {
  const id = `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`;
  const at = new Date(now.getTime() - 60 * 60_000 + index * 1_000);
  await db.query(`insert into bank_messages(id,owner_id,channel,direction,kind,status,amount,created_at,occurred_at)
    values($1,$2,'mac',$3,$4,'needs_label',30,$5,$5)`, [id, who, direction, kind, at]);
  return { id, ownerId: who, channel: 'mac', direction, kind, status: 'needs_label', amount: '30.00', fee: '0.00',
    currency: 'GHS', counterparty: 'Fictional provider', occurredAt: at.toISOString(), createdAt: at.toISOString(),
    readBy: 'rules', transactionId: null, feeTransactionId: null, purpose: null } satisfies MentionCandidate;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create function auth.uid() returns uuid language sql as $$select null::uuid$$;
    create table profiles(id uuid primary key);
    create table conversations(id uuid primary key default gen_random_uuid(),owner_id uuid unique references profiles(id));
    create table messages(id uuid primary key default gen_random_uuid(),conversation_id uuid,owner_id uuid,channel text,role text,body text,client_id text,intent text,meta jsonb);
    create unique index msg_client on messages(owner_id,client_id,role) where client_id is not null;
    create table bank_messages(id uuid primary key,owner_id uuid,channel text,
      direction text check(direction in ('in','out')),
      kind text check(kind in ('payment','transfer_own','loan_in','unknown','loan_out','loan_repay','card_hold','hold_settle')),
      status text,amount numeric(12,2),fee numeric(12,2) default 0,currency text default 'GHS',
      counterparty text default 'Fictional provider',read_by text default 'rules',transaction_id uuid,fee_transaction_id uuid,
      created_at timestamptz default now(),occurred_at timestamptz default now());
    create table transactions(owner_id uuid,transaction_id uuid,category text,description text,status text,type text,amount numeric(12,2),currency text);`);
  for (const name of ['20261103110000_notifications.sql', '20261103113000_bank_notice_receipts.sql', '20261103233000_payment_activity_notices.sql']) {
    await db.exec(await readFile(new URL('../supabase/migrations/' + name, import.meta.url), 'utf8'));
  }
});
beforeEach(async () => {
  await db.exec('truncate profiles,conversations,messages,bank_messages,transactions,notification_preferences,bank_notice_receipts cascade');
  now = (await db.query<{ value: Date }>('select now() value')).rows[0].value;
  mocks.query.mockReset();
  // Execute the real recovery, preference and atomic writer SQL in memory.
  mocks.query.mockImplementation(async (_settings, sql: string, values: unknown[] = []) => (await db.query(sql, values)).rows);
});
afterAll(async () => { await db.close(); });

describe('payment activity recovery uses the writer eligibility boundary', () => {
  it('recovers newer money in and out despite ten older unsupported incoming holds and settlements', async () => {
    await addOwner(owner);
    for (let i = 1; i <= 10; i++) await addAlert(i, 'in', i % 2 ? 'card_hold' : 'hold_settle');
    const incoming = await addAlert(11, 'in', 'payment'), outgoing = await addAlert(12, 'out', 'payment');
    const before = (await db.query('select * from bank_messages order by id')).rows;
    expect(await recoverPaymentActivityMentions(settings, owner, now)).toBe(2);
    expect((await db.query<{ bank_message_id: string }>('select bank_message_id::text from bank_notice_receipts order by bank_message_id')).rows.map(r => r.bank_message_id)).toEqual([incoming.id, outgoing.id]);
    expect((await db.query<{ intent: string }>('select intent from messages order by intent')).rows.map(r => r.intent)).toEqual(['automation:incoming-payment', 'automation:outgoing-payment']);
    expect(await recoverPaymentActivityMentions(settings, owner, now)).toBe(0);
    expect((await db.query('select * from bank_messages order by id')).rows).toEqual(before);
    expect((await db.query('select * from transactions')).rows).toHaveLength(0);
  });

  it('does not spend the ten-owner recovery batch on owners with only unsupported incoming holds', async () => {
    for (let i = 1; i <= 10; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      await addOwner(id); await addAlert(i, 'in', i % 2 ? 'card_hold' : 'hold_settle', id);
    }
    await addOwner(owner); const valid = await addAlert(11, 'out', 'payment');
    expect(await recoverAllPaymentActivityMentions(settings, now)).toBe(1);
    const candidateQueries = mocks.query.mock.calls.filter(([, sql]) => String(sql).includes('where b.owner_id=$1::uuid'));
    expect(candidateQueries).toHaveLength(1);
    expect(candidateQueries[0][2][0]).toBe(owner);
    expect((await db.query<{ bank_message_id: string }>('select bank_message_id::text from bank_notice_receipts')).rows).toEqual([{ bank_message_id: valid.id }]);
  });

  it.each([['in', 'card_hold'], ['in', 'hold_settle'], ['out', 'card_hold'], ['out', 'hold_settle']] as const)(
    'agrees with the copy generator and atomic writer for %s/%s', async (direction, kind) => {
      await addOwner(owner); const alert = await addAlert(1, direction, kind);
      const mention = paymentActivityMention(alert);
      expect(Boolean(mention)).toBe(direction === 'out');
      const source = { direction, kind, amount: alert.amount, fee: alert.fee, currency: alert.currency,
        counterparty: alert.counterparty, readBy: alert.readBy, feeTransactionId: null,
        principalType: null, principalAmount: null, principalCurrency: null };
      const result = await db.query<{ written: boolean }>(
        'select alfred_record_bank_activity_notice($1::uuid,$2::uuid,$3,$4,false,$5,null::uuid,$6,null::jsonb,$7::jsonb) written',
        [owner, alert.id, 'bank_notice_' + createHash('sha256').update(owner + '\0' + alert.id).digest('hex'),
          mention?.body ?? 'Synthetic unsupported incoming hold', alert.status, kind === 'card_hold', JSON.stringify(source)]);
      expect(result.rows[0].written).toBe(direction === 'out');
      expect(await recoverPaymentActivityMentions(settings, owner, now)).toBe(0);
      expect((await db.query('select * from bank_notice_receipts')).rows).toHaveLength(direction === 'out' ? 1 : 0);
    },
  );
});
