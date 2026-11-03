import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll,beforeEach,afterAll,describe,it,expect } from 'vitest';
let db:PGlite;
const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',other='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',event='11111111-1111-4111-8111-111111111111',txn='22222222-2222-4222-8222-222222222222';
async function source(){return(await db.query<{value:Record<string,unknown>}>(`select jsonb_build_object('direction',b.direction,'kind',b.kind,'amount',b.amount::text,'fee',b.fee::text,'currency',b.currency,'counterparty',b.counterparty,'readBy',b.read_by,'feeTransactionId',b.fee_transaction_id::text,'principalType',t.type,'principalAmount',t.amount::text,'principalCurrency',t.currency) value from bank_messages b left join transactions t on t.owner_id=b.owner_id and t.transaction_id=b.transaction_id and t.status='active' where b.id=$1`,[event])).rows[0].value;}
async function save(patch:{owner?:string;source?:Record<string,unknown>;purpose?:unknown;status?:string;transaction?:string|null;requires?:boolean;financialWrite?:boolean}={}){const who=patch.owner??owner;const actual=(await db.query<{value:boolean}>("select (fee_transaction_id is not null or (status='recorded' and transaction_id is not null) or status in ('transfer','lent','borrowed','repaid','paid_back','invested')) value from bank_messages where id=$1",[event])).rows[0].value;return(await db.query<{value:boolean}>('select alfred_record_bank_activity_notice($1::uuid,$2::uuid,$3,$4,$5,$6,$7::uuid,$8,$9::jsonb,$10::jsonb) value',[who,event,'bank_notice_'+createHash('sha256').update(who+'\0'+event).digest('hex'),'Synthetic private payment alert',patch.financialWrite??actual,patch.status??'needs_label',patch.transaction??null,patch.requires??true,patch.purpose??null,JSON.stringify(patch.source??await source())])).rows[0].value;}
beforeAll(async()=>{db=new PGlite();await db.exec(`create role anon;create role authenticated;create schema auth;create function auth.uid() returns uuid language sql as $$select null::uuid$$;
create table profiles(id uuid primary key);create table conversations(id uuid primary key default gen_random_uuid(),owner_id uuid unique references profiles(id));
create table messages(id uuid primary key default gen_random_uuid(),conversation_id uuid,owner_id uuid,channel text,role text,body text,client_id text,intent text,meta jsonb);create unique index msg_client on messages(owner_id,client_id,role) where client_id is not null;
create table bank_messages(id uuid primary key,owner_id uuid,channel text,direction text,kind text,status text,amount numeric(12,2),fee numeric(12,2) default 0,currency text default 'GHS',counterparty text default 'Synthetic shop',read_by text default 'rules',transaction_id uuid,fee_transaction_id uuid,created_at timestamptz default now(),occurred_at timestamptz default now());
create table transactions(owner_id uuid,transaction_id uuid,category text,description text,status text,type text,amount numeric(12,2),currency text default 'GHS',source_update_id text);`);
for(const name of ['20261103110000_notifications.sql','20261103113000_bank_notice_receipts.sql','20261103233000_payment_activity_notices.sql','20261103235000_fee_notice_readiness.sql'])await db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));});
beforeEach(async()=>{await db.exec('truncate profiles,conversations,messages,bank_messages,transactions,notification_preferences,bank_notice_receipts cascade');await db.query('insert into profiles values($1),($2)',[owner,other]);await db.query('insert into conversations(owner_id) values($1),($2)',[owner,other]);await db.query("insert into notification_preferences(owner_id,payment_mentions,payment_mentions_since,outgoing_mentions,outgoing_mentions_since) values($1,true,now()-interval '1 hour',false,null)",[owner]);await db.query("insert into bank_messages(id,owner_id,channel,direction,kind,status,amount) values($1,$2,'mac','out','payment','needs_label',30)",[event,owner]);});
afterAll(async()=>{await db.close();});
describe('atomic direction-specific notice receipts',()=>{
 it('leaves existing incoming consent unchanged and requires a separate outgoing opt-in',async()=>{expect(await save()).toBe(false);await db.query("update notification_preferences set outgoing_mentions=true,outgoing_mentions_since=now()-interval '1 hour' where owner_id=$1",[owner]);expect(await save()).toBe(true);expect(await save()).toBe(false);expect((await db.query<{intent:string}>('select intent from messages')).rows[0].intent).toBe('automation:outgoing-payment');await db.exec('delete from messages');expect(await save()).toBe(false);expect((await db.query('select * from bank_notice_receipts')).rows).toHaveLength(1);});
 it('rechecks owner, activation fence, source direction/classification and mute at commit',async()=>{
  await db.query("update notification_preferences set outgoing_mentions=true,outgoing_mentions_since=now()-interval '1 hour'");const original=await source();expect(await save({owner:other})).toBe(false);expect(await save({source:{...original,direction:'in'}})).toBe(false);expect(await save({source:{...original,kind:'unknown'}})).toBe(false);
  await db.exec("update notification_preferences set outgoing_mentions=false");expect(await save()).toBe(false);await db.exec("update notification_preferences set outgoing_mentions=true,outgoing_mentions_since=now()+interval '1 minute'");expect(await save()).toBe(false);expect((await db.query('select * from messages')).rows).toHaveLength(0);
 });
 it('binds refund evidence to the exact active owned principal and makes no financial writes',async()=>{
  await db.query("insert into transactions(owner_id,transaction_id,category,description,status,type,amount) values($1,$2,'Food','Refund · Lunch','active','expense',-30)",[owner,txn]);await db.query("update bank_messages set direction='in',status='recorded',transaction_id=$1",[txn]);const purpose={ownerId:owner,transactionId:txn,category:'Food',description:'Refund · Lunch',recordStatus:'active'};const original=await source();const before=(await db.query('select * from transactions')).rows;
  expect(await save({status:'recorded',transaction:txn,requires:false,purpose,source:{...original,principalAmount:'30.00'}})).toBe(false);expect(await save({status:'recorded',transaction:txn,requires:false,purpose})).toBe(true);expect((await db.query('select * from transactions')).rows).toEqual(before);
 });
 it('keeps the published incoming v1 function and server-only v2 privileges',async()=>{expect((await db.query<{value:boolean}>("select to_regprocedure('public.alfred_record_bank_notice(uuid,uuid,text,text,boolean,text,uuid,boolean,jsonb)') is not null value")).rows[0].value).toBe(true);expect((await db.query<{value:boolean}>("select has_function_privilege('authenticated','public.alfred_record_bank_activity_notice(uuid,uuid,text,text,boolean,text,uuid,boolean,jsonb,jsonb)','execute') value")).rows[0].value).toBe(false);});
 it('shares durable receipts with the legacy incoming writer',async()=>{
  await db.exec("update bank_messages set direction='in'");
  const key='bank_notice_'+createHash('sha256').update(owner+'\0'+event).digest('hex');
  expect((await db.query<{value:boolean}>('select alfred_record_bank_notice($1::uuid,$2::uuid,$3,$4,false,$5,null::uuid,true,null::jsonb) value',[owner,event,key,'Synthetic legacy incoming alert','needs_label'])).rows[0].value).toBe(true);
  expect(await save()).toBe(false);expect((await db.query('select * from messages')).rows).toHaveLength(1);
 });
 it.each([['out','transfer_own','transfer'],['in','loan_repay','repaid'],['out','hold_settle','needs_label']] as const)('writes only a notice for recognized %s/%s/%s',(async(direction,kind,status)=>{
  await db.exec("update notification_preferences set outgoing_mentions=true,outgoing_mentions_since=now()-interval '1 hour'");await db.query('update bank_messages set direction=$1,kind=$2,status=$3',[direction,kind,status]);
  const refresh=status!=='needs_label';expect(await save({status,requires:false,financialWrite:!refresh})).toBe(false);
  expect(await save({status,requires:false})).toBe(true);expect((await db.query('select * from transactions')).rows).toEqual([]);expect((await db.query<{meta:{ledgerChanged:boolean;paymentNotice:{requiresPurpose:boolean}}}>('select meta from messages')).rows[0].meta).toMatchObject({ledgerChanged:refresh,paymentNotice:{requiresPurpose:false}});
 }));
 it('rejects stale classification then accepts a refreshed retry without changing the financial record',async()=>{
  await db.query("insert into transactions(owner_id,transaction_id,category,description,status,type,amount) values($1,$2,'Food','Lunch','active','expense',30)",[owner,txn]);await db.query("update bank_messages set status='recorded',transaction_id=$1",[txn]);await db.exec("update notification_preferences set outgoing_mentions=true,outgoing_mentions_since=now()-interval '1 hour'");
  const stale={ownerId:owner,transactionId:txn,category:'Food',description:'Old description',recordStatus:'active'};
  expect(await save({status:'recorded',transaction:txn,requires:false,purpose:stale})).toBe(false);
  expect(await save({status:'recorded',transaction:txn,requires:false,purpose:{...stale,description:'Lunch'}})).toBe(true);expect((await db.query<{description:string}>('select description from transactions')).rows[0].description).toBe('Lunch');
 });
 it('rolls message and receipt back together when receipt persistence fails',async()=>{
  await db.exec("update notification_preferences set outgoing_mentions=true,outgoing_mentions_since=now()-interval '1 hour';create function synthetic_receipt_failure() returns trigger language plpgsql as $$begin raise exception 'synthetic failure';end$$;create trigger synthetic_receipt_failure before insert on bank_notice_receipts for each row execute function synthetic_receipt_failure()");
  try{await expect(save()).rejects.toThrow('synthetic failure');expect((await db.query('select * from messages')).rows).toHaveLength(0);expect((await db.query('select * from bank_notice_receipts')).rows).toHaveLength(0);}finally{await db.exec('drop trigger synthetic_receipt_failure on bank_notice_receipts;drop function synthetic_receipt_failure()');}
  expect(await save()).toBe(true);
 });
 it('rejects a stale fee link instead of writing stale ledger-refresh metadata',async()=>{
  await db.exec("update notification_preferences set outgoing_mentions=true,outgoing_mentions_since=now()-interval '1 hour'");
  const stale=await source();
  await db.query('update bank_messages set fee_transaction_id=$1 where id=$2',['33333333-3333-4333-8333-333333333333',event]);
  expect(await save({source:stale})).toBe(false);expect((await db.query('select * from bank_notice_receipts')).rows).toHaveLength(0);
  expect(await save()).toBe(true);
 });
});
