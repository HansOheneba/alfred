/** Synthetic embedded-Postgres verification. No credentials or external database connection.
 * Run: PGLITE_MODULE=/path/to/@electric-sql/pglite/dist/index.js node tests/portability-sql.integration.mjs
 * The PGLite module is deliberately test-only and need not ship with Alfred.
 */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
const owner = '00000000-0000-4000-8000-000000000001';
const stranger = '00000000-0000-4000-8000-000000000002';
const now = '2026-11-02T12:00:00.000Z';
let assertions = 0;
const check = (actual, expected, message) => { assert.deepEqual(actual, expected, message); assertions++; };
const rows = async (sql, values = []) => (await db.query(sql, values)).rows;
const scalar = async (sql, values = []) => (await rows(sql, values))[0].value;
const version = () => scalar('select public.alfred_accounting_source_version($1::uuid) as value', [owner]);
const state = async () => (await rows('select state from public.accounting_states where owner_id=$1::uuid', [owner]))[0]?.state;
const empty = () => ({ ownerId: owner, revision: 0, accounts: [], movements: [], snapshots: [], transfers: [], settlements: [], audit: [] });
const count = (table) => scalar(`select count(*)::int as value from public.${table}`);
const receipt = async (id, who = owner) => scalar('select public.alfred_confirm_finance_import($1::uuid,$2) as value', [who,id]);
const undo = async (id, who = owner) => scalar('select public.alfred_undo_finance_import($1::uuid,$2) as value', [who,id]);
let serial = 0;
const retainedPreviewIds = new Set();
async function stage({ id = `synthetic-${++serial}`, sourceOwner = owner, malformed = false, failAfterReceipt = false, expires = false, nativePlan = {}, archiveId: chosenArchiveId, dataId } = {}) {
  // Dispose of unconfirmed synthetic test stages; preserve the one reused staleness fixture.
  // This touches staging only, never any finance record, source, receipt or imported native data.
  await rows('delete from public.finance_import_previews where owner_id=$1::uuid and not (id=any($2::text[]))',[owner,[...retainedPreviewIds]]);
  const base = await state() || empty();
  const archiveId = chosenArchiveId ?? (++serial).toString(16).padStart(64,'0');
  const identity = dataId ?? id;
  const account = {id:`${identity}:account`,label:'Synthetic account',provider:'Fixture',currency:'GHS',includeInCash:true,createdAt:now};
  const movement = {id:`${identity}:payment`,ownerId:sourceOwner,accountId:account.id,direction:'out',status:'confirmed',sourceStatus:'confirmed',amountMinor:1000,feeMinor:50,taxMinor:10,currency:'GHS',date:'2026-11-02',occurredAt:now,description:'Synthetic payment',category:'Groceries',sourceCategory:'Groceries',sourceId:`synthetic:${identity}`,sourceKind:'manual',sourceFingerprint:archiveId,legacyTransactionId:null,feeTransactionId:null,legacyClassification:null};
  const next = {...base,revision:base.revision+1,accounts:[...base.accounts,account],movements:[...base.movements,{...movement,ownerId:owner}],audit:[...base.audit,{id:`import:${id}`,requestId:`import:${id}`,action:'import',actionFingerprint:archiveId,at:now,revision:base.revision+1,before:{accounts:base.accounts,movements:base.movements,snapshots:base.snapshots,transfers:base.transfers,settlements:base.settlements}}].slice(-50)};
  const source = malformed ? {...movement,id:'not-in-next-state'} : movement;
  const summary = {canConfirm:true,counts:{accounts:1,movements:1,snapshots:0,transfers:0,settlements:0},unsupported:['plans are preserved only']};
  await rows(`insert into public.finance_import_previews(owner_id,id,archive_id,source_version,expected_revision,base_hash,before_state,next_state,sources,archive,summary,expires_at,native_version,native_plan)
  values($1::uuid,$2,$3,$4,$5,'synthetic-base',$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,now()+($11::int*interval '1 minute'),$12,$13::jsonb)`,
  [owner,id,archiveId,await version(),base.revision,JSON.stringify(base),JSON.stringify(next),JSON.stringify([source]),JSON.stringify({manifest:{sourceApp:'money-tracker'},datasets:{fixture:'synthetic'}}),JSON.stringify(summary),expires?-1:20,await scalar('select public.alfred_portability_native_version($1::uuid) as value',[owner]),JSON.stringify(nativePlan)]);
  if(failAfterReceipt) await db.exec(`create or replace function public.synthetic_fail_accounting_insert() returns trigger language plpgsql as $$ begin raise exception 'synthetic failure after imported source insert'; end $$; create trigger synthetic_fail_import before insert on public.accounting_events for each row execute function public.synthetic_fail_accounting_insert();`);
  return {id,next,base,archiveId,movement};
}
try {
  await db.exec(`create role anon; create role authenticated; create schema auth; create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$; create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}'::jsonb);`);
  const migrationDir=new URL('../supabase/migrations/',import.meta.url);
  for(const name of (await readdir(migrationDir)).filter(name=>name.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(name,migrationDir),'utf8'));
  await rows('insert into auth.users(id) values($1::uuid),($2::uuid)',[owner,stranger]);
  for(const name of (await readdir(migrationDir)).filter(name=>name.endsWith('.sql')&&name>='20261102190000').sort()) await db.exec(await readFile(new URL(name,migrationDir),'utf8'));
  assertions++; // only the additive forward migration is rerunnable; published migrations stay immutable
  const first=await stage();
  check((await receipt(first.id,stranger)).status,'missing','foreign owner cannot find or confirm preview');
  check(await count('accounting_states'),0,'foreign owner attempt made no writes');
  const saved=await receipt(first.id);
  check(saved.status,'saved','confirmed import committed');
  check(saved.receipt.counts.movements,1,'receipt reports imported core count');
  check((await state()).movements[0].taxMinor,10,'tax evidence retained');
  check(await count('imported_finance_sources'),1,'durable source evidence committed');
  check(await count('accounting_events'),1,'event atomically committed');
  check(await count('finance_import_previews'),0,'consumed preview removed');
  check((await receipt(first.id)).status,'duplicate','confirm retry returns original receipt');
  check(await count('accounting_events'),1,'confirm retry creates no duplicate accounting entries');
  check((await undo(first.id,stranger)).status,'missing','foreign owner cannot undo');
  check((await undo(first.id)).status,'saved','safe undo committed');
  check((await state()).movements.length,0,'undo removed imported records');
  check(await count('imported_finance_sources'),0,'undo removed only imported evidence');
  check(await count('finance_import_receipts'),1,'undo retains full archive receipt');
  check((await undo(first.id)).status,'duplicate','undo retry is idempotent');
  check((await receipt(first.id)).receipt.undoAvailable,false,'undone archive retry stays undone');
  const reimport=await stage({archiveId:first.archiveId,dataId:first.id});
  check((await receipt(reimport.id)).status,'saved','fresh preview can re-import an archive after safe undo');
  check((await state()).movements[0].id,first.movement.id,'re-import retains the stable canonical movement identity');
  check(await count('finance_import_receipts'),2,'re-import creates a new permanent receipt generation');
  const eventsAfterReimport=await count('accounting_events');
  const originalRetry=await receipt(first.id);
  check(originalRetry.status,'duplicate','old confirm remains idempotent after re-import');
  check(originalRetry.receipt.id,first.id,'old confirm returns its original receipt');
  check(originalRetry.receipt.undoAvailable,false,'old receipt stays undone and cannot resurrect records');
  check(await count('accounting_events'),eventsAfterReimport,'old retry cannot create new events');
  check((await state()).movements.length,1,'old retry leaves active import generation unchanged');
  const duplicateActive=await stage({archiveId:first.archiveId,dataId:first.id});
  const duplicateResult=await receipt(duplicateActive.id);
  check(duplicateResult.status,'duplicate','active archive prevents a second generation before undo');
  check(duplicateResult.receipt.id,reimport.id,'active archive duplicate returns the current generation');
  check((await undo(reimport.id)).status,'saved','re-import generation has an independent safe undo');
  check(await count('imported_finance_sources'),0,'second undo removes stable imported evidence again');


  const broken=await stage({failAfterReceipt:true});
  const beforeCounts=await Promise.all(['accounting_events','finance_import_receipts','imported_finance_sources'].map(count));
  await assert.rejects(receipt(broken.id),/synthetic failure/); assertions++;
  check(await Promise.all(['accounting_events','finance_import_receipts','imported_finance_sources'].map(count)),beforeCounts,'mid-commit SQL failure rolled back sources, receipt, accounting event');
  check(await state(),broken.base,'mid-commit failure preserves original accounting aggregate');
  await db.exec('drop trigger synthetic_fail_import on public.accounting_events; drop function public.synthetic_fail_accounting_insert()');

  const malformed=await stage({malformed:true});
  await assert.rejects(receipt(malformed.id),/Invalid staged source ownership or reference/); assertions++;
  check(await count('imported_finance_sources'),0,'unresolved source never committed');
  const crossOwner=await stage({sourceOwner:stranger});
  await assert.rejects(receipt(crossOwner.id),/Invalid staged source ownership or reference/); assertions++;
  check(await count('imported_finance_sources'),0,'cross-owner source never committed');
  const expired=await stage({expires:true});
  check((await receipt(expired.id)).status,'expired','expired preview cannot commit');

  const changedSource=await stage();
  retainedPreviewIds.add(changedSource.id);
  await rows("insert into public.transactions(transaction_id,created_at,transaction_date,user_id,owner_id,type,amount,currency,category,description,status,updated_at,source_update_id) values('10000000-0000-4000-8000-000000000001',now(),'2026-11-02',$1::text,$1::text::uuid,'expense',1,'GHS','Synthetic','Synthetic','active',now(),'synthetic-source-change')",[owner]);
  check((await receipt(changedSource.id)).status,'source_changed','new raw evidence invalidates preview');
  const current=await stage();
  check((await receipt(current.id)).status,'saved','fresh preview can commit after source change');
  await rows("insert into public.bank_messages(owner_id,source,channel,text_hash,direction,kind,amount,currency,occurred_at,status,raw) values($1::uuid,'momo','manual','synthetic-later-hash','out','payment',1,'GHS',now(),'recorded',$2)",[owner,'synthetic later message']);
  check((await undo(current.id)).status,'source_changed','undo preserves later source evidence');
  check((await state()).movements.length,1,'blocked undo preserves imported records');
  const later=await stage();
  check((await receipt(later.id)).status,'saved','later import commits');
  check((await undo(current.id)).status,'stale','undo does not destroy later accounting changes');
  check((await receipt(changedSource.id)).status,'stale','later revision invalidates old preview');
  retainedPreviewIds.delete(changedSource.id);
  check((await undo(later.id)).status,'saved','latest unchanged import remains undoable');

  const fixtureNativePlan=() => {
    const uuid=(n)=>`40000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
    const tables={
      budgets:[{budget_id:'synthetic-native-budget',period:'2026-11',category:'Synthetic groceries',amount:'200.10',currency:'GHS',created_at:now,updated_at:now}],
      savings_goals:[{goal_id:'synthetic-native-goal',name:'Synthetic native goal',target_amount:'1000.20',current_amount:'100.10',currency:'GHS',target_date:'2027-01-01',status:'active',created_at:now,updated_at:now}],
      bills:[{id:uuid(1),name:'Synthetic native bill',next_date:'2026-12-01',amount:'50.25',currency:'GHS',cadence:'monthly',active:false,reminded_for:null,created_at:now,updated_at:now}],
      investments:[{id:uuid(2),name:'Synthetic native investment',kind:'tbill',provider:'Fixture',currency:'GHS',invested_before:'100.00',principal:'1000.00',rate:'12.3400',started_on:'2026-11-01',matures_on:'2027-01-01',reminded_at:null,payee_key:null,status:'active',created_at:now,updated_at:now,import_notifications_paused:true,import_cost_basis_unknown:true}],
      investment_holdings:[{id:uuid(3),investment_id:uuid(2),symbol:'SYN',quantity:'1.123456',cost:'100.12',updated_at:now}],
      investment_values:[{id:uuid(4),investment_id:uuid(2),value:'1000.12',as_of:now,source:'reported',created_at:now}],
      investment_contributions:[{id:uuid(5),investment_id:uuid(2),amount:'-10.25',currency:'GHS',occurred_on:'2026-11-02',bank_message_id:null,note:'Synthetic withdrawal',created_at:now}],
      people:[{person_key:'synthetic native person',name:'Synthetic Native Person',note:'Synthetic note',updated_at:now}],
      payee_rules:[{payee_key:'synthetic native payee',category:'Synthetic groceries',description:'Synthetic recurring payee',kind:'category',updated_at:now}],
      about_me:[{id:uuid(6),note:'Synthetic native note',account:null,created_at:now}],
      messages:[{id:uuid(7),channel:'web',role:'user',body:'Synthetic native conversation',created_at:now,client_id:null,intent:'review',meta:{synthetic:true}}],
      loans:[{id:uuid(8),person:'Synthetic Native Person',person_key:'synthetic native person',kind:'borrowed',amount:'12.34',currency:'GHS',occurred_at:now,note:'Synthetic native borrowing',bank_message_id:null,created_at:now}],
    };
    const origins=Object.entries(tables).flatMap(([table,records])=>records.map(row=>({table,recordKey:row.budget_id??row.goal_id??(table==='people'?row.person_key:table==='payee_rules'?row.payee_key:row.id),namespace:'synthetic:portable-origin',sourceKey:`original:${table}`})));
    return {tables,origins,profileChanges:{preferred_name:'Synthetic imported preference',financial_goals:'Synthetic imported goal',communication_preference:'detailed'},reminderChanges:{morning_enabled:false,commute_enabled:false,evening_enabled:false,morning_minute:420,commute_minute:450,evening_minute:1140}};
  };
  const nativeVersion=()=>scalar('select public.alfred_portability_native_version($1::uuid) as value',[owner]);
  const beforeNative=await nativeVersion();
  const native=await stage({nativePlan:fixtureNativePlan()});
  const nativeSaved=await receipt(native.id);
  check(nativeSaved.status,'saved','native features atomically commit with accounting core');
  for(const table of Object.keys(fixtureNativePlan().tables)) check(await scalar(`select count(*)::int as value from public.${table} where owner_id=$1::uuid`,[owner]),1,`${table} native record populated`);
  check(await count('finance_import_native_origins'),12,'each native record has one durable provenance origin');
  check(await scalar('select preferred_name as value from public.profiles where id=$1::uuid',[owner]),'Synthetic imported preference','safe profile values restored');
  check(await scalar('select morning_enabled as value from public.reminder_preferences where owner_id=$1::uuid',[owner]),false,'import does not enable reminders');
  check(await scalar('select import_notifications_paused as value from public.investments where owner_id=$1::uuid',[owner]),true,'investment notifications begin paused');
  check(nativeSaved.receipt.investmentNotificationsPaused,true,'receipt reports actual paused imported investment');
  check(await scalar('select import_cost_basis_unknown as value from public.investments where owner_id=$1::uuid',[owner]),true,'unknown imported cost basis is preserved explicitly');
  check(await scalar('select m.conversation_id=c.id as value from public.messages m join public.conversations c on c.owner_id=m.owner_id where m.owner_id=$1::uuid',[owner]),true,'imported messages use destination owner conversation');
  check(await scalar('select quantity::text as value from public.investment_holdings where owner_id=$1::uuid',[owner]),'1.123456','native investment fractional quantity exact');
  check(await scalar('select amount::text as value from public.investment_contributions where owner_id=$1::uuid',[owner]),'-10.25','native withdrawal sign exact');
  check(await scalar('select kind as value from public.loans where owner_id=$1::uuid',[owner]),'borrowed','native existing-feature borrowing populated without new ledger source');
  check((await undo(native.id)).status,'saved','unchanged native/core import can be undone atomically');
  check(await nativeVersion(),beforeNative,'native undo restores exact prior tables and safe settings');
  check(await count('finance_import_native_origins'),0,'native undo removes only its provenance registry entries');
  check(await scalar('select count(*)::int as value from public.transactions where owner_id=$1::uuid',[owner]),1,'native restoration does not create duplicate raw transactions');

  const nativeRollback=await stage({nativePlan:fixtureNativePlan(),failAfterReceipt:true});
  await assert.rejects(receipt(nativeRollback.id),/synthetic failure/); assertions++;
  check(await nativeVersion(),beforeNative,'mid-commit core failure rolls back all native rows/settings/origins');
  await db.exec('drop trigger synthetic_fail_import on public.accounting_events; drop function public.synthetic_fail_accounting_insert()');
  const nativePreviewStale=await stage({nativePlan:fixtureNativePlan()});
  await rows("update public.profiles set preferred_name='Synthetic later setting' where id=$1::uuid",[owner]);
  check((await receipt(nativePreviewStale.id)).status,'native_changed','native edit since preview blocks atomic confirm');
  const chat=()=>rows("insert into public.messages(owner_id,conversation_id,channel,role,body) select owner_id,id,'web','user','Synthetic later chat' from public.conversations where owner_id=$1::uuid",[owner]);
  const reminderStamp=async()=>{
    await rows("update public.bills set reminded_for=current_date,updated_at=now() where owner_id=$1::uuid",[owner]);
    await rows("update public.investments set reminded_at=now(),updated_at=now() where owner_id=$1::uuid",[owner]);
    await rows("update public.profiles set account_names='Synthetic later learned account',updated_at=now() where id=$1::uuid",[owner]);
  };
  const chatty=await stage({nativePlan:fixtureNativePlan()});
  await chat(); await reminderStamp();
  check((await receipt(chatty.id)).status,'saved','ordinary chat and reminder delivery after preview do not block confirm');
  await chat(); await reminderStamp();
  check((await undo(chatty.id)).status,'saved','ordinary chat and reminder delivery after import do not block undo');
  check(await scalar("select count(*)::int as value from public.messages where owner_id=$1::uuid and body='Synthetic later chat'",[owner]),2,'undo keeps later chat messages');
  check(await scalar('select account_names as value from public.profiles where id=$1::uuid',[owner]),'Synthetic later learned account','undo preserves later bank account-name learning');
  await db.exec('begin');
  try {
    const clearing=await stage({nativePlan:fixtureNativePlan()});
    check((await receipt(clearing.id)).status,'saved','v2 native messages import before a later clear-history action');
    await rows('delete from public.messages where owner_id=$1::uuid',[owner]);
    check((await undo(clearing.id)).status,'native_changed','later clear-history deletion of imported messages blocks undo');
    check(await scalar('select count(*)::int as value from public.messages where owner_id=$1::uuid',[owner]),0,'refused undo never resurrects cleared conversation history');
    check(await scalar('select count(*)::int as value from public.budgets where owner_id=$1::uuid',[owner]),1,'refused undo preserves the imported financial records');
  } finally {await db.exec('rollback');}

  const resumedNative=await stage({nativePlan:fixtureNativePlan()});
  check((await receipt(resumedNative.id)).status,'saved','fresh native preview confirms after setting change');
  const resume=(id,who=owner)=>scalar('select public.alfred_resume_import_investment_notifications($1::uuid,$2) as value',[who,id]);
  check((await resume(resumedNative.id,stranger)).status,'missing','foreign owner cannot resume notifications');
  check((await resume(resumedNative.id)).resumed,1,'explicit receipt action resumes only imported investment notifications');
  check((await resume(resumedNative.id)).resumed,0,'resuming notifications is idempotent');
  check((await undo(resumedNative.id)).status,'native_changed','later explicit notification edit prevents undo overwrite');
  check((await receipt(resumedNative.id)).receipt.investmentNotificationsPaused,false,'receipt reflects notifications already resumed');
  check((await receipt(resumedNative.id)).receipt.undoAvailable,false,'receipt reload suppresses unsafe undo after notifications resume');
  check(typeof (await receipt(resumedNative.id)).receipt.notificationsResumedAt,'string','explicit resume has a permanent receipt timestamp');
  check((await resume(native.id)).status,'undone','undone receipt cannot resume notifications');
  check(await count('finance_import_native_origins'),12,'blocked native undo retains provenance');

  const maliciousNative=fixtureNativePlan();
  maliciousNative.tables={transactions:[{transaction_id:'native-doublecount-attempt'}]};maliciousNative.origins=[];
  const invalidNative=await stage({nativePlan:maliciousNative});
  await assert.rejects(receipt(invalidNative.id),/Unsupported native import domain/); assertions++;
  const foreignInvestment=fixtureNativePlan();
  foreignInvestment.tables={investment_holdings:[{id:'50000000-0000-4000-8000-000000000001',investment_id:'50000000-0000-4000-8000-000000000002',symbol:'SYN',quantity:'1'}]};
  foreignInvestment.origins=[{table:'investment_holdings',recordKey:'50000000-0000-4000-8000-000000000001',namespace:'synthetic',sourceKey:'foreign'}];
  await rows("insert into public.investments(id,owner_id,name,kind) values('50000000-0000-4000-8000-000000000002',$1::uuid,'Foreign synthetic investment','other')",[stranger]);
  const invalidForeign=await stage({nativePlan:foreignInvestment});
  await assert.rejects(receipt(invalidForeign.id),/Imported investment belongs to another owner or is missing/); assertions++;
  check(await scalar('select count(*)::int as value from public.investment_holdings where owner_id=$1::uuid',[stranger]),0,'foreign native reference never written');

  const onlyNative=(table,record)=>({tables:{[table]:[record]},origins:[{table,recordKey:record.budget_id??record.goal_id??(table==='people'?record.person_key:table==='payee_rules'?record.payee_key:record.id),namespace:'synthetic:negative-fixture',sourceKey:`source:${table}`}],profileChanges:{},reminderChanges:{}});
  const rejectsNative=async(plan,expected)=>{const staged=await stage({nativePlan:plan});await assert.rejects(receipt(staged.id),expected);assertions++;};
  await rejectsNative(onlyNative('people',{person_key:'negative-owner-injection',name:'Synthetic',note:'Synthetic',owner_id:stranger}),/Unsupported native import column/);
  await rejectsNative(onlyNative('about_me',{id:'60000000-0000-4000-8000-000000000001',note:'Synthetic managed filter',account:'1234'}),/Import cannot configure managed account filtering/);
  await rejectsNative(onlyNative('bills',{id:'60000000-0000-4000-8000-000000000002',name:'Synthetic enabled bill',next_date:'2026-12-01',currency:'GHS',cadence:'monthly',active:true,reminded_for:null}),/Imported bills must begin with reminders paused/);
  await rejectsNative(onlyNative('investments',{id:'60000000-0000-4000-8000-000000000003',name:'Synthetic enabled investment',kind:'other',import_notifications_paused:false}),/Imported investment notifications must be paused/);
  await rejectsNative(onlyNative('loans',{id:'60000000-0000-4000-8000-000000000004',person:'Synthetic',person_key:'synthetic',kind:'lent',amount:'10.00',occurred_at:now,bank_message_id:'60000000-0000-4000-8000-000000000005'}),/Imported loans cannot activate raw bank evidence/);
  await rejectsNative({tables:{},origins:[],profileChanges:{account_names:'Synthetic unauthorized filter'},reminderChanges:{}},/Unsupported imported setting/);
  await rejectsNative({tables:{},origins:[],profileChanges:{},reminderChanges:{morning_enabled:true}},/Import cannot enable reminders/);
  const missingOrigin=onlyNative('people',{person_key:'negative-missing-origin',name:'Synthetic',note:'Synthetic'});missingOrigin.origins=[];
  const beforeMissingOrigin=await nativeVersion();
  await rejectsNative(missingOrigin,/Every native row requires one provenance origin/);
  check(await nativeVersion(),beforeMissingOrigin,'missing provenance aborts inserted native row and receipt together');

  const guardedInvestment={id:'70000000-0000-4000-8000-000000000001',name:'Synthetic guarded imported investment',kind:'other',import_notifications_paused:true};
  const guarded=await stage({nativePlan:onlyNative('investments',guardedInvestment)});
  check((await receipt(guarded.id)).status,'saved','guarded investment fixture imported');
  await rows("insert into public.investment_holdings(id,owner_id,investment_id,symbol,quantity) values('70000000-0000-4000-8000-000000000002',$1::uuid,'70000000-0000-4000-8000-000000000001','SYN',1)",[stranger]);
  check((await undo(guarded.id)).status,'native_changed','foreign dependency blocks unsafe cascading undo');
  check(await scalar("select count(*)::int as value from public.investment_holdings where id='70000000-0000-4000-8000-000000000002'"),1,'blocked undo preserves foreign dependent record');

  const ruleState=async()=>(await rows('select state from public.account_rule_states where owner_id=$1::uuid',[owner]))[0]?.state??{ownerId:owner,revision:0,rules:[],bindings:[]};
  const makeRuleNative=async(id,{foreignAccount=false,foreignOwner=false}={})=>{
    const prior=await ruleState();
    const accountId=foreignAccount?'synthetic:missing-foreign-account':`${id}:account`;
    const rule={id:'a0000000-0000-4000-8000-000000000001',accountId,matchMode:'exact',merchantExact:'synthetic merchant',direction:'out',category:'Synthetic rule category',active:true,priority:10,effectiveFrom:now,createdAt:now,revision:1,importProvenance:{namespace:'synthetic:rule-origin',sourceId:'source-rule'}};
    const binding={id:'a0000000-0000-4000-8000-000000000002',accountId,provider:'momo',accountSuffix:'1234',currency:'GHS',active:false,createdAt:now,revision:1,importProvenance:{namespace:'synthetic:rule-origin',sourceId:'source-binding'}};
    return {tables:{},origins:[],profileChanges:{},reminderChanges:{},accountRules:{expectedRevision:prior.revision,state:{ownerId:foreignOwner?stranger:owner,revision:prior.revision+1,rules:[...prior.rules,rule],bindings:[...prior.bindings,binding]},requestId:`import:${id}`,fingerprint:'e'.repeat(64)}};
  };
  const ruleImportId='synthetic-account-rule-import';
  const ruleInitial=await ruleState();
  const ruleImport=await stage({id:ruleImportId,nativePlan:await makeRuleNative(ruleImportId)});
  check((await receipt(ruleImport.id)).status,'saved','rule aggregate commits against newly imported accounts in the same transaction');
  check((await ruleState()).rules[0].accountId,`${ruleImportId}:account`,'account-specific rule links destination imported account');
  check((await ruleState()).bindings[0].accountSuffix,'1234','exact account binding metadata retained');
  check((await ruleState()).rules[0].importProvenance.sourceId,'source-rule','custom rule preserves source provenance');
  check((await ruleState()).bindings[0].active,false,'imported inactive binding stays inactive');
  check(await scalar('select count(*)::int as value from public.account_rule_events where owner_id=$1::uuid',[owner]),1,'rule import has a durable audit event');
  const ruleBeforeSnapshot=await scalar('select native_before as value from public.finance_import_receipts where owner_id=$1::uuid and id=$2',[owner,ruleImport.id]);
  check(ruleBeforeSnapshot.accountRules,{existed:false,state:ruleInitial},'native receipt retains exact pre-import custom aggregate state');
  check((await undo(ruleImport.id)).status,'saved','unchanged account rules undo with their imported account safely');
  check((await ruleState()).rules,[],'rule undo restores prior rules');
  check((await ruleState()).bindings,[],'rule undo restores prior bindings');
  check((await ruleState()).revision,2,'rule undo advances aggregate revision monotonically');
  check(await scalar('select count(*)::int as value from public.account_rule_events where owner_id=$1::uuid',[owner]),2,'rule undo adds durable event instead of erasing history');
  check((await state()).accounts.some(account=>account.id===`${ruleImportId}:account`),false,'rule undo and account removal are atomic');

  const rollbackRules=await ruleState();const rollbackRuleEvents=await count('account_rule_events');const rollbackAccounting=await state();
  const ruleRollbackId='synthetic-account-rule-rollback';
  const ruleRollback=await stage({id:ruleRollbackId,nativePlan:await makeRuleNative(ruleRollbackId),failAfterReceipt:true});
  await assert.rejects(receipt(ruleRollback.id),/synthetic failure/);assertions++;
  check(await ruleState(),rollbackRules,'forced late commit failure rolls back custom rule state');
  check(await count('account_rule_events'),rollbackRuleEvents,'forced late failure rolls back rule audit event');
  check(await state(),rollbackAccounting,'forced late failure rolls back newly inserted accounting accounts');
  await db.exec('drop trigger synthetic_fail_import on public.accounting_events; drop function public.synthetic_fail_accounting_insert()');
  const foreignRuleId='synthetic-account-rule-foreign';
  const foreignRule=await stage({id:foreignRuleId,nativePlan:await makeRuleNative(foreignRuleId,{foreignAccount:true})});
  await assert.rejects(receipt(foreignRule.id),/Account-rule import did not commit: ownership/);assertions++;
  check(await ruleState(),rollbackRules,'foreign account rule reference cannot alter owned aggregate');
  const foreignRuleOwnerId='synthetic-account-rule-owner';
  const foreignRuleOwner=await stage({id:foreignRuleOwnerId,nativePlan:await makeRuleNative(foreignRuleOwnerId,{foreignOwner:true})});
  await assert.rejects(receipt(foreignRuleOwner.id),/Invalid staged account-rule import/);assertions++;
  check(await state(),rollbackAccounting,'foreign aggregate owner cannot partially save new accounts');

  const ruleRaceId='synthetic-account-rule-race';
  const ruleRace=await stage({id:ruleRaceId,nativePlan:await makeRuleNative(ruleRaceId)});
  const sourceBeforeRuleEdit=await version();
  const racedRuleState={...await ruleState(),revision:(await ruleState()).revision+1};
  const directRuleEdit=async(expected,key,next)=>scalar('select public.alfred_write_account_rules($1::uuid,$2::bigint,$3,$4,$5::jsonb) as value',[owner,expected,key,'f'.repeat(64),JSON.stringify(next)]);
  check((await directRuleEdit(racedRuleState.revision-1,'synthetic-later-rule-edit',racedRuleState)).status,'saved','ordinary rule write remains available');
  check(await version()===sourceBeforeRuleEdit,false,'final portability source version includes account-rule aggregate changes');
  check((await receipt(ruleRace.id)).status,'source_changed','rule edit between preview and confirm invalidates import');
  check(await state(),rollbackAccounting,'raced rule edit cannot leave partially imported accounting account');
  const laterRuleId='synthetic-account-rule-later-edit';
  const laterRuleImport=await stage({id:laterRuleId,nativePlan:await makeRuleNative(laterRuleId)});
  check((await receipt(laterRuleImport.id)).status,'saved','fresh rule preview commits after rule revision change');
  const priorEditedRule=await ruleState();
  const laterEditedRule={...priorEditedRule,revision:priorEditedRule.revision+1,rules:priorEditedRule.rules.map(rule=>({...rule,category:'Synthetic later user category',revision:rule.revision+1}))};
  check((await directRuleEdit(priorEditedRule.revision,'synthetic-user-category-edit',laterEditedRule)).status,'saved','later user rule edit commits independently');
  check((await undo(laterRuleImport.id)).status,'source_changed','import undo cannot destroy later account-rule edits');
  check((await ruleState()).rules[0].category,'Synthetic later user category','blocked undo preserves later user category exactly');
  const overwriteRuleId='synthetic-account-rule-overwrite';
  const existingRuleState=await ruleState();
  const overwriteNative={tables:{},origins:[],profileChanges:{},reminderChanges:{},accountRules:{expectedRevision:existingRuleState.revision,state:{...existingRuleState,revision:existingRuleState.revision+1,rules:existingRuleState.rules.map(rule=>({...rule,category:'Synthetic forbidden overwrite'}))},requestId:`import:${overwriteRuleId}`,fingerprint:'d'.repeat(64)}};
  const overwriteRule=await stage({id:overwriteRuleId,nativePlan:overwriteNative});
  await assert.rejects(receipt(overwriteRule.id),/Cannot overwrite existing account rules during import/);assertions++;
  check(await ruleState(),existingRuleState,'native import is append-only and cannot replace existing user rule values');


  const activeSource=(await rows('select * from public.finance_import_receipts where owner_id=$1::uuid and id=$2',[owner,guarded.id]))[0];
  const undoneSource=(await rows('select * from public.finance_import_receipts where owner_id=$1::uuid and id=$2',[owner,first.id]))[0];
  async function activationProbe(who,sourceId,stored,{archiveId=stored.archive_id,archive=stored.archive}={}) {
    await rows('delete from public.finance_import_previews where owner_id=$1::uuid',[who]);
    const id=`activation-probe-${++serial}`;const key=(++serial).toString(16).padStart(64,'0');
    const base=(await rows('select state from public.accounting_states where owner_id=$1::uuid',[who]))[0]?.state??{ownerId:who,revision:0,accounts:[],movements:[],snapshots:[],transfers:[],settlements:[],audit:[]};
    const next={...base,revision:base.revision+1,audit:[...base.audit,{id:`import:${id}`,requestId:`import:${id}`,action:'import',actionFingerprint:archiveId,at:now,revision:base.revision+1,before:{accounts:base.accounts,movements:base.movements,snapshots:base.snapshots,transfers:base.transfers,settlements:base.settlements}}].slice(-50)};
    await rows(`insert into public.finance_import_previews(owner_id,id,archive_id,activation_of,activation_key,source_version,native_version,native_plan,expected_revision,base_hash,before_state,next_state,sources,archive,summary,expires_at) values($1::uuid,$2,$3,$4,$5,public.alfred_accounting_source_version($1::uuid),public.alfred_portability_native_version($1::uuid),'{}'::jsonb,$6,'synthetic-activation',$7::jsonb,$8::jsonb,'[]'::jsonb,$9::jsonb,'{"canConfirm":true}'::jsonb,now()+interval '20 minutes')`,[who,id,archiveId,sourceId,key,base.revision,JSON.stringify(base),JSON.stringify(next),JSON.stringify(archive)]);
    return receipt(id,who);
  }
  const beforeActivationProbe=await state();const beforeActivationEvents=await count('accounting_events');const beforeActivationReceipts=await count('finance_import_receipts');
  check((await activationProbe(stranger,activeSource.id,activeSource)).status,'missing_source','foreign owner cannot activate another owner stored archive');
  check((await activationProbe(owner,undoneSource.id,undoneSource)).status,'source_undone','undone source receipt cannot be activated');
  check((await activationProbe(owner,activeSource.id,activeSource,{archiveId:'d'.repeat(64)})).status,'conflict','activation cannot invent a replacement archive identity');
  check((await activationProbe(owner,activeSource.id,activeSource,{archive:{manifest:{sourceApp:'money-tracker'},datasets:{fixture:'tampered source'}}})).status,'conflict','activation must use exact original stored archive evidence');
  check(await state(),beforeActivationProbe,'blocked activation never changes accounting state');
  check(await count('accounting_events'),beforeActivationEvents,'blocked activation creates no accounting events');
  check(await count('finance_import_receipts'),beforeActivationReceipts,'blocked activation creates no receipts');

  // Preview retention is bounded separately from finance. These owners contain synthetic data only.
  const quotaOwner='00000000-0000-4000-8000-000000000011';
  const quotaForeign='00000000-0000-4000-8000-000000000012';
  const quotaConcurrent='00000000-0000-4000-8000-000000000013';
  await rows('insert into auth.users(id) values($1::uuid),($2::uuid),($3::uuid)',[quotaOwner,quotaForeign,quotaConcurrent]);
  const quotaStage=async(who,id,minutes=20)=>{
    const archiveId=(++serial).toString(16).padStart(64,'0');
    const before={ownerId:who,revision:0,accounts:[],movements:[],snapshots:[],transfers:[],settlements:[],audit:[]};
    const next={...before,revision:1,audit:[{id:`import:${id}`,requestId:`import:${id}`,action:'import',actionFingerprint:archiveId,at:now,revision:1,before:{accounts:[],movements:[],snapshots:[],transfers:[],settlements:[]}}]};
    return rows(`insert into public.finance_import_previews(owner_id,id,archive_id,source_version,native_version,native_plan,expected_revision,base_hash,before_state,next_state,sources,archive,summary,expires_at) values($1::uuid,$2,$3,public.alfred_accounting_source_version($1::uuid),public.alfred_portability_native_version($1::uuid),'{}'::jsonb,0,'synthetic',$4::jsonb,$5::jsonb,'[]'::jsonb,'{"fixture":"synthetic"}'::jsonb,'{"canConfirm":true}'::jsonb,now()+($6::int*interval '1 minute'))`,[who,id,archiveId,JSON.stringify(before),JSON.stringify(next),minutes]);
  };
  const quotaCount=(who)=>scalar('select count(*)::int as value from public.finance_import_previews where owner_id=$1::uuid',[who]);
  const financeBeforeQuota=await rows(`select public.alfred_accounting_source_version($1::uuid) as source,public.alfred_portability_native_version($1::uuid) as native,(select count(*)::int from public.accounting_states) as states,(select count(*)::int from public.accounting_events) as events,(select count(*)::int from public.finance_import_receipts) as receipts`,[quotaOwner]);
  await quotaStage(quotaForeign,'quota-foreign-expired',-1);
  await quotaStage(quotaOwner,'quota-owner-expired',-1);
  check(await quotaCount(quotaOwner),1,'synthetic expired stage starts as one pending row');
  await quotaStage(quotaOwner,'quota-owner-0');
  check(await scalar("select count(*)::int as value from public.finance_import_previews where owner_id=$1::uuid and id='quota-owner-expired'",[quotaOwner]),0,'new stage removes only same-owner expired archives');
  check(await scalar("select count(*)::int as value from public.finance_import_previews where owner_id=$1::uuid and id='quota-foreign-expired'",[quotaForeign]),1,'same-owner cleanup never removes another owner expired archive');
  for(let index=1;index<5;index++) await quotaStage(quotaOwner,`quota-owner-${index}`);
  check(await quotaCount(quotaOwner),5,'five pending previews are permitted');
  for(let index=0;index<5;index++) await quotaStage(quotaForeign,`quota-foreign-${index}`);
  check(await quotaCount(quotaForeign),5,'another owner has its own independent five-preview quota');
  await assert.rejects(quotaStage(quotaOwner,'quota-owner-sixth'),error=>error.code==='P0001' && error.message==='Too many pending import previews'); assertions++;
  check(await quotaCount(quotaOwner),5,'sixth preview is denied without inserting anything');
  check(await quotaCount(quotaForeign),5,'foreign owner previews remain untouched by quota denial');
  const financeAfterQuota=await rows(`select public.alfred_accounting_source_version($1::uuid) as source,public.alfred_portability_native_version($1::uuid) as native,(select count(*)::int from public.accounting_states) as states,(select count(*)::int from public.accounting_events) as events,(select count(*)::int from public.finance_import_receipts) as receipts`,[quotaOwner]);
  check(financeAfterQuota,financeBeforeQuota,'expiry cleanup and quota denial never change finance, source, native or receipt records');
  await rows("update public.finance_import_previews set expires_at=now()-interval '1 minute' where owner_id=$1::uuid and id='quota-owner-0'",[quotaOwner]);
  await quotaStage(quotaOwner,'quota-owner-after-expiry');
  check(await quotaCount(quotaOwner),5,'expiring one preview frees exactly one slot');
  const simultaneous=await Promise.allSettled(Array.from({length:6},(_,index)=>quotaStage(quotaConcurrent,`quota-concurrent-${index}`)));
  check(simultaneous.filter(result=>result.status==='fulfilled').length,5,'six simultaneous submissions admit at most five previews');
  check(simultaneous.filter(result=>result.status==='rejected' && result.reason.message==='Too many pending import previews').length,1,'simultaneous excess submission receives the distinctive quota failure');
  check(await quotaCount(quotaConcurrent),5,'concurrent submission leaves the quota bounded');
  const lifecycleDefinition=await scalar("select pg_get_functiondef('public.alfred_bound_finance_import_previews()'::regprocedure) as value");
  check(lifecycleDefinition.includes('pg_advisory_xact_lock(hashtextextended(new.owner_id::text,81627))'),true,'staging uses the same owner transaction lock as accounting confirmation');

  // Client roles can read their own rows through RLS but cannot execute financial mutation RPCs.
  const privileges=await rows(`select has_function_privilege('authenticated','public.alfred_confirm_finance_import(uuid,text)','execute') as confirm, has_function_privilege('authenticated','public.alfred_undo_finance_import(uuid,text)','execute') as undo, has_table_privilege('authenticated','public.imported_finance_sources','insert') as source_insert, has_function_privilege('authenticated','public.alfred_resume_import_investment_notifications(uuid,text)','execute') as resume, has_table_privilege('authenticated','public.finance_import_native_origins','insert') as origin_insert`);
  check(privileges[0],{confirm:false,undo:false,source_insert:false,resume:false,origin_insert:false},'client roles have no mutation or RPC privileges');
  process.stdout.write(`Portability SQL: ${assertions} synthetic assertions passed.\n`);
} finally { await db.close(); }
