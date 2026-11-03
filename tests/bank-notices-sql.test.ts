import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import type {StoredPaymentPurpose} from '@/lib/bank/purpose';
const a='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',b='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',event='11111111-1111-4111-8111-111111111111',txn='22222222-2222-4222-8222-222222222222',fee='33333333-3333-4333-8333-333333333333';
let db:PGlite;
const purpose=(patch:Partial<StoredPaymentPurpose>={}):StoredPaymentPurpose=>({ownerId:a,transactionId:txn,category:'Salary',description:'November salary',recordStatus:'active',...patch});
type Draft={owner?:string;id?:string;status?:string;transaction?:string|null;requiresPurpose?:boolean;purpose?:StoredPaymentPurpose|null;financialWrite?:boolean};
async function save(draft:Draft={}){
 const owner=draft.owner??a,id=draft.id??event,key='bank_notice_'+createHash('sha256').update(owner+'\0'+id).digest('hex');
 const transaction=draft.transaction===undefined?txn:draft.transaction;
 const expected=draft.purpose===undefined?purpose():draft.purpose;
 return (await db.query<{written:boolean}>('select public.alfred_record_bank_notice($1::uuid,$2::uuid,$3,$4,$5,$6,$7::uuid,$8::boolean,$9::jsonb) as written',
  [owner,id,key,'Synthetic private incoming alert',draft.financialWrite??true,draft.status??'recorded',transaction,draft.requiresPurpose??false,expected===null?null:JSON.stringify(expected)])).rows[0].written;
}
beforeEach(async()=>{
 db=new PGlite();await db.exec(`create role anon;create role authenticated;create schema auth;create function auth.uid() returns uuid language sql as $$select null::uuid$$;
 create table profiles(id uuid primary key);create table conversations(id uuid primary key default gen_random_uuid(),owner_id uuid unique references profiles(id));
 create table messages(id uuid primary key default gen_random_uuid(),conversation_id uuid,owner_id uuid,channel text,role text,body text,client_id text,intent text,meta jsonb);
 create unique index msg_client on messages(owner_id,client_id,role) where client_id is not null;
 create table bank_messages(id uuid primary key,owner_id uuid,channel text,direction text,kind text,status text,amount numeric,transaction_id uuid,fee_transaction_id uuid,asked_at timestamptz,created_at timestamptz default now(),occurred_at timestamptz default now());
 create table transactions(owner_id uuid not null references profiles(id),transaction_id uuid not null,category text not null,description text not null,status text not null,type text not null,amount numeric not null,primary key(owner_id,transaction_id));
 insert into profiles values('${a}'),('${b}');insert into conversations(owner_id) values('${a}'),('${b}');
 `);
 await db.exec(readFileSync('supabase/migrations/20261103110000_notifications.sql','utf8'));
 await db.exec(readFileSync('supabase/migrations/20261103113000_bank_notice_receipts.sql','utf8'));
 await db.query(`insert into notification_preferences(owner_id,payment_mentions,payment_mentions_since) values($1,true,now()-interval '1 hour'),($2,true,now()-interval '1 hour')`,[a,b]);
 await db.query(`insert into bank_messages(id,owner_id,channel,direction,kind,status,amount,transaction_id) values($1,$2,'mac','in','payment','recorded',250,$3)`,[event,a,txn]);
 await db.query(`insert into transactions values($1,$2,'Salary','November salary','active','income',250)`,[a,txn]);
});
afterEach(async()=>{await db.close();});
describe('atomic purpose-aware private payment notices',()=>{
 it('uses the nine-argument draft contract and writes one owned message/receipt',async()=>{
  expect(await save()).toBe(true);expect(await save()).toBe(false);
  const messages=(await db.query<{owner_id:string;intent:string;meta:unknown}>('select * from messages')).rows;
  expect(messages).toHaveLength(1);expect(messages[0]).toMatchObject({owner_id:a,intent:'automation:incoming-payment',meta:{ledgerChanged:true,paymentNotice:{bankMessageId:event,requiresPurpose:false}}});
  expect((await db.query('select * from bank_notice_receipts')).rows).toHaveLength(1);
 });
 it('keeps its receipt after Clear conversation instead of replaying a historical notice',async()=>{
  await save();await db.exec('delete from messages');expect(await save()).toBe(false);
  expect((await db.query('select * from messages')).rows).toHaveLength(0);expect((await db.query('select * from bank_notice_receipts')).rows).toHaveLength(1);
 });
 it('binds a purpose question to the exact owned bank event without touching financial records',async()=>{
  await db.query('update bank_messages set status=$1,transaction_id=null where id=$2',['needs_label',event]);
  const before=(await db.query('select * from transactions order by owner_id,transaction_id')).rows;
  expect(await save({status:'needs_label',transaction:null,requiresPurpose:true,purpose:null,financialWrite:false})).toBe(true);
  const message=(await db.query<{meta:unknown}>('select meta from messages')).rows[0];
  expect(message.meta).toEqual({ledgerChanged:false,paymentNotice:{bankMessageId:event,requiresPurpose:true}});
  expect((await db.query('select * from transactions order by owner_id,transaction_id')).rows).toEqual(before);
  expect((await db.query<{status:string;asked_at:unknown}>('select status,asked_at from bank_messages where id=$1',[event])).rows[0]).toEqual({status:'needs_label',asked_at:null});
 });
 it('performs no ledger insert, update or deletion while acknowledging a known purpose',async()=>{
  const before=(await db.query('select * from transactions order by owner_id,transaction_id')).rows;
  expect(await save()).toBe(true);
  expect((await db.query('select * from transactions order by owner_id,transaction_id')).rows).toEqual(before);
 });
 it('prevents cross-owner messages and stale classification drafts',async()=>{
  expect(await save({owner:b})).toBe(false);
  expect(await save({status:'needs_label',transaction:null,requiresPurpose:true,purpose:null})).toBe(false);
  expect(await save({transaction:fee})).toBe(false);
  expect((await db.query('select * from messages')).rows).toHaveLength(0);expect((await db.query('select * from bank_notice_receipts')).rows).toHaveLength(0);
 });
 it('rechecks the owned active principal purpose at commit and permits a fresh retry after an edit',async()=>{
  await db.query('update transactions set description=$1 where owner_id=$2 and transaction_id=$3',['Revised salary description',a,txn]);
  expect(await save()).toBe(false);
  expect((await db.query('select * from messages')).rows).toHaveLength(0);expect((await db.query('select * from bank_notice_receipts')).rows).toHaveLength(0);
  expect(await save({purpose:purpose({description:'Revised salary description'})})).toBe(true);
  expect(await save({purpose:purpose({description:'Revised salary description'})})).toBe(false);
 });
 it('rejects a purpose that became void and leaves the notice eligible for later valid retry',async()=>{
  await db.query('update transactions set status=$1 where owner_id=$2 and transaction_id=$3',['void',a,txn]);
  expect(await save()).toBe(false);expect((await db.query('select * from bank_notice_receipts')).rows).toHaveLength(0);
  await db.query('update transactions set status=$1 where owner_id=$2 and transaction_id=$3',['active',a,txn]);
  expect(await save()).toBe(true);
 });
 it('never borrows another owner’s purpose or a fee transaction’s classification',async()=>{
  expect(await save({purpose:purpose({ownerId:b})})).toBe(false);
  await db.query(`insert into transactions values($1,$2,'Fees','Provider fee','active','expense',1)`,[a,fee]);
  await db.query('update bank_messages set fee_transaction_id=$1 where id=$2',[fee,event]);
  expect(await save({purpose:purpose({transactionId:fee,category:'Fees',description:'Provider fee'})})).toBe(false);
  await db.query('update transactions set owner_id=$1 where owner_id=$2 and transaction_id=$3',[b,a,txn]);
  expect(await save({purpose:purpose({ownerId:b})})).toBe(false);
  expect((await db.query('select * from messages')).rows).toHaveLength(0);expect((await db.query('select * from bank_notice_receipts')).rows).toHaveLength(0);
 });
 it('rejects the question flag for an already-settled record',async()=>{
  expect(await save({requiresPurpose:true})).toBe(false);expect((await db.query('select * from messages')).rows).toHaveLength(0);
 });
 it('rechecks mute and activation date at the atomic boundary',async()=>{
  await db.query('update notification_preferences set payment_mentions=false where owner_id=$1',[a]);expect(await save()).toBe(false);
  await db.query('update notification_preferences set payment_mentions=true,payment_mentions_since=now() where owner_id=$1',[a]);
  await db.exec(`update bank_messages set occurred_at=now()-interval '1 minute'`);expect(await save()).toBe(false);
 });
 it('leaves no receipt after a failed draft and recovers once the conversation exists',async()=>{
  await db.exec('delete from conversations');expect(await save()).toBe(false);
  expect((await db.query('select * from bank_notice_receipts')).rows).toHaveLength(0);
  await db.query('insert into conversations(owner_id) values($1)',[a]);expect(await save()).toBe(true);
 });
});
