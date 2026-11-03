import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseSettings, UserProfile } from '@/lib/config';
import { ingestBankText } from '@/lib/bank/ingest';
import { MemoryBankStore, type BankMessage } from '@/lib/bank/store';
import { MemoryFinanceStore } from '@/lib/finance/memory-store';
import { sourceMovements } from '@/lib/finance/accounting/sources';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/supabase/connection', () => ({ query: mocks.query }));
import { recoverPaymentActivityMentions } from '@/lib/bank/notices';

const settings = {} as SupabaseSettings;
const owner: UserProfile = { profileId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', telegramUserId: null,
  spreadsheetId: '', currency: 'GHS', timezone: 'Africa/Accra', preferredName: 'Fictional', communicationPreference: 'concise' };
const hubtelOut = 'GHS 1.00 was withdrawn from your Hubtel wallet. Available balance: GHS 99.00. Transaction ID: 88123456.';
const hubtelIn = 'GHS 1.00 was deposited into your Hubtel wallet. Available balance: GHS 100.00. Transaction ID: 88123457.';
const momoIn = 'Payment received for GHS 1.00 from FICTIONAL OWNER Current Balance: GHS 100.00 . Available Balance: GHS 100.00. Reference: transfer. Transaction ID: 92300000001. TRANSACTION FEE: 0.00';
const momoOut = 'Payment made for GHS 1.00 to FICTIONAL OWNER Current Balance: GHS 99.00 . Available Balance: GHS 99.00. Reference: transfer. Transaction ID: 92300000002. Fee charged: GHS0.00 Tax charged: 0.';
let db: PGlite, now: Date;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create schema auth;
    create function auth.uid() returns uuid language sql as $$select null::uuid$$;
    create table profiles(id uuid primary key);
    create table conversations(id uuid primary key default gen_random_uuid(),owner_id uuid unique references profiles(id));
    create table messages(id uuid primary key default gen_random_uuid(),conversation_id uuid,owner_id uuid,channel text,role text,body text,client_id text,intent text,meta jsonb);
    create unique index msg_client on messages(owner_id,client_id,role) where client_id is not null;
    create table bank_messages(id uuid primary key,owner_id uuid,channel text,direction text,kind text,status text,
      amount numeric(12,2),fee numeric(12,2) default 0,currency text,counterparty text,read_by text,transaction_id uuid,fee_transaction_id uuid,
      created_at timestamptz,occurred_at timestamptz);
    create table transactions(owner_id uuid,transaction_id uuid,category text,description text,status text,type text,amount numeric(12,2),currency text,source_update_id text);`);
  for (const name of ['20261103110000_notifications.sql', '20261103113000_bank_notice_receipts.sql', '20261103233000_payment_activity_notices.sql', '20261103235000_fee_notice_readiness.sql']) {
    await db.exec(await readFile(new URL('../supabase/migrations/' + name, import.meta.url), 'utf8'));
  }
});
beforeEach(async () => {
  await db.exec('truncate profiles,conversations,messages,bank_messages,transactions,notification_preferences,bank_notice_receipts cascade');
  now = (await db.query<{ value: Date }>('select now() value')).rows[0].value;
  await db.query('insert into profiles values($1)', [owner.profileId]);
  await db.query('insert into conversations(owner_id) values($1)', [owner.profileId]);
  await db.query(`insert into notification_preferences(owner_id,payment_mentions,payment_mentions_since,outgoing_mentions,outgoing_mentions_since)
    values($1,true,now()-interval '1 hour',true,now()-interval '1 hour')`, [owner.profileId]);
  mocks.query.mockReset();
  mocks.query.mockImplementation(async (_settings, sql: string, values: unknown[] = []) => (await db.query(sql, values)).rows);
});
afterAll(async () => { await db.close(); });

async function persistSource(message: BankMessage) {
  await db.query(`insert into bank_messages(id,owner_id,channel,direction,kind,status,amount,fee,currency,counterparty,read_by,transaction_id,fee_transaction_id,created_at,occurred_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
  [message.id, message.ownerId, message.channel, message.direction, message.kind, message.status, message.amount, message.fee,
    message.currency, message.counterparty, message.readBy, message.transactionId, message.feeTransactionId, now, message.occurredAt]);
}

describe('small payment ingestion through accounting review and durable chat announcements', () => {
  it.each([
    ['Hubtel to Mobile Money', hubtelOut, momoIn],
    ['Mobile Money to Hubtel', momoOut, hubtelIn],
  ])('keeps the GHS1 %s sides for review and announces each once without guessing an account or transfer', async (_label, outgoing, incoming) => {
    const bank = new MemoryBankStore(), ledger = new MemoryFinanceStore();
    const deps = { bank, ledger, now, createId: () => '22222222-2222-4222-8222-222222222222' };
    for (const text of [outgoing, incoming]) {
      const result = await ingestBankText(deps, owner, text, { channel: 'mac', receivedAt: now });
      expect(result).toMatchObject({ found: 1, duplicates: 0 });
      expect(result.outcomes[0].message).toMatchObject({ kind: 'payment', status: 'needs_label', amount: '1.00' });
      await persistSource(result.outcomes[0].message);
    }
    const movements = sourceMovements(owner.profileId, await ledger.listTransactions(owner.profileId), bank.messages);
    expect(movements.map(row => ({ direction: row.direction, status: row.status, accountId: row.accountId })))
      .toEqual([{ direction: 'out', status: 'review', accountId: null }, { direction: 'in', status: 'review', accountId: null }]);
    expect(await ledger.listTransactions(owner.profileId)).toHaveLength(0);
    expect(await recoverPaymentActivityMentions(settings, owner.profileId, now)).toBe(2);
    const notices = (await db.query<{ intent: string; body: string; meta: { paymentNotice: { requiresPurpose: boolean } } }>('select intent,body,meta from messages order by intent')).rows;
    expect(notices.map(row => row.intent)).toEqual(['automation:incoming-payment', 'automation:outgoing-payment']);
    expect(notices.every(row => row.meta.paymentNotice.requiresPurpose)).toBe(true);
    expect(notices.every(row => row.body.includes('What was this for?'))).toBe(true);
    for (const text of [outgoing, incoming]) expect(await ingestBankText(deps, owner, text, { channel: 'mac', receivedAt: now })).toMatchObject({ duplicates: 1, outcomes: [] });
    expect(await recoverPaymentActivityMentions(settings, owner.profileId, now)).toBe(0);
    expect(bank.messages).toHaveLength(2);
    expect((await db.query('select * from bank_notice_receipts')).rows).toHaveLength(2);
    expect((await db.query('select * from messages')).rows).toHaveLength(2);
  });

  it('preserves a positively recognized own-transfer classification and announces it without recording income or spending', async () => {
    const bank = new MemoryBankStore(), ledger = new MemoryFinanceStore(); bank.names = ['FICTIONAL OWNER'];
    const deps = { bank, ledger, now, createId: () => '22222222-2222-4222-8222-222222222222' };
    for (const text of [momoOut, momoIn]) {
      const result = await ingestBankText(deps, owner, text, { channel: 'mac', receivedAt: now });
      expect(result.outcomes[0].message).toMatchObject({ kind: 'transfer_own', status: 'transfer', amount: '1.00' });
      await persistSource(result.outcomes[0].message);
    }
    expect(await ledger.listTransactions(owner.profileId)).toHaveLength(0);
    expect(sourceMovements(owner.profileId, [], bank.messages).every(row => row.status === 'transfer' && row.accountId === null)).toBe(true);
    expect(await recoverPaymentActivityMentions(settings, owner.profileId, now)).toBe(2);
    const notices = (await db.query<{ body: string; meta: { ledgerChanged: boolean; paymentNotice: { requiresPurpose: boolean } } }>('select body,meta from messages')).rows;
    expect(notices.every(row => row.body.includes('between your own accounts, rather than spending or income'))).toBe(true);
    expect(notices.every(row => row.meta.ledgerChanged && !row.meta.paymentNotice.requiresPurpose)).toBe(true);
    expect((await db.query('select * from transactions')).rows).toHaveLength(0);
  });

  it('does not reclassify or announce a previously skipped alert when the collector retries it', async () => {
    const bank = new MemoryBankStore(), ledger = new MemoryFinanceStore();
    const deps = { bank, ledger, now, createId: () => '22222222-2222-4222-8222-222222222222' };
    const first = await ingestBankText(deps, owner, hubtelOut, { channel: 'mac', receivedAt: now });
    // Represent a durable record excluded before this application update.
    await bank.updateMessage(owner.profileId, first.outcomes[0].message.id, { status: 'skipped' });
    await persistSource(bank.messages[0]);
    expect(await ingestBankText(deps, owner, hubtelOut, { channel: 'mac', receivedAt: now })).toMatchObject({ duplicates: 1, outcomes: [] });
    expect(bank.messages[0].status).toBe('skipped');
    expect(await recoverPaymentActivityMentions(settings, owner.profileId, now)).toBe(0);
    expect((await db.query('select * from bank_notice_receipts')).rows).toHaveLength(0);
    expect((await db.query('select * from messages')).rows).toHaveLength(0);
    expect(await ledger.listTransactions(owner.profileId)).toHaveLength(0);
  });
});
