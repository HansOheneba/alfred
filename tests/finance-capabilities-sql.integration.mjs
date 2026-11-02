/** Synthetic PostgreSQL only: node --import tsx tests/finance-capabilities-sql.integration.mjs */
import assert from 'node:assert/strict';
import { readFile,readdir } from 'node:fs/promises';
import { ACCOUNT_RULES_READY_SQL,PORTABILITY_READY_SQL,ACCOUNT_RULE_SCHEMA_TOKEN,PORTABILITY_SCHEMA_TOKEN } from '../lib/supabase/finance-capabilities.ts';
const {PGlite}=await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db=new PGlite();let checks=0;
const equal=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const rows=async(sql,args=[])=>(await db.query(sql,args)).rows;
const ready=async()=>({rules:(await rows(ACCOUNT_RULES_READY_SQL))[0].ready,portability:(await rows(PORTABILITY_READY_SQL))[0].ready});
const directory=new URL('../supabase/migrations/',import.meta.url);
const migration=async(name)=>readFile(new URL(name,directory),'utf8');
async function variant(sql,expected,label){await db.exec('begin');try{await db.exec(sql);equal(await ready(),expected,label);}finally{await db.exec('rollback');}}
try{
 await db.exec(`create role anon;create role authenticated;create schema auth;create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}'::jsonb);`);
 equal(await ready(),{rules:false,portability:false},'absent schema fails closed without referencing missing functions or types');
 for(const name of (await readdir(directory)).filter(name=>name.endsWith('.sql')&&name<'20261102170000').sort())await db.exec(await migration(name));
 equal(await ready(),{rules:false,portability:false},'existing finance baseline has no implicit new-feature capability');
 const rulesSql=await migration('20261102170000_account_rules.sql');
 const portabilitySql=await migration('20261102180000_data_portability.sql');
 await db.exec('begin');await db.exec(rulesSql);await assert.rejects(db.exec('select 1/0'),/division by zero/);checks++;await db.exec('rollback');
 equal(await ready(),{rules:false,portability:false},'rolled-back rule migration leaves no completion marker');
 await db.exec('begin');await db.exec(rulesSql);await db.exec('commit');
 equal(await ready(),{rules:true,portability:false},'completed rule ABI enables rules alone');
 await db.exec('begin');await db.exec(portabilitySql);await assert.rejects(db.exec('select 1/0'),/division by zero/);checks++;await db.exec('rollback');
 equal(await ready(),{rules:true,portability:false},'rolled-back portability migration leaves no completion marker');
 await db.exec('begin');await db.exec(portabilitySql);await db.exec('commit');
 equal(await ready(),{rules:true,portability:true},'complete current schema enables both features');
 equal((await rows(`select public.alfred_account_rules_schema_20261102_v1() as rules,public.alfred_portability_schema_20261102_v1() as portability`))[0],{rules:ACCOUNT_RULE_SCHEMA_TOKEN,portability:PORTABILITY_SCHEMA_TOKEN},'completion markers identify the exact reviewed ABI');
 equal((await rows(`select has_function_privilege('anon','public.alfred_portability_schema_20261102_v1()','execute') as anon,has_function_privilege('authenticated','public.alfred_account_rules_schema_20261102_v1()','execute') as authenticated`))[0],{anon:false,authenticated:false},'completion markers stay server-only');
 await variant(`drop function public.alfred_portability_schema_20261102_v1();`,{rules:true,portability:false},'earlier draft with all previous table and RPC names still fails closed');
 await variant(`drop function public.alfred_account_rules_schema_20261102_v1();`,{rules:false,portability:false},'portability also requires completed account-rule ABI');
 await variant(`comment on function public.alfred_portability_schema_20261102_v1() is 'alfred.finance-portability:old-draft';`,{rules:true,portability:false},'unknown capability version is unavailable');
 await variant(`alter table public.finance_import_previews drop column activation_of cascade;`,{rules:true,portability:false},'marker alone cannot hide a missing activation field');
 await variant(`alter table public.finance_import_previews rename column native_plan to legacy_native_plan;alter table public.finance_import_previews add column native_plan text;`,{rules:true,portability:false},'incorrect existing column type is not the current ABI');
 await variant(`alter table public.finance_import_receipts drop column notifications_resumed_at cascade;`,{rules:true,portability:false},'marker alone cannot hide missing notification undo metadata');
 await variant(`alter table public.investments drop column import_notifications_paused;`,{rules:true,portability:false},'missing notification pause column disables portability');
 await variant(`drop function public.alfred_resume_import_investment_notifications(uuid,text);`,{rules:true,portability:false},'missing resume ABI is caught before calling it');
 await variant(`drop index public.finance_import_receipts_active_archive;create unique index finance_import_receipts_active_archive on public.finance_import_receipts(owner_id,archive_id) where undone_at is null;`,{rules:true,portability:false},'old archive uniqueness predicate does not satisfy current activation ABI');
 await variant(`alter table public.finance_import_previews disable trigger finance_import_previews_bound_before_insert;`,{rules:true,portability:false},'missing staging quota enforcement disables portability');
 await variant(`alter table public.account_rule_states disable row level security;`,{rules:false,portability:false},'disabled owner RLS is not a ready schema');
 await variant(`grant execute on function public.alfred_confirm_finance_import(uuid,text) to authenticated;`,{rules:true,portability:false},'client-executable mutation RPC fails closed');
 await variant(`grant insert on public.finance_import_previews to authenticated;`,{rules:true,portability:false},'client-writable staging fails closed');
 await variant(`alter function public.alfred_confirm_finance_import(uuid,text) security definer;`,{rules:true,portability:false},'unexpected definer mutation ABI fails closed');
 equal(await ready(),{rules:true,portability:true},'all destructive synthetic variants roll back to reviewed ABI');
 // Production RPC serialization must return native-only counts, not only the accounting core.
 const owner='00000000-0000-4000-8000-000000000001',id='synthetic-native-receipt',archiveId='a'.repeat(64),at='2026-11-02T12:00:00.000Z';
 await rows('insert into auth.users(id) values($1::uuid)',[owner]);
 const before={ownerId:owner,revision:0,accounts:[],movements:[],snapshots:[],transfers:[],settlements:[],audit:[]};
 const after={...before,revision:1,audit:[{id:`import:${id}`,requestId:`import:${id}`,action:'import',actionFingerprint:archiveId,at,revision:1,before:{accounts:[],movements:[],snapshots:[],transfers:[],settlements:[]}}]};
 const native={counts:{bills:1},additions:{bills:1},duplicateCounts:{bills:0},duplicates:0,conflicts:[],coverage:[{dataset:'alfred.native.bills',status:'supported',count:1,reason:'Synthetic native receipt test'}],settings:{applied:[],preserved:[],conflicts:[]}};
 const nativePlan={tables:{bills:[{id:'10000000-0000-4000-8000-000000000001',name:'Synthetic native bill',next_date:'2026-12-01',amount:'10.00',currency:'GHS',cadence:'once',active:false,reminded_for:null,created_at:at,updated_at:at}]},origins:[{table:'bills',recordKey:'10000000-0000-4000-8000-000000000001',namespace:'synthetic:receipt-test',sourceKey:'source-bill'}],profileChanges:{},reminderChanges:{}};
 await rows(`insert into public.finance_import_previews(owner_id,id,archive_id,source_version,native_version,native_plan,expected_revision,base_hash,before_state,next_state,sources,archive,summary,expires_at) values($1::uuid,$2,$3,public.alfred_accounting_source_version($1::uuid),public.alfred_portability_native_version($1::uuid),$4::jsonb,0,'synthetic',$5::jsonb,$6::jsonb,'[]'::jsonb,'{"fixture":"synthetic"}'::jsonb,$7::jsonb,now()+interval '20 minutes')`,[owner,id,archiveId,JSON.stringify(nativePlan),JSON.stringify(before),JSON.stringify(after),JSON.stringify({canConfirm:true,counts:{accounts:0,movements:0,snapshots:0,transfers:0,settlements:0},native,unsupported:[]})]);
 const confirmed=(await rows('select public.alfred_confirm_finance_import($1::uuid,$2) as result',[owner,id]))[0].result;
 equal(confirmed.status,'saved','actual native-only import commits');
 equal(confirmed.receipt.native,native,'confirmation receipt preserves the complete native summary');
 const listed=(await rows('select public.alfred_finance_import_receipt(r) as receipt from public.finance_import_receipts r where owner_id=$1::uuid',[owner]))[0].receipt;
 equal(listed.native,native,'receipt list serialization preserves native-only feature counts');
 process.stdout.write(`Finance capabilities: ${checks} synthetic PostgreSQL assertions passed.\n`);
}finally{await db.close();}
