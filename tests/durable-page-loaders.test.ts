import { readFileSync,readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import type { StudioSettings,UserProfile } from '@/lib/config';
import { runDisplayWorker } from '@/lib/finance/accounting/display-worker';
import { ACCOUNTING_DISPLAY_DEFINITION } from '@/lib/finance/accounting/display-model';
import { loadLedgerSnapshot } from '@/lib/web/ledger';
import { loadOverview,loadOverviewTransactionPage,OverviewChanged } from '@/lib/web/overview';
import { buildOverviewSummary } from '@/lib/web/overview-summary';
import { buildChatContext } from '@/lib/web/chat-context';
import { loadChatContext,loadSettingsBank,loadSettingsBudgets,loadSettingsGoals } from '@/lib/web/secondary-read-models';
import { loadIncludedAccountCash } from '@/lib/web/included-account-cash';
import { includedAccountCash } from '@/lib/finance/accounting/cash-summary';
import { DatabaseError } from '@/lib/errors';
import { resetAccountingDisplayCache } from '@/lib/finance/accounting/display-cache';
import type { OverviewTransactionQuery } from '@/lib/web/overview-transactions';
import { emptyAccountingState } from '@/lib/finance/accounting/types';
import { emptyAccountRuleState } from '@/lib/account-rules/types';

const io=vi.hoisted(()=>({query:vi.fn()}));vi.mock('@/lib/supabase/connection',()=>({query:io.query}));
const OWNER='10000000-0000-4000-8000-000000000001',AT='2026-11-05T12:00:00.000Z';
const profile:UserProfile={profileId:OWNER,preferredName:'Fictional owner',currency:'GHS',timezone:'Africa/Accra',communicationPreference:'concise',telegramUserId:null,spreadsheetId:''};
const settings={supabase:{}} as StudioSettings;
const query:OverviewTransactionQuery={preset:'this_month',category:null,filters:{search:'',type:'all',category:'all',sort:'date-desc'}};
let db:PGlite;
beforeAll(async()=>{
 db=new PGlite();await db.exec(`create role anon;create role authenticated;create schema auth;create function auth.uid()returns uuid language sql stable as $$select null::uuid$$;create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}'::jsonb);`);
 for(const file of readdirSync('supabase/migrations').filter(file=>file.endsWith('.sql')).sort())await db.exec(readFileSync('supabase/migrations/'+file,'utf8'));
 io.query.mockImplementation(async(_settings,sql:string,values:unknown[]=[])=>{try{return(await db.query(sql,values)).rows;}catch(error){const value=error as {message:string;code?:string};throw new DatabaseError(value.message,value.code);}});
 await db.query('insert into auth.users(id)values($1::uuid)',[OWNER]);
 await db.query(`insert into transactions(owner_id,user_id,transaction_id,created_at,transaction_date,type,amount,currency,category,description,payment_method,status,updated_at,source_update_id)
 select $1::uuid,$1::text,('30000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,$2::timestamptz,('2026-'||case when n%7=0 then '10' else '11' end||'-'||lpad(((n%4)+1)::text,2,'0'))::date,case when n%5=0 then 'income' else 'expense' end,10+n,case when n%11=0 then 'USD' else 'GHS' end,case when n%5=0 then 'Salary' when n%3=0 then 'Subscriptions' else 'Food' end,case when n%3=0 then 'Fictional Netflix' else 'Fictional market' end,'Fictional cash','active',$2::timestamptz,'fixture:'||n from generate_series(1,91)n`,[OWNER,AT]);
 await db.query(`insert into budgets(budget_id,user_id,owner_id,period,category,amount,currency,created_at,updated_at)values('current',$1::text,$1::uuid,'2026-11','Food',2000,'GHS',$2,$2),('old',$1::text,$1::uuid,'2026-10','Food',1000,'GHS',$2,$2),('foreign-currency',$1::text,$1::uuid,'2026-11','Food',1000,'USD',$2,$2)`,[OWNER,AT]);
 await db.query(`insert into savings_goals(goal_id,user_id,owner_id,name,target_amount,current_amount,currency,target_date,status,created_at,updated_at)values('fictional-goal',$1::text,$1::uuid,'Fictional goal',2000,100,'GHS','2027-01-01','active',$2,$2)`,[OWNER,AT]);
 await db.query(`insert into bills(owner_id,name,next_date,amount,currency,cadence,active)values($1::uuid,'Fictional saved bill','2026-11-12',100,'GHS','monthly',true)`,[OWNER]);
 await db.query(`insert into bank_messages(id,owner_id,source,channel,text_hash,direction,kind,amount,fee,currency,counterparty,balance,occurred_at,status,raw)values('40000000-0000-4000-8000-000000000001',$1::uuid,'momo','manual','fictional-pending','out','payment',20,0,'GHS','Fictional counterparty',500,$2,'needs_label','Fictional bank evidence')`,[OWNER,AT]);
 const state={ownerId:OWNER,revision:0,accounts:[{id:'cash',label:'Fictional cash',provider:'Fictional',currency:'GHS',includeInCash:true,createdAt:AT},{id:'unknown',label:'Fictional missing balance',provider:'Fictional',currency:'GHS',includeInCash:true,createdAt:AT}],movements:[],snapshots:[{id:'opening',accountId:'cash',balanceMinor:250000,occurredAt:AT,sourceId:'fictional-opening',sourceMovementId:null}],transfers:[],settlements:[],audit:[]};
 await db.query('insert into accounting_states(owner_id,revision,state)values($1::uuid,0,$2::jsonb)',[OWNER,JSON.stringify(state)]);
 await db.query('select alfred_display.enqueue($1::uuid,$2)',[OWNER,ACCOUNTING_DISPLAY_DEFINITION]);
 const worker=await runDisplayWorker(settings.supabase);expect(worker.published).toBe(1);
},30_000);
beforeEach(()=>{vi.stubEnv('ALFRED_DURABLE_DISPLAY','true');vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(AT));io.query.mockClear();resetAccountingDisplayCache();});
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});afterAll(async()=>{await db.close();});

describe('actual canonical source → worker → durable page resources',()=>{
 it('preserves Overview, Chat, Settings and cash while all full-history hashing is forbidden',async()=>{
  const canonical=(await loadLedgerSnapshot(profile,settings,{receipts:false})).ledger;
  await db.exec('begin');
  try{
   await db.exec(`create or replace function public.alfred_accounting_source_version(owner uuid)returns text language plpgsql stable as $$begin raise exception 'Full source reconstruction is forbidden on a durable hit';end$$;`);
   io.query.mockClear();
   const overview=await loadOverview(profile,settings,query);
   expect(overview.summary).toEqual(buildOverviewSummary(canonical));expect(overview.ledger).toEqual({...canonical,rows:[]});expect(overview.firstPage.rows).toHaveLength(15);
   expect(await loadChatContext(profile,settings)).toEqual(buildChatContext(canonical));
   expect(await loadSettingsBudgets(profile,settings)).toEqual({today:canonical.today,currency:canonical.currency,budgets:canonical.budgets});
   expect(await loadSettingsGoals(profile,settings)).toEqual({currency:canonical.currency,goals:canonical.goals});
   expect(await loadSettingsBank(profile,settings)).toEqual({currency:canonical.currency,bank:canonical.bank});
   expect(await loadIncludedAccountCash(settings.supabase,OWNER,'GHS')).toEqual(includedAccountCash(canonical.accounting,'GHS'));
   const second=await loadOverviewTransactionPage(profile,settings,query,overview.firstPage.nextCursor);
   expect(second.rows).toHaveLength(15);expect(second.total).toBe(overview.firstPage.total);expect(new Set([...overview.firstPage.rows,...second.rows].map(row=>row.id)).size).toBe(30);
   expect(io.query.mock.calls.some(([,sql])=>/from public\.(?:transactions|accounting_states|imported_finance_sources|account_rule_states)|alfred_accounting_source_version/i.test(sql))).toBe(false);
   console.info('durable-page-loaders',JSON.stringify({reportRows:canonical.rows.length,overviewDetailRows:overview.firstPage.rows.length,overviewPropsBytes:Buffer.byteLength(JSON.stringify(overview)),canonicalLedgerBytes:Buffer.byteLength(JSON.stringify(canonical)),sqlQueries:io.query.mock.calls.length}));
  }finally{await db.exec('rollback');}
 });
 it('rebuilds a changed owner on the very next read and rejects the earlier pagination cursor',async()=>{
  const previous=await loadOverview(profile,settings,query);
  await db.query("update transactions set amount=amount+7,category='Transport' where owner_id=$1::uuid and source_update_id='fixture:1'",[OWNER]);
  io.query.mockClear();
  const next=await loadOverview(profile,settings,query);
  expect(next.firstPage.version).not.toBe(previous.firstPage.version);
  expect(io.query.mock.calls.some(([,sql])=>sql.includes('alfred_display.claim_owner'))).toBe(true);
  const oracle=(await loadLedgerSnapshot(profile,settings,{receipts:false})).ledger;
  expect(next.summary).toEqual(buildOverviewSummary(oracle));expect(next.ledger.budgets).toEqual(oracle.budgets);
  await expect(loadOverviewTransactionPage(profile,settings,query,previous.firstPage.nextCursor)).rejects.toBeInstanceOf(OverviewChanged);
 },30_000);
 it.each(['bank_messages','imported_finance_sources','accounting_states','account_rule_states'] as const)('invalidates and repairs %s on the next actual page read',async source=>{
  const previous=await loadOverview(profile,settings,query);
  if(source==='bank_messages')await db.query('update bank_messages set balance=balance+1 where owner_id=$1::uuid',[OWNER]);
  if(source==='accounting_states')await db.query("update accounting_states set revision=revision+1,state=jsonb_set(jsonb_set(state,'{revision}',to_jsonb(revision+1)),'{accounts,0,label}',to_jsonb('Fictional revised cash'::text)) where owner_id=$1::uuid",[OWNER]);
  if(source==='account_rule_states'){
   const state={...emptyAccountRuleState(OWNER),revision:1};
   await db.query('insert into account_rule_states(owner_id,revision,state)values($1::uuid,1,$2::jsonb)',[OWNER,JSON.stringify(state)]);
  }
  if(source==='imported_finance_sources'){
   const state=emptyAccountingState(OWNER);
   await db.query("insert into finance_import_receipts(owner_id,id,archive_id,archive,summary,before_state,after_state,source_version_after)values($1::uuid,'fictional-nextread-import',$2,$3::jsonb,'{}',$4::jsonb,$4::jsonb,'fixture')",[OWNER,'a'.repeat(64),JSON.stringify({archiveId:'a'.repeat(64)}),JSON.stringify(state)]);
   const movement={id:'fictional-imported-nextread',ownerId:OWNER,accountId:'cash',direction:'out',status:'confirmed',sourceStatus:'confirmed',amountMinor:1234,feeMinor:0,currency:'GHS',date:'2026-11-03',occurredAt:AT,description:'Fictional imported purchase',category:'Food',sourceId:'fictional-imported-source',sourceKind:'manual',sourceFingerprint:'fictional-imported-fingerprint',legacyTransactionId:null,feeTransactionId:null,legacyClassification:null,importProvenance:{namespace:'fictional-nextread',sourceId:'fictional-imported-source'}};
   await db.query("insert into imported_finance_sources(owner_id,movement_id,receipt_id,movement)values($1::uuid,$2,'fictional-nextread-import',$3::jsonb)",[OWNER,movement.id,JSON.stringify(movement)]);
  }
  io.query.mockClear();
  const next=await loadOverview(profile,settings,query);
  expect(next.firstPage.version).not.toBe(previous.firstPage.version);
  expect(io.query.mock.calls.some(([,sql])=>sql.includes('alfred_display.claim_owner'))).toBe(true);
  const canonical=(await loadLedgerSnapshot(profile,settings,{receipts:false})).ledger;
  expect(next.summary).toEqual(buildOverviewSummary(canonical));expect(next.ledger).toEqual({...canonical,rows:[]});
 },30_000);
 it('combines fresh native budget edits without rebuilding unchanged accounting',async()=>{
  const previous=await loadSettingsBudgets(profile,settings);
  await db.query("update budgets set amount=amount+50 where owner_id=$1::uuid and budget_id='current'",[OWNER]);
  io.query.mockClear();const next=await loadSettingsBudgets(profile,settings);
  expect(next.budgets.find(row=>row.budgetId==='current')!.budgetMinor).toBe(previous.budgets.find(row=>row.budgetId==='current')!.budgetMinor+5000);
  expect(io.query.mock.calls.some(([,sql])=>sql.includes('claim_owner')||sql.includes('alfred_accounting_source_version'))).toBe(false);
 });
});
