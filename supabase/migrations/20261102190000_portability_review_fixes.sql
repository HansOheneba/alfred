-- Forward-only review fixes for the already-published 1700/1800 schema.
-- Do not edit or re-run those migration files to install this change. No stored receipt hashes,
-- owner records, or import archives are rewritten. The original zero-argument lock remains
-- available for compatible older callers; current import operations use the owner-scoped ABI.
-- Apply this file and its ledger entry in one checked transaction on one connection.


create or replace function public.alfred_accounting_source_version(owner uuid)
returns text language plpgsql stable set search_path=public as $$
declare transactions_part text; messages_part text; imported_part text; rules_part text;
begin
  select coalesce((select jsonb_agg(to_jsonb(t) order by t.id)::text from public.transactions t where t.owner_id=owner),'[]') into transactions_part;
  select coalesce((select jsonb_agg(to_jsonb(b) order by b.id)::text from public.bank_messages b where b.owner_id=owner),'[]') into messages_part;
  select coalesce((select state::text from public.account_rule_states where owner_id=owner),'{}') into rules_part;
  if to_regclass('public.imported_finance_sources') is null then
    return md5(transactions_part || ':' || messages_part || ':' || rules_part);
  end if;
  execute 'select coalesce((select jsonb_agg(to_jsonb(i) order by i.movement_id)::text from public.imported_finance_sources i where i.owner_id=$1),''[]'')' into imported_part using owner;
  return md5(transactions_part || ':' || messages_part || ':' || imported_part || ':' || rules_part);
end $$;

create or replace function public.alfred_portability_native_version_v1(owner uuid)
returns text language sql stable set search_path=public as $$
select md5(jsonb_build_object(
  'profile',(select jsonb_build_object('preferred_name',preferred_name,'currency',currency,'timezone',timezone,
    'communication_preference',communication_preference,'financial_goals',financial_goals,'account_names',account_names,'updated_at',updated_at) from public.profiles where id=owner),
  'reminders',(select to_jsonb(r) from public.reminder_preferences r where owner_id=owner),
  'budgets',(select coalesce(jsonb_agg(to_jsonb(t) order by budget_id),'[]'::jsonb) from public.budgets t where owner_id=owner),
  'savings_goals',(select coalesce(jsonb_agg(to_jsonb(t) order by goal_id),'[]'::jsonb) from public.savings_goals t where owner_id=owner),
  'bills',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb) from public.bills t where owner_id=owner),
  'investments',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb) from public.investments t where owner_id=owner),
  'investment_holdings',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb) from public.investment_holdings t where owner_id=owner),
  'investment_values',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb) from public.investment_values t where owner_id=owner),
  'investment_contributions',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb) from public.investment_contributions t where owner_id=owner),
  'people',(select coalesce(jsonb_agg(to_jsonb(t) order by person_key),'[]'::jsonb) from public.people t where owner_id=owner),
  'payee_rules',(select coalesce(jsonb_agg(to_jsonb(t) order by payee_key),'[]'::jsonb) from public.payee_rules t where owner_id=owner),
  'about_me',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb) from public.about_me t where owner_id=owner),
  'messages',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb) from public.messages t where owner_id=owner),
  'loans',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb) from public.loans t where owner_id=owner),
  'accountRules',(select to_jsonb(t) from public.account_rule_states t where owner_id=owner),
  'origins',(select coalesce(jsonb_agg(to_jsonb(t) order by table_name,record_key),'[]'::jsonb) from public.finance_import_native_origins t where owner_id=owner)
)::text);
$$;

create or replace function public.alfred_portability_native_version(owner uuid)
returns text language sql stable set search_path=public as $$
select 'v2:' || md5(jsonb_build_object(
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

-- Persisted untagged hashes belong to the original full-field algorithm. Never rehash a
-- historical receipt using current data: doing so could authorize undo over a later real edit.
create or replace function public.alfred_portability_native_version_matches(owner uuid,expected text)
returns boolean language plpgsql stable set search_path=public as $$
begin
  if expected ~ '^[a-f0-9]{32}$' then
    return coalesce(public.alfred_portability_native_version_v1(owner)=expected,false);
  elsif expected ~ '^v2:[a-f0-9]{32}$' then
    return coalesce(public.alfred_portability_native_version(owner)=expected,false);
  end if;
  return false;
end $$;

-- Owner row locks protect inserts only while the corresponding immediate FK checks run.
-- Fail closed if a deployment has removed, deferred, left unvalidated, or disabled these guards.
create or replace function public.alfred_portability_native_foreign_keys_valid()
returns boolean language sql stable set search_path=public as $$
  select current_setting('session_replication_role')='origin' and not exists(
    select 1 from (values
    ('reminder_preferences','owner_id','profiles','id'),
    ('conversations','owner_id','profiles','id'),
    ('investments','owner_id','profiles','id'),
    ('investment_holdings','owner_id','profiles','id'),
    ('investment_values','owner_id','profiles','id'),
    ('investment_contributions','owner_id','profiles','id'),
    ('budgets','owner_id','profiles','id'),
    ('savings_goals','owner_id','profiles','id'),
    ('bills','owner_id','profiles','id'),
    ('people','owner_id','profiles','id'),
    ('payee_rules','owner_id','profiles','id'),
    ('about_me','owner_id','profiles','id'),
    ('messages','owner_id','profiles','id'),
    ('loans','owner_id','profiles','id'),
    ('account_rule_states','owner_id','profiles','id'),
    ('finance_import_native_origins','owner_id','profiles','id'),
    ('investment_holdings','investment_id','investments','id'),
    ('investment_values','investment_id','investments','id'),
    ('investment_contributions','investment_id','investments','id'),
    ('messages','conversation_id','conversations','id'),
    ('account_rule_events','owner_id','account_rule_states','owner_id')
    ) required(child_table,child_column,parent_table,parent_column)
    where not exists(
      select 1 from pg_constraint c
      where c.contype='f' and c.convalidated and not c.condeferrable
        and c.conrelid=to_regclass('public.'||required.child_table)
        and c.confrelid=to_regclass('public.'||required.parent_table)
        and c.conkey=array[(select a.attnum from pg_attribute a where a.attrelid=c.conrelid and a.attname=required.child_column and not a.attisdropped)]::smallint[]
        and c.confkey=array[(select a.attnum from pg_attribute a where a.attrelid=c.confrelid and a.attname=required.parent_column and not a.attisdropped)]::smallint[]
        and (select count(*) from pg_trigger t where t.tgconstraint=c.oid)=4
        and not exists(select 1 from pg_trigger t where t.tgconstraint=c.oid and (not t.tgisinternal or t.tgenabled not in ('O','A')))
    )
  );
$$;

create or replace function public.alfred_portability_lock_native(owner uuid)
returns void language plpgsql set search_path=public as $$
begin
  if not public.alfred_portability_native_foreign_keys_valid() then raise exception 'Portability native foreign-key guard is unavailable'; end if;
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
  perform 1 from public.messages m where m.owner_id=owner and exists(select 1 from public.finance_import_native_origins o where o.owner_id=owner and o.table_name='messages' and o.record_key=m.id::text) for update of m;
  perform 1 from public.loans where owner_id=owner for update;
  perform 1 from public.account_rule_states where owner_id=owner for update;
  perform 1 from public.finance_import_native_origins where owner_id=owner for update;
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
    update public.profiles set preferred_name=before_profile->>'preferred_name',currency=before_profile->>'currency',timezone=before_profile->>'timezone',communication_preference=before_profile->>'communication_preference',financial_goals=before_profile->>'financial_goals',updated_at=now() where id=owner;
  end if;
  if coalesce(receipt.native_plan->'reminderChanges','{}'::jsonb)<>'{}'::jsonb then
    if before_reminders is null or before_reminders='null'::jsonb then delete from public.reminder_preferences where owner_id=owner;
    else update public.reminder_preferences set morning_enabled=(before_reminders->>'morning_enabled')::boolean,commute_enabled=(before_reminders->>'commute_enabled')::boolean,evening_enabled=(before_reminders->>'evening_enabled')::boolean,morning_minute=(before_reminders->>'morning_minute')::smallint,commute_minute=(before_reminders->>'commute_minute')::smallint,evening_minute=(before_reminders->>'evening_minute')::smallint,updated_at=now() where owner_id=owner; end if;
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
  if not public.alfred_portability_native_version_matches(owner,stage.native_version) then return jsonb_build_object('status','native_changed'); end if;
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
  if not public.alfred_portability_native_version_matches(owner,receipt.native_after_version) then return jsonb_build_object('status','native_changed'); end if;
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

revoke all on function public.alfred_accounting_source_version(uuid) from public,anon,authenticated;
revoke all on function public.alfred_portability_native_version_v1(uuid) from public,anon,authenticated;
revoke all on function public.alfred_portability_native_version(uuid) from public,anon,authenticated;
revoke all on function public.alfred_portability_native_version_matches(uuid,text) from public,anon,authenticated;
revoke all on function public.alfred_portability_native_foreign_keys_valid() from public,anon,authenticated;
revoke all on function public.alfred_portability_lock_native(uuid) from public,anon,authenticated;
revoke all on function public.alfred_undo_import_native(uuid,public.finance_import_receipts) from public,anon,authenticated;
revoke all on function public.alfred_confirm_finance_import(uuid,text) from public,anon,authenticated;
revoke all on function public.alfred_undo_finance_import(uuid,text) from public,anon,authenticated;
revoke all on function public.alfred_resume_import_investment_notifications(uuid,text) from public,anon,authenticated;

-- Completion marker is stamped last, after all definitions and permission revokes succeed.
create or replace function public.alfred_portability_schema_20261102_v2()
returns text language sql immutable set search_path=public as $$ select 'alfred.finance-portability:20261102:v2'::text $$;
revoke all on function public.alfred_portability_schema_20261102_v2() from public,anon,authenticated;
comment on function public.alfred_portability_schema_20261102_v2() is 'alfred.finance-portability:20261102:v2';
