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
 const forwardSql=await migration('20261102190000_portability_review_fixes.sql');
 await db.exec('begin');await db.exec(rulesSql);await assert.rejects(db.exec('select 1/0'),/division by zero/);checks++;await db.exec('rollback');
 equal(await ready(),{rules:false,portability:false},'rolled-back rule migration leaves no completion marker');
 await db.exec('begin');await db.exec(rulesSql);await db.exec('commit');
 equal(await ready(),{rules:true,portability:false},'completed rule ABI enables rules alone');
 await db.exec('begin');await db.exec(portabilitySql);await assert.rejects(db.exec('select 1/0'),/division by zero/);checks++;await db.exec('rollback');
 equal(await ready(),{rules:true,portability:false},'rolled-back portability migration leaves no completion marker');
 await db.exec('begin');await db.exec(portabilitySql);await db.exec('commit');
 equal(await ready(),{rules:true,portability:false},'published v1 schema cannot satisfy the v2 forward ABI');
 const legacyOwners = ['90','91','92','93','94'].map(suffix=>'00000000-0000-4000-8000-0000000000'+suffix);
 await rows('insert into auth.users(id) select unnest($1::uuid[])',[legacyOwners]);
 async function legacyStage(who,label,confirm=true) {
  const id='synthetic-legacy-'+label,archiveId=String(legacyOwners.indexOf(who)+1).repeat(64),at='2026-11-02T12:00:00.000Z';
  const before={ownerId:who,revision:0,accounts:[],movements:[],snapshots:[],transfers:[],settlements:[],audit:[]};
  const source={id:id+':payment',ownerId:who,accountId:id+':account',direction:'out',status:'confirmed',sourceStatus:'confirmed',amountMinor:1000,feeMinor:0,taxMinor:0,currency:'GHS',date:'2026-11-02',occurredAt:at,description:'Synthetic upgrade movement',category:'Food',sourceCategory:'Food',sourceId:id,sourceKind:'manual',sourceFingerprint:archiveId,legacyTransactionId:null,feeTransactionId:null,legacyClassification:null};
  const hasSource=label==='unchanged';
  const after={...before,accounts:hasSource?[{id:id+':account',label:'Synthetic upgrade account',provider:'Fixture',currency:'GHS',includeInCash:true,createdAt:at}]:[],movements:hasSource?[source]:[],revision:1,audit:[{id:'import:'+id,requestId:'import:'+id,action:'import',actionFingerprint:archiveId,at,revision:1,before:{accounts:[],movements:[],snapshots:[],transfers:[],settlements:[]}}]};
  const nativePlan={tables:{budgets:[{budget_id:id,period:'2026-11',category:'Food',amount:'10.00',currency:'GHS',created_at:at,updated_at:at}]},origins:[{table:'budgets',recordKey:id,namespace:'synthetic:legacy-upgrade',sourceKey:id}],profileChanges:{},reminderChanges:{}};
  await rows(`insert into public.finance_import_previews(owner_id,id,archive_id,source_version,native_version,native_plan,expected_revision,base_hash,before_state,next_state,sources,archive,summary,expires_at)
   values($1::uuid,$2,$3,public.alfred_accounting_source_version($1::uuid),public.alfred_portability_native_version($1::uuid),$4::jsonb,0,'synthetic',$5::jsonb,$6::jsonb,$7::jsonb,'{"fixture":"synthetic-upgrade"}'::jsonb,'{"canConfirm":true,"counts":{},"unsupported":[]}'::jsonb,now()+interval '20 minutes')`,[who,id,archiveId,JSON.stringify(nativePlan),JSON.stringify(before),JSON.stringify(after),JSON.stringify(hasSource?[source]:[])]);
  if(confirm)equal((await rows('select public.alfred_confirm_finance_import($1::uuid,$2) as result',[who,id]))[0].result.status,'saved','published v1 import produces a real legacy receipt');
  return id;
 }
 const legacyUndoId=await legacyStage(legacyOwners[0],'unchanged');
 const legacyEditedId=await legacyStage(legacyOwners[1],'edited');
 const legacyChatId=await legacyStage(legacyOwners[2],'chat');
 const legacyPreviewId=await legacyStage(legacyOwners[3],'preview',false);
 const staleLegacyPreviewId=await legacyStage(legacyOwners[4],'stale-preview',false);
 const priorVersions=(await rows('select id,native_after_version,source_version_after from public.finance_import_receipts order by id'));
 equal(priorVersions.every(row=>/^[a-f0-9]{32}$/.test(row.native_after_version)),true,'legacy receipts retain unprefixed full-version hashes');
 await rows("update public.budgets set amount=25,updated_at=now() where owner_id=$1::uuid",[legacyOwners[1]]);
 await rows("insert into public.messages(owner_id,conversation_id,channel,role,body) select owner_id,id,'web','user','Synthetic legacy later chat' from public.conversations where owner_id=$1::uuid",[legacyOwners[2]]);
 await rows("update public.profiles set preferred_name='Synthetic changed choice' where id=$1::uuid",[legacyOwners[4]]);
 await db.exec('begin');await db.exec(forwardSql);await assert.rejects(db.exec('select 1/0'),/division by zero/);checks++;await db.exec('rollback');
 equal(await ready(),{rules:true,portability:false},'rolled-back forward migration cannot enable the v2 ABI');
 await db.exec('begin');await db.exec(forwardSql);await db.exec('commit');
 equal(await ready(),{rules:true,portability:true},'published schema plus additive forward migration enables v2');
 equal((await rows('select id,native_after_version,source_version_after from public.finance_import_receipts order by id')),priorVersions,'upgrade never rehashes or blesses stored receipts');
 const undo=async(who,id)=>(await rows('select public.alfred_undo_finance_import($1::uuid,$2) as result',[who,id]))[0].result;
 equal((await rows('select public.alfred_accounting_source_version($1::uuid) value',[legacyOwners[0]]))[0].value,priorVersions.find(row=>row.id===legacyUndoId).source_version_after,'source-version consolidation retains the exact published digest including imported evidence');
 await db.exec('begin');
 try {
  await rows(`update public.imported_finance_sources set movement=jsonb_set(movement,'{sourceText}','"Synthetic changed source evidence"'::jsonb) where owner_id=$1::uuid`,[legacyOwners[0]]);
  equal((await undo(legacyOwners[0],legacyUndoId)).status,'source_changed','imported source evidence remains protected after source-version consolidation');
 } finally {await db.exec('rollback');}
 equal((await undo(legacyOwners[0],legacyUndoId)).status,'saved','unchanged actual legacy receipt safely undoes after forward upgrade');
 equal((await rows('select count(*)::int count from public.budgets where owner_id=$1::uuid',[legacyOwners[0]]))[0].count,0,'legacy undo removes only its original native additions');
 equal((await undo(legacyOwners[1],legacyEditedId)).status,'native_changed','legacy native financial edit still blocks undo after upgrade');
 equal((await rows('select amount::text amount from public.budgets where owner_id=$1::uuid',[legacyOwners[1]]))[0].amount,'25.00','forward upgrade and refused undo preserve the later finance edit');
 equal((await undo(legacyOwners[2],legacyChatId)).status,'native_changed','legacy receipts honestly retain their original conservative chat guard');
 equal((await rows('select public.alfred_confirm_finance_import($1::uuid,$2) result',[legacyOwners[4],staleLegacyPreviewId]))[0].result.status,'native_changed','a stale legacy preview cannot bless a later destination change');
 equal((await rows('select public.alfred_confirm_finance_import($1::uuid,$2) result',[legacyOwners[3],legacyPreviewId]))[0].result.status,'saved','an unchanged legacy preview safely confirms through the version matcher');
 equal((await rows('select native_after_version from public.finance_import_receipts where owner_id=$1::uuid',[legacyOwners[3]]))[0].native_after_version.startsWith('v2:'),true,'newly confirmed receipts use explicit v2 identity even from a legacy preview');
 equal((await rows("select public.alfred_portability_native_version_matches($1::uuid,'bad-version') ok",[legacyOwners[0]]))[0].ok,false,'unknown native version syntax never matches');
 await db.exec(forwardSql);
 equal(await ready(),{rules:true,portability:true},'only the additive forward migration is rerunnable with existing receipt history');
 equal((await rows(`select public.alfred_account_rules_schema_20261102_v1() as rules,public.alfred_portability_schema_20261102_v2() as portability`))[0],{rules:ACCOUNT_RULE_SCHEMA_TOKEN,portability:PORTABILITY_SCHEMA_TOKEN},'completion markers identify the exact reviewed forward ABI');
 equal((await rows(`select has_function_privilege('anon','public.alfred_portability_schema_20261102_v2()','execute') as anon,has_function_privilege('authenticated','public.alfred_account_rules_schema_20261102_v1()','execute') as authenticated`))[0],{anon:false,authenticated:false},'completion markers stay server-only');
 await variant(`drop function public.alfred_portability_schema_20261102_v2();`,{rules:true,portability:false},'published draft with all previous object names still fails the v2 barrier');
 await variant(`drop function public.alfred_account_rules_schema_20261102_v1();`,{rules:false,portability:false},'portability also requires completed account-rule ABI');
 await variant(`comment on function public.alfred_portability_schema_20261102_v2() is 'alfred.finance-portability:old-draft';`,{rules:true,portability:false},'unknown capability version is unavailable');
 await variant(`alter table public.finance_import_previews drop column activation_of cascade;`,{rules:true,portability:false},'marker alone cannot hide a missing activation field');
 await variant(`alter table public.finance_import_previews rename column native_plan to legacy_native_plan;alter table public.finance_import_previews add column native_plan text;`,{rules:true,portability:false},'incorrect existing column type is not the current ABI');
 await variant(`alter table public.finance_import_receipts drop column notifications_resumed_at cascade;`,{rules:true,portability:false},'marker alone cannot hide missing notification undo metadata');
 await variant(`alter table public.investments drop column import_notifications_paused;`,{rules:true,portability:false},'missing notification pause column disables portability');
 await variant(`drop function public.alfred_resume_import_investment_notifications(uuid,text);`,{rules:true,portability:false},'missing resume ABI is caught before calling it');
 await variant(`drop index public.finance_import_receipts_active_archive;create unique index finance_import_receipts_active_archive on public.finance_import_receipts(owner_id,archive_id) where undone_at is null;`,{rules:true,portability:false},'old archive uniqueness predicate does not satisfy current activation ABI');
 await variant(`alter table public.finance_import_previews disable trigger finance_import_previews_bound_before_insert;`,{rules:true,portability:false},'missing staging quota enforcement disables portability');
 await variant(`drop function public.alfred_portability_native_version_matches(uuid,text);`,{rules:true,portability:false},'missing legacy/v2 matcher cannot enable writes');
 await variant(`drop function public.alfred_portability_lock_native(uuid);`,{rules:true,portability:false},'the legacy zero-argument lock is not the reviewed owner-lock ABI');
 await variant(`alter table public.messages drop constraint messages_owner_id_fkey;`,{rules:true,portability:false},'owner lock safety requires the message ownership foreign key');
 await variant(`alter table public.budgets drop constraint budgets_owner_id_fkey;alter table public.budgets add constraint budgets_owner_id_fkey foreign key(owner_id) references public.profiles(id) not valid;`,{rules:true,portability:false},'unvalidated ownership foreign keys do not prove insert safety');
 await variant(`alter table public.bills alter constraint bills_owner_id_fkey deferrable initially deferred;`,{rules:true,portability:false},'deferred ownership checks cannot satisfy the immediate owner fence');
 await variant(`set local session_replication_role='replica';`,{rules:true,portability:false},'a session bypassing RI triggers cannot satisfy owner-lock safety');
 await variant(`alter table public.investment_holdings disable trigger all;`,{rules:true,portability:false},'disabled RI triggers invalidate the investment child fence');
 await variant(`alter table public.investment_values drop constraint investment_values_investment_id_fkey;`,{rules:true,portability:false},'investment parent locks require intact child reference enforcement');
 await variant(`alter table public.account_rule_states disable row level security;`,{rules:false,portability:false},'disabled owner RLS is not a ready schema');
 await variant(`grant execute on function public.alfred_confirm_finance_import(uuid,text) to authenticated;`,{rules:true,portability:false},'client-executable mutation RPC fails closed');
 await variant(`grant insert on public.finance_import_previews to authenticated;`,{rules:true,portability:false},'client-writable staging fails closed');
 await variant(`alter function public.alfred_confirm_finance_import(uuid,text) security definer;`,{rules:true,portability:false},'unexpected definer mutation ABI fails closed');
 equal(await ready(),{rules:true,portability:true},'all destructive synthetic variants roll back to reviewed ABI');
 await db.exec('begin');
 try {
  await db.exec('alter table public.messages drop constraint messages_owner_id_fkey');
  await assert.rejects(rows('select public.alfred_portability_lock_native($1::uuid)',[legacyOwners[0]]),/foreign-key guard/);checks++;
 } finally {await db.exec('rollback');}
 equal(await ready(),{rules:true,portability:true},'runtime FK fence failure leaves the reviewed schema available after rollback');

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
