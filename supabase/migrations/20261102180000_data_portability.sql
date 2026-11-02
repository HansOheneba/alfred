-- Draft additive migration. Apply only after review; no external collection or bank setup is changed.
-- The application derives owner from its authenticated session. These invoker functions are server-only.
create table if not exists public.finance_import_previews (
  owner_id uuid not null references public.profiles(id) on delete cascade,
  id text not null check(id ~ '^[A-Za-z0-9_.:-]{1,160}$'),
  archive_id text not null check(archive_id ~ '^[a-f0-9]{64}$'),
  activation_of text check(activation_of is null or activation_of ~ '^[A-Za-z0-9_.:-]{1,160}$'),
  activation_key text check(activation_key is null or activation_key ~ '^[a-f0-9]{64}$'),
  source_version text not null,
  native_version text not null,
  native_plan jsonb not null default '{}'::jsonb,
  expected_revision bigint not null check(expected_revision >= 0),
  base_hash text not null,
  before_state jsonb not null,
  next_state jsonb not null,
  sources jsonb not null check(jsonb_typeof(sources) = 'array' and jsonb_array_length(sources) <= 50000),
  archive jsonb not null check(jsonb_typeof(archive) = 'object' and octet_length(archive::text) <= 67108864),
  summary jsonb not null check(jsonb_typeof(summary) = 'object'),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key(owner_id,id),
  constraint finance_preview_activation_pair check((activation_of is null)=(activation_key is null)),
  constraint finance_preview_before_valid check(public.alfred_accounting_document_valid(before_state,owner_id)),
  constraint finance_preview_next_valid check(public.alfred_accounting_document_valid(next_state,owner_id))
);
create index if not exists finance_import_previews_expiry on public.finance_import_previews(expires_at);

-- Bound unconfirmed sensitive archives per owner. The same lock used by confirmation
-- serializes simultaneous staging, cleanup, confirmation and undo for that owner.
create or replace function public.alfred_bound_finance_import_previews()
returns trigger language plpgsql set search_path=public as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(new.owner_id::text,81627));
  delete from public.finance_import_previews where owner_id=new.owner_id and expires_at<=now();
  if (select count(*) from public.finance_import_previews where owner_id=new.owner_id)>=5 then
    raise exception using errcode='P0001',message='Too many pending import previews';
  end if;
  return new;
end $$;
drop trigger if exists finance_import_previews_bound_before_insert on public.finance_import_previews;
create trigger finance_import_previews_bound_before_insert before insert on public.finance_import_previews
  for each row execute function public.alfred_bound_finance_import_previews();
revoke all on function public.alfred_bound_finance_import_previews() from public,anon,authenticated;


create table if not exists public.finance_import_receipts (
  owner_id uuid not null references public.profiles(id) on delete cascade,
  id text not null,
  archive_id text not null,
  activation_of text check(activation_of is null or activation_of ~ '^[A-Za-z0-9_.:-]{1,160}$'),
  activation_key text check(activation_key is null or activation_key ~ '^[a-f0-9]{64}$'),
  archive jsonb not null,
  summary jsonb not null,
  before_state jsonb not null,
  after_state jsonb not null,
  source_version_after text not null,
  native_plan jsonb not null default '{}'::jsonb,
  native_before jsonb not null default '{}'::jsonb,
  native_inserted jsonb not null default '{}'::jsonb,
  native_after_version text not null default '',
  imported_at timestamptz not null default now(),
  undone_at timestamptz,
  notifications_resumed_at timestamptz,
  primary key(owner_id,id),
  constraint finance_receipt_activation_pair check((activation_of is null)=(activation_key is null)),
  foreign key(owner_id,activation_of) references public.finance_import_receipts(owner_id,id),
  constraint finance_receipt_before_valid check(public.alfred_accounting_document_valid(before_state,owner_id)),
  constraint finance_receipt_after_valid check(public.alfred_accounting_document_valid(after_state,owner_id))
);
-- A safely undone import may be imported again through a fresh preview/receipt.
-- Original receipt IDs remain permanent idempotency keys; old retries never resurrect data.
create unique index if not exists finance_import_receipts_active_archive
  on public.finance_import_receipts(owner_id,archive_id) where undone_at is null and activation_of is null;
create unique index if not exists finance_import_receipts_active_activation
  on public.finance_import_receipts(owner_id,activation_key) where undone_at is null and activation_key is not null;

create table if not exists public.imported_finance_sources (
  owner_id uuid not null references public.profiles(id) on delete cascade,
  movement_id text not null,
  receipt_id text not null,
  movement jsonb not null check(jsonb_typeof(movement) = 'object'),
  primary key(owner_id,movement_id),
  foreign key(owner_id,receipt_id) references public.finance_import_receipts(owner_id,id),
  constraint imported_finance_source_owner check(movement->>'ownerId' = owner_id::text),
  constraint imported_finance_source_identity check(movement->>'id' = movement_id)
);

alter table public.finance_import_previews enable row level security;
alter table public.finance_import_receipts enable row level security;
alter table public.imported_finance_sources enable row level security;
revoke all on public.finance_import_previews, public.finance_import_receipts, public.imported_finance_sources from public, anon, authenticated;
grant select on public.finance_import_previews, public.finance_import_receipts, public.imported_finance_sources to authenticated;
drop policy if exists finance_import_previews_select_own on public.finance_import_previews;
create policy finance_import_previews_select_own on public.finance_import_previews for select to authenticated using(owner_id=auth.uid());
drop policy if exists finance_import_receipts_select_own on public.finance_import_receipts;
create policy finance_import_receipts_select_own on public.finance_import_receipts for select to authenticated using(owner_id=auth.uid());
drop policy if exists imported_finance_sources_select_own on public.imported_finance_sources;
create policy imported_finance_sources_select_own on public.imported_finance_sources for select to authenticated using(owner_id=auth.uid());

-- Native records reuse Alfred's existing feature tables. Connection identities and source ledger
-- tables are intentionally absent: accounting source evidence is imported once, through the core.
alter table public.investments add column if not exists import_notifications_paused boolean not null default false;
alter table public.investments add column if not exists import_cost_basis_unknown boolean not null default false;
create table if not exists public.finance_import_native_origins (
  owner_id uuid not null references public.profiles(id) on delete cascade,
  table_name text not null check(table_name in ('budgets','savings_goals','bills','investments','investment_holdings','investment_values','investment_contributions','people','payee_rules','about_me','messages','loans')),
  record_key text not null check(char_length(record_key) between 1 and 512),
  namespace text not null check(char_length(namespace) between 1 and 300),
  source_key text not null check(char_length(source_key) between 1 and 512),
  receipt_id text not null,
  primary key(owner_id,table_name,record_key),
  foreign key(owner_id,receipt_id) references public.finance_import_receipts(owner_id,id)
);
alter table public.finance_import_native_origins enable row level security;
revoke all on public.finance_import_native_origins from public,anon,authenticated;
grant select on public.finance_import_native_origins to authenticated;
drop policy if exists finance_import_native_origins_select_own on public.finance_import_native_origins;
create policy finance_import_native_origins_select_own on public.finance_import_native_origins for select to authenticated using(owner_id=auth.uid());

-- Row locks on this owner's records only. FOR UPDATE blocks concurrent edits and deletes, and
-- child inserts (their foreign-key KEY SHARE lock waits), without stalling other users' writes.
-- A concurrent insert that collides with an imported identity fails on its unique key instead.
create or replace function public.alfred_portability_lock_native(owner uuid)
returns void language plpgsql set search_path=public as $$
begin
  perform 1 from public.profiles where id=owner for update;
  perform 1 from public.reminder_preferences where owner_id=owner for update;
  perform 1 from public.conversations where owner_id=owner for update;
  perform 1 from public.investments where owner_id=owner for update;
  perform 1 from public.investment_holdings where owner_id=owner for update;
  perform 1 from public.investment_values where owner_id=owner for update;
  perform 1 from public.investment_contributions where owner_id=owner for update;
  perform 1 from public.budgets where owner_id=owner for update;
  perform 1 from public.savings_goals where owner_id=owner for update;
  perform 1 from public.bills where owner_id=owner for update;
  perform 1 from public.people where owner_id=owner for update;
  perform 1 from public.payee_rules where owner_id=owner for update;
  perform 1 from public.about_me where owner_id=owner for update;
  perform 1 from public.loans where owner_id=owner for update;
  perform 1 from public.account_rule_states where owner_id=owner for update;
  perform 1 from public.finance_import_native_origins where owner_id=owner for update;
end $$;

create or replace function public.alfred_portability_native_version(owner uuid)
returns text language sql stable set search_path=public as $$
select md5(jsonb_build_object(
  -- Only fields an import can write or undo restore. Bank ingest's account_names and bookkeeping
  -- timestamps change during ordinary use and must not invalidate a preview or block undo.
  'profile',(select jsonb_build_object('preferred_name',preferred_name,'currency',currency,'timezone',timezone,
    'communication_preference',communication_preference,'financial_goals',financial_goals) from public.profiles where id=owner),
  'reminders',(select to_jsonb(r) - 'updated_at' from public.reminder_preferences r where owner_id=owner),
  'budgets',(select coalesce(jsonb_agg(to_jsonb(t) order by budget_id),'[]'::jsonb) from public.budgets t where owner_id=owner),
  'savings_goals',(select coalesce(jsonb_agg(to_jsonb(t) order by goal_id),'[]'::jsonb) from public.savings_goals t where owner_id=owner),
  -- The reminder job stamps reminded_for/reminded_at and updated_at; those are delivery markers, not edits.
  'bills',(select coalesce(jsonb_agg(to_jsonb(t) - 'reminded_for' - 'updated_at' order by id),'[]'::jsonb) from public.bills t where owner_id=owner),
  'investments',(select coalesce(jsonb_agg(to_jsonb(t) - 'reminded_at' - 'updated_at' order by id),'[]'::jsonb) from public.investments t where owner_id=owner),
  'investment_holdings',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb) from public.investment_holdings t where owner_id=owner),
  'investment_values',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb) from public.investment_values t where owner_id=owner),
  'investment_contributions',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb) from public.investment_contributions t where owner_id=owner),
  'people',(select coalesce(jsonb_agg(to_jsonb(t) order by person_key),'[]'::jsonb) from public.people t where owner_id=owner),
  'payee_rules',(select coalesce(jsonb_agg(to_jsonb(t) order by payee_key),'[]'::jsonb) from public.payee_rules t where owner_id=owner),
  'about_me',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb) from public.about_me t where owner_id=owner),
  -- New chat messages are appended with fresh IDs and never collide with or alter imported ones.
  -- Only imported message rows are tracked, so chatting does not invalidate a preview or block undo.
  'messages',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb) from public.messages t where owner_id=owner and exists(select 1 from public.finance_import_native_origins o where o.owner_id=owner and o.table_name='messages' and o.record_key=t.id::text)),
  'loans',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb) from public.loans t where owner_id=owner),
  'accountRules',(select to_jsonb(t) from public.account_rule_states t where owner_id=owner),
  'origins',(select coalesce(jsonb_agg(to_jsonb(t) order by table_name,record_key),'[]'::jsonb) from public.finance_import_native_origins t where owner_id=owner)
)::text);
$$;

create or replace function public.alfred_apply_import_native(owner uuid, plan jsonb, receipt_key text)
returns jsonb language plpgsql set search_path=public as $$
declare
  allowed constant jsonb := '{"loans":["id","person","person_key","kind","amount","currency","occurred_at","note","bank_message_id","created_at"],"budgets":["budget_id","period","category","amount","currency","created_at","updated_at"],"savings_goals":["goal_id","name","target_amount","current_amount","currency","target_date","status","created_at","updated_at"],"bills":["id","name","next_date","amount","currency","cadence","active","reminded_for","created_at","updated_at"],"investments":["id","name","kind","provider","currency","invested_before","principal","rate","started_on","matures_on","reminded_at","payee_key","status","created_at","updated_at","import_notifications_paused","import_cost_basis_unknown"],"investment_holdings":["id","investment_id","symbol","quantity","cost","updated_at"],"investment_values":["id","investment_id","value","as_of","source","created_at"],"investment_contributions":["id","investment_id","amount","currency","occurred_on","bank_message_id","note","created_at"],"people":["person_key","name","note","updated_at"],"payee_rules":["payee_key","category","description","kind","updated_at"],"about_me":["id","note","account","created_at"],"messages":["id","channel","role","body","created_at","client_id","intent","meta"]}'::jsonb;
  table_key text; field text; item jsonb; inserted_row jsonb; inserted jsonb:='{}'::jsonb;
  profile_before jsonb; reminders_before jsonb; account_rules_before jsonb; account_rules_result jsonb; account_rules_existed boolean; cols text; selected text; identity_key text; origin jsonb; expected_origins int:=0;
  profile_changes jsonb:=coalesce(plan->'profileChanges','{}'::jsonb); reminder_changes jsonb:=coalesce(plan->'reminderChanges','{}'::jsonb); conversation uuid;
begin
  if jsonb_typeof(plan) is distinct from 'object' or jsonb_typeof(coalesce(plan->'tables','{}'::jsonb)) is distinct from 'object'
    or jsonb_typeof(profile_changes) is distinct from 'object' or jsonb_typeof(reminder_changes) is distinct from 'object'
    or jsonb_typeof(coalesce(plan->'origins','[]'::jsonb)) is distinct from 'array' then raise exception 'Invalid native import plan'; end if;
  if exists(select 1 from jsonb_object_keys(plan) k where k not in ('tables','profileChanges','reminderChanges','origins','accountRules'))
    or exists(select 1 from jsonb_object_keys(coalesce(plan->'tables','{}'::jsonb)) k where not (allowed ? k)) then raise exception 'Unsupported native import domain'; end if;
  if exists(select 1 from jsonb_object_keys(profile_changes) k where k not in ('preferred_name','currency','timezone','communication_preference','financial_goals'))
    or exists(select 1 from jsonb_object_keys(reminder_changes) k where k not in ('morning_enabled','commute_enabled','evening_enabled','morning_minute','commute_minute','evening_minute')) then raise exception 'Unsupported imported setting'; end if;
  foreach field in array array['morning_enabled','commute_enabled','evening_enabled'] loop
    if reminder_changes ? field and reminder_changes->field is distinct from 'false'::jsonb then raise exception 'Import cannot enable reminders'; end if;
  end loop;
  select jsonb_build_object('preferred_name',preferred_name,'currency',currency,'timezone',timezone,'communication_preference',communication_preference,'financial_goals',financial_goals,'updated_at',updated_at) into profile_before from public.profiles where id=owner;
  select to_jsonb(r) into reminders_before from public.reminder_preferences r where owner_id=owner;
  -- Parent records precede their child records; only these literal table names can reach EXECUTE.
  foreach table_key in array array['investments','budgets','savings_goals','bills','people','payee_rules','about_me','messages','loans','investment_holdings','investment_values','investment_contributions'] loop
    if jsonb_typeof(coalesce(plan->'tables'->table_key,'[]'::jsonb)) is distinct from 'array' or jsonb_array_length(coalesce(plan->'tables'->table_key,'[]'::jsonb))>50000 then raise exception 'Invalid native import rows'; end if;
    inserted=jsonb_set(inserted,array[table_key],'[]'::jsonb);
    for item in select value from jsonb_array_elements(coalesce(plan->'tables'->table_key,'[]'::jsonb)) loop
      if jsonb_typeof(item) is distinct from 'object' or exists(select 1 from jsonb_object_keys(item) k where not ((allowed->table_key) ? k)) then raise exception 'Unsupported native import column'; end if;
      identity_key=case table_key when 'budgets' then 'budget_id' when 'savings_goals' then 'goal_id' when 'people' then 'person_key' when 'payee_rules' then 'payee_key' else 'id' end;
      if coalesce(item->>identity_key,'')='' then raise exception 'Native import needs a stable identity'; end if;
      if table_key='loans' and item->>'bank_message_id' is not null then raise exception 'Imported loans cannot activate raw bank evidence'; end if;
      if table_key='about_me' and item->>'account' is not null then raise exception 'Import cannot configure managed account filtering'; end if;
      if table_key='bills' then
        if item->'active' is distinct from 'false'::jsonb or item->>'reminded_for' is not null then raise exception 'Imported bills must begin with reminders paused'; end if;
      end if;
      if table_key='investments' and item->'import_notifications_paused' is distinct from 'true'::jsonb then raise exception 'Imported investment notifications must be paused'; end if;
      if table_key in ('investment_holdings','investment_values','investment_contributions') and not exists(select 1 from public.investments i where i.id=(item->>'investment_id')::uuid and i.owner_id=owner) then raise exception 'Imported investment belongs to another owner or is missing'; end if;
      if table_key='investment_contributions' and item->>'bank_message_id' is not null and not exists(select 1 from public.bank_messages b where b.id=(item->>'bank_message_id')::uuid and b.owner_id=owner) then raise exception 'Imported bank evidence belongs to another owner or is missing'; end if;
      item=item || jsonb_build_object('owner_id',owner);
      if table_key in ('budgets','savings_goals') then item=item || jsonb_build_object('user_id',owner::text); end if;
      if table_key='messages' then
        select id into conversation from public.conversations where owner_id=owner;
        if conversation is null then raise exception 'Owner conversation is not ready'; end if;
        item=item || jsonb_build_object('conversation_id',conversation);
      end if;
      select string_agg(format('%I',key),',' order by key),string_agg(format('r.%I',key),',' order by key) into cols,selected from jsonb_object_keys(item) key;
      execute format('insert into public.%I as imported(%s) select %s from jsonb_populate_record(null::public.%I,$1) r returning to_jsonb(imported)',table_key,cols,selected,table_key) into inserted_row using item;
      inserted=jsonb_set(inserted,array[table_key],inserted->table_key || jsonb_build_array(inserted_row));
      expected_origins=expected_origins+1;
    end loop;
  end loop;
  if jsonb_array_length(coalesce(plan->'origins','[]'::jsonb))<>expected_origins then raise exception 'Every native row requires one provenance origin'; end if;
  for origin in select value from jsonb_array_elements(coalesce(plan->'origins','[]'::jsonb)) loop
    table_key=origin->>'table';
    identity_key=case table_key when 'budgets' then 'budget_id' when 'savings_goals' then 'goal_id' when 'people' then 'person_key' when 'payee_rules' then 'payee_key' else 'id' end;
    if not (allowed ? table_key) or not exists(select 1 from jsonb_array_elements(inserted->table_key) i where i->>identity_key=origin->>'recordKey') then raise exception 'Invalid native provenance reference'; end if;
    insert into public.finance_import_native_origins(owner_id,table_name,record_key,namespace,source_key,receipt_id) values(owner,table_key,origin->>'recordKey',origin->>'namespace',origin->>'sourceKey',receipt_key);
  end loop;
  if profile_changes<>'{}'::jsonb then
    update public.profiles set preferred_name=coalesce(profile_changes->>'preferred_name',preferred_name),currency=coalesce(profile_changes->>'currency',currency),timezone=coalesce(profile_changes->>'timezone',timezone),communication_preference=coalesce(profile_changes->>'communication_preference',communication_preference),financial_goals=coalesce(profile_changes->>'financial_goals',financial_goals),updated_at=now() where id=owner;
  end if;
  if reminder_changes<>'{}'::jsonb then
    insert into public.reminder_preferences(owner_id) values(owner) on conflict(owner_id) do nothing;
    update public.reminder_preferences set morning_enabled=coalesce((reminder_changes->>'morning_enabled')::boolean,morning_enabled),commute_enabled=coalesce((reminder_changes->>'commute_enabled')::boolean,commute_enabled),evening_enabled=coalesce((reminder_changes->>'evening_enabled')::boolean,evening_enabled),morning_minute=coalesce((reminder_changes->>'morning_minute')::smallint,morning_minute),commute_minute=coalesce((reminder_changes->>'commute_minute')::smallint,commute_minute),evening_minute=coalesce((reminder_changes->>'evening_minute')::smallint,evening_minute),updated_at=now() where owner_id=owner;
  end if;
  if plan ? 'accountRules' then
    if jsonb_typeof(plan->'accountRules') is distinct from 'object'
      or exists(select 1 from jsonb_object_keys(plan->'accountRules') k where k not in ('expectedRevision','state','requestId','fingerprint'))
      or jsonb_typeof(plan#>'{accountRules,expectedRevision}') is distinct from 'number'
      or plan#>>'{accountRules,requestId}' is distinct from 'import:'||receipt_key
      or coalesce(plan#>>'{accountRules,fingerprint}','') !~ '^[a-f0-9]{64}$'
      or not public.alfred_account_rule_document_valid(plan#>'{accountRules,state}',owner) then raise exception 'Invalid staged account-rule import'; end if;
    select state into account_rules_before from public.account_rule_states where owner_id=owner;
    account_rules_existed=found;
    if exists(select 1 from jsonb_array_elements(coalesce(account_rules_before->'rules','[]'::jsonb)) previous where not exists(select 1 from jsonb_array_elements(plan#>'{accountRules,state,rules}') incoming where incoming=previous))
      or exists(select 1 from jsonb_array_elements(coalesce(account_rules_before->'bindings','[]'::jsonb)) previous where not exists(select 1 from jsonb_array_elements(plan#>'{accountRules,state,bindings}') incoming where incoming=previous)) then raise exception 'Cannot overwrite existing account rules during import'; end if;
    account_rules_before=jsonb_build_object('existed',account_rules_existed,'state',coalesce(account_rules_before,jsonb_build_object('ownerId',owner,'revision',0,'rules','[]'::jsonb,'bindings','[]'::jsonb)));
    account_rules_result=public.alfred_write_account_rules(owner,(plan#>>'{accountRules,expectedRevision}')::bigint,plan#>>'{accountRules,requestId}',plan#>>'{accountRules,fingerprint}',plan#>'{accountRules,state}');
    if account_rules_result->>'status' not in ('saved','duplicate') or account_rules_result->'state' is distinct from plan#>'{accountRules,state}' then raise exception 'Account-rule import did not commit: %',account_rules_result->>'status'; end if;
  end if;
  return jsonb_build_object('before',jsonb_build_object('profile',profile_before,'reminderPreferences',reminders_before,'accountRules',account_rules_before),'inserted',inserted);
end $$;

create or replace function public.alfred_undo_import_native(owner uuid, receipt public.finance_import_receipts)
returns boolean language plpgsql set search_path=public as $$
declare table_key text; identity_key text; before_profile jsonb:=receipt.native_before->'profile'; before_reminders jsonb:=receipt.native_before->'reminderPreferences'; before_rules jsonb:=receipt.native_before#>'{accountRules,state}'; current_rule_revision bigint; restored_rules jsonb; rule_result jsonb;
begin
  -- Prevent a cascading delete from removing a foreign owner's dependent record, even if a
  -- separate application bug previously admitted a cross-owner investment relationship.
  if exists(select 1 from public.investment_holdings x where x.owner_id<>owner and exists(select 1 from jsonb_array_elements(coalesce(receipt.native_inserted->'investments','[]'::jsonb)) i where i->>'id'=x.investment_id::text))
    or exists(select 1 from public.investment_values x where x.owner_id<>owner and exists(select 1 from jsonb_array_elements(coalesce(receipt.native_inserted->'investments','[]'::jsonb)) i where i->>'id'=x.investment_id::text))
    or exists(select 1 from public.investment_contributions x where x.owner_id<>owner and exists(select 1 from jsonb_array_elements(coalesce(receipt.native_inserted->'investments','[]'::jsonb)) i where i->>'id'=x.investment_id::text)) then return false; end if;
  foreach table_key in array array['investment_contributions','investment_values','investment_holdings','loans','messages','about_me','payee_rules','people','bills','savings_goals','budgets','investments'] loop
    identity_key=case table_key when 'budgets' then 'budget_id' when 'savings_goals' then 'goal_id' when 'people' then 'person_key' when 'payee_rules' then 'payee_key' else 'id' end;
    execute format('delete from public.%I where owner_id=$1 and %I::text in (select value->>$3 from jsonb_array_elements($2))',table_key,identity_key) using owner,coalesce(receipt.native_inserted->table_key,'[]'::jsonb),identity_key;
  end loop;
  delete from public.finance_import_native_origins where owner_id=owner and receipt_id=receipt.id;
  if coalesce(receipt.native_plan->'profileChanges','{}'::jsonb)<>'{}'::jsonb then
    update public.profiles set preferred_name=before_profile->>'preferred_name',currency=before_profile->>'currency',timezone=before_profile->>'timezone',communication_preference=before_profile->>'communication_preference',financial_goals=before_profile->>'financial_goals',updated_at=(before_profile->>'updated_at')::timestamptz where id=owner;
  end if;
  if coalesce(receipt.native_plan->'reminderChanges','{}'::jsonb)<>'{}'::jsonb then
    if before_reminders is null or before_reminders='null'::jsonb then delete from public.reminder_preferences where owner_id=owner;
    else update public.reminder_preferences set morning_enabled=(before_reminders->>'morning_enabled')::boolean,commute_enabled=(before_reminders->>'commute_enabled')::boolean,evening_enabled=(before_reminders->>'evening_enabled')::boolean,morning_minute=(before_reminders->>'morning_minute')::smallint,commute_minute=(before_reminders->>'commute_minute')::smallint,evening_minute=(before_reminders->>'evening_minute')::smallint,updated_at=(before_reminders->>'updated_at')::timestamptz where owner_id=owner; end if;
  end if;
  if receipt.native_plan ? 'accountRules' then
    select revision into current_rule_revision from public.account_rule_states where owner_id=owner;
    if current_rule_revision is null or before_rules is null or before_rules='null'::jsonb then raise exception 'Imported account-rule history is missing'; end if;
    restored_rules=jsonb_set(before_rules,'{revision}',to_jsonb(current_rule_revision+1));
    rule_result=public.alfred_write_account_rules(owner,current_rule_revision,'undo-import:'||receipt.id||':account-rules',receipt.archive_id,restored_rules);
    if rule_result->>'status' not in ('saved','duplicate') or rule_result->'state' is distinct from restored_rules then raise exception 'Account-rule undo did not commit: %',rule_result->>'status'; end if;
  end if;
  return true;
end $$;

-- Imported historical evidence joins public.alfred_accounting_source_version automatically once
-- imported_finance_sources exists (defined in the account-rules migration). Neither a load nor a
-- normal classification rewrites this evidence.

create or replace function public.alfred_finance_import_receipt(receipt public.finance_import_receipts)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object('id',receipt.id,'archiveId',receipt.archive_id,'originalArchiveId',receipt.archive_id,'activationOf',receipt.activation_of,'activationKey',receipt.activation_key,'isActivation',receipt.activation_of is not null,'importedAt',receipt.imported_at,
    'counts',coalesce(receipt.summary->'counts','{}'::jsonb),'native',receipt.summary->'native','unsupported',coalesce(receipt.summary->'unsupported','[]'::jsonb),
    'undoAvailable',receipt.undone_at is null and receipt.notifications_resumed_at is null and not exists(select 1 from public.finance_import_receipts activation where activation.owner_id=receipt.owner_id and activation.activation_of=receipt.id and activation.undone_at is null),'undoneAt',receipt.undone_at,'notificationsResumedAt',receipt.notifications_resumed_at,
    'investmentNotificationsPaused',receipt.undone_at is null and exists(select 1 from public.investments i join public.finance_import_native_origins o on o.owner_id=i.owner_id and o.table_name='investments' and o.record_key=i.id::text where i.owner_id=receipt.owner_id and o.receipt_id=receipt.id and i.import_notifications_paused));
$$;

-- One call is one transaction. A failure cannot commit only one leg, link, source, or receipt.
create or replace function public.alfred_confirm_finance_import(owner uuid, preview_key text)
returns jsonb language plpgsql set search_path = public as $$
declare stage public.finance_import_previews; receipt public.finance_import_receipts; source_receipt public.finance_import_receipts; current_state jsonb;
  current_revision bigint; source jsonb; request_key text; native_result jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended(owner::text,81627));
  select * into stage from public.finance_import_previews where owner_id=owner and id=preview_key for update;
  if not found then
    select * into receipt from public.finance_import_receipts where owner_id=owner and id=preview_key;
    if found then return jsonb_build_object('status','duplicate','receipt',public.alfred_finance_import_receipt(receipt)); end if;
    return jsonb_build_object('status','missing');
  end if;
  if stage.activation_of is not null then
    select * into source_receipt from public.finance_import_receipts where owner_id=owner and id=stage.activation_of;
    if not found then return jsonb_build_object('status','missing_source'); end if;
    if source_receipt.undone_at is not null then return jsonb_build_object('status','source_undone'); end if;
    -- A new adapter activates the original stored archive, with its real identity intact.
    if source_receipt.activation_of is not null or source_receipt.archive_id is distinct from stage.archive_id
      or source_receipt.archive is distinct from stage.archive then return jsonb_build_object('status','conflict'); end if;
    select * into receipt from public.finance_import_receipts where owner_id=owner and activation_key=stage.activation_key and undone_at is null;
    if found then
      if receipt.activation_of is distinct from stage.activation_of or receipt.archive_id is distinct from stage.archive_id then return jsonb_build_object('status','conflict'); end if;
      return jsonb_build_object('status','duplicate','receipt',public.alfred_finance_import_receipt(receipt));
    end if;
  else
    select * into receipt from public.finance_import_receipts where owner_id=owner and archive_id=stage.archive_id and activation_of is null and undone_at is null;
    if found then return jsonb_build_object('status','duplicate','receipt',public.alfred_finance_import_receipt(receipt)); end if;
  end if;
  if stage.expires_at<=now() then return jsonb_build_object('status','expired'); end if;
  if coalesce((stage.summary->>'canConfirm')::boolean,false) is not true then return jsonb_build_object('status','conflict'); end if;
  select state,revision into current_state,current_revision from public.accounting_states where owner_id=owner for update;
  if coalesce(current_revision,0)<>stage.expected_revision then return jsonb_build_object('status','stale'); end if;
  -- Accounting writes use this same advisory lock. Source writers are blocked only during commit.
  lock table public.transactions,public.bank_messages in share mode;
  if public.alfred_accounting_source_version(owner) is distinct from stage.source_version then return jsonb_build_object('status','source_changed'); end if;
  perform public.alfred_portability_lock_native(owner);
  if public.alfred_portability_native_version(owner) is distinct from stage.native_version then return jsonb_build_object('status','native_changed'); end if;
  request_key='import:' || stage.id;
  if not public.alfred_accounting_document_valid(stage.next_state,owner)
    or (stage.before_state->>'revision')::bigint<>stage.expected_revision
    or (stage.next_state->>'revision')::bigint<>stage.expected_revision+1
    or stage.next_state#>>'{audit,-1,requestId}' is distinct from request_key
    or stage.next_state#>>'{audit,-1,actionFingerprint}' is distinct from stage.archive_id
    or stage.next_state#>>'{audit,-1,revision}' is distinct from (stage.expected_revision+1)::text then
    raise exception 'Invalid staged import document';
  end if;
  if exists(select 1 from jsonb_array_elements(stage.sources) s group by s->>'id' having count(*)>1) then
    raise exception 'Duplicate staged source identity';
  end if;
  for source in select value from jsonb_array_elements(stage.sources) loop
    if source->>'ownerId' is distinct from owner::text or source->>'id' is null
      or not exists(select 1 from jsonb_array_elements(stage.next_state->'movements') m where m=source)
      or exists(select 1 from public.imported_finance_sources i where i.owner_id=owner and i.movement_id=source->>'id') then
      raise exception 'Invalid staged source ownership or reference';
    end if;
  end loop;
  insert into public.finance_import_receipts(owner_id,id,archive_id,activation_of,activation_key,archive,summary,before_state,after_state,source_version_after)
    values(owner,stage.id,stage.archive_id,stage.activation_of,stage.activation_key,stage.archive,stage.summary,stage.before_state,stage.next_state,'pending') returning * into receipt;
  insert into public.accounting_states(owner_id,revision,state) values(owner,stage.expected_revision+1,stage.next_state)
    on conflict(owner_id) do update set revision=excluded.revision,state=excluded.state,updated_at=now();
  native_result=public.alfred_apply_import_native(owner,stage.native_plan,stage.id);
  update public.finance_import_receipts set native_plan=stage.native_plan,native_before=native_result->'before',native_inserted=native_result->'inserted',native_after_version=public.alfred_portability_native_version(owner) where owner_id=owner and id=stage.id;
  insert into public.imported_finance_sources(owner_id,movement_id,receipt_id,movement)
    select owner,value->>'id',stage.id,value from jsonb_array_elements(stage.sources);
  insert into public.accounting_events(owner_id,revision,request_id,action_fingerprint,action,before_state,after_state)
    values(owner,stage.expected_revision+1,request_key,stage.archive_id,'import',stage.before_state,stage.next_state);
  update public.finance_import_receipts set source_version_after=public.alfred_accounting_source_version(owner)
    where owner_id=owner and id=stage.id returning * into receipt;
  delete from public.finance_import_previews where owner_id=owner and id=stage.id;
  return jsonb_build_object('status','saved','receipt',public.alfred_finance_import_receipt(receipt));
end $$;

-- Conservative undo: any later financial edit or new source blocks this operation. It never
-- restores an old aggregate over later work, even when the edit concerns an unrelated movement.
create or replace function public.alfred_undo_finance_import(owner uuid, receipt_key text)
returns jsonb language plpgsql set search_path = public as $$
declare receipt public.finance_import_receipts; current_state jsonb; current_revision bigint; restored jsonb;
  event jsonb; bounded_audit jsonb; request_key text;
begin
  perform pg_advisory_xact_lock(hashtextextended(owner::text,81627));
  select * into receipt from public.finance_import_receipts where owner_id=owner and id=receipt_key for update;
  if not found then return jsonb_build_object('status','missing'); end if;
  if receipt.undone_at is not null then return jsonb_build_object('status','duplicate','receipt',public.alfred_finance_import_receipt(receipt)); end if;
  if exists(select 1 from public.finance_import_receipts activation where activation.owner_id=owner and activation.activation_of=receipt.id and activation.undone_at is null) then return jsonb_build_object('status','activation_active'); end if;
  if receipt.notifications_resumed_at is not null then return jsonb_build_object('status','native_changed'); end if;
  select state,revision into current_state,current_revision from public.accounting_states where owner_id=owner for update;
  if current_state is distinct from receipt.after_state then return jsonb_build_object('status','stale'); end if;
  lock table public.transactions,public.bank_messages in share mode;
  if public.alfred_accounting_source_version(owner) is distinct from receipt.source_version_after then return jsonb_build_object('status','source_changed'); end if;
  perform public.alfred_portability_lock_native(owner);
  if public.alfred_portability_native_version(owner) is distinct from receipt.native_after_version then return jsonb_build_object('status','native_changed'); end if;
  if not public.alfred_undo_import_native(owner,receipt) then return jsonb_build_object('status','native_changed'); end if;
  request_key='undo-import:' || receipt.id;
  event=jsonb_build_object('id',request_key,'requestId',request_key,'action','undo_import','actionFingerprint',receipt.archive_id,
    'at',to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'revision',current_revision+1,
    'before',current_state - 'ownerId' - 'revision' - 'audit');
  select coalesce(jsonb_agg(value order by ordinal),'[]'::jsonb) into bounded_audit
    from jsonb_array_elements(current_state->'audit') with ordinality as items(value,ordinal)
    where ordinal>greatest(jsonb_array_length(current_state->'audit')-49,0);
  restored=jsonb_set(jsonb_set(receipt.before_state,'{revision}',to_jsonb(current_revision+1)),'{audit}',bounded_audit || jsonb_build_array(event));
  if not public.alfred_accounting_document_valid(restored,owner) then raise exception 'Invalid undo import document'; end if;
  delete from public.imported_finance_sources where owner_id=owner and receipt_id=receipt.id;
  update public.accounting_states set revision=current_revision+1,state=restored,updated_at=now() where owner_id=owner;
  insert into public.accounting_events(owner_id,revision,request_id,action_fingerprint,action,before_state,after_state)
    values(owner,current_revision+1,request_key,receipt.archive_id,'undo_import',current_state,restored);
  update public.finance_import_receipts set undone_at=now() where owner_id=owner and id=receipt.id returning * into receipt;
  return jsonb_build_object('status','saved','receipt',public.alfred_finance_import_receipt(receipt));
end $$;

revoke all on function public.alfred_finance_import_receipt(public.finance_import_receipts) from public, anon, authenticated;
revoke all on function public.alfred_confirm_finance_import(uuid,text) from public, anon, authenticated;
revoke all on function public.alfred_undo_finance_import(uuid,text) from public, anon, authenticated;
revoke all on function public.alfred_accounting_source_version(uuid) from public, anon, authenticated;

revoke all on function public.alfred_portability_lock_native(uuid) from public,anon,authenticated;
revoke all on function public.alfred_portability_native_version(uuid) from public,anon,authenticated;
revoke all on function public.alfred_apply_import_native(uuid,jsonb,text) from public,anon,authenticated;
revoke all on function public.alfred_undo_import_native(uuid,public.finance_import_receipts) from public,anon,authenticated;

-- This explicit receipt action is the only import flow that re-enables investment alerts.
-- It is a later edit; leaving the receipt's old version unchanged makes undo fail safely.
create or replace function public.alfred_resume_import_investment_notifications(owner uuid, receipt_key text)
returns jsonb language plpgsql set search_path=public as $$
declare receipt public.finance_import_receipts; resumed int;
begin
  perform pg_advisory_xact_lock(hashtextextended(owner::text,81627));
  select * into receipt from public.finance_import_receipts where owner_id=owner and id=receipt_key for update;
  if not found then return jsonb_build_object('status','missing'); end if;
  if receipt.undone_at is not null then return jsonb_build_object('status','undone'); end if;
  perform public.alfred_portability_lock_native(owner);
  update public.investments i set import_notifications_paused=false,updated_at=now()
    where i.owner_id=owner and i.import_notifications_paused and exists(select 1 from public.finance_import_native_origins o where o.owner_id=owner and o.table_name='investments' and o.record_key=i.id::text and o.receipt_id=receipt.id);
  get diagnostics resumed = row_count;
  if resumed>0 then update public.finance_import_receipts set notifications_resumed_at=now() where owner_id=owner and id=receipt.id; end if;
  return jsonb_build_object('status','saved','resumed',resumed);
end $$;
revoke all on function public.alfred_resume_import_investment_notifications(uuid,text) from public,anon,authenticated;


-- Completion marker: stamp only after all ABI objects and permission revokes succeeded.
-- Apply this file and its migration-ledger record in one checked transaction.
create or replace function public.alfred_portability_schema_20261102_v1()
returns text language sql immutable set search_path=public as $$ select 'alfred.finance-portability:20261102:v1'::text $$;
revoke all on function public.alfred_portability_schema_20261102_v1() from public,anon,authenticated;
comment on function public.alfred_portability_schema_20261102_v1() is 'alfred.finance-portability:20261102:v1';
