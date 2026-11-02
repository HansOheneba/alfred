-- Draft only. Owner-scoped, deterministic account categorisation; no historical backfill or ingestion setup.
create or replace function public.alfred_account_rule_document_valid(document jsonb, owner uuid)
returns boolean language plpgsql immutable set search_path=public as $$
declare item jsonb;
begin
  if jsonb_typeof(document) is distinct from 'object' or document->>'ownerId' is distinct from owner::text
    or jsonb_typeof(document->'revision') is distinct from 'number' or (document->>'revision')::numeric<0
    or (document->>'revision')::numeric>9007199254740991 or (document->>'revision')::numeric<>trunc((document->>'revision')::numeric)
    or jsonb_typeof(document->'rules') is distinct from 'array' or jsonb_array_length(document->'rules')>1000
    or jsonb_typeof(document->'bindings') is distinct from 'array' or jsonb_array_length(document->'bindings')>100 then return false; end if;
  for item in select value from jsonb_array_elements(document->'rules') loop
    perform (item->>'id')::uuid;
    if item->>'id' is null or jsonb_typeof(item->'accountId') is distinct from 'string' or char_length(item->>'accountId') not between 1 and 512
      or jsonb_typeof(item->'matchMode') is distinct from 'string' or item->>'matchMode' not in ('exact','all')
      or jsonb_typeof(item->'direction') is distinct from 'string' or item->>'direction' not in ('in','out','any')
      or jsonb_typeof(item->'category') is distinct from 'string' or char_length(trim(item->>'category')) not between 1 and 120 or jsonb_typeof(item->'active') is distinct from 'boolean'
      or jsonb_typeof(item->'priority') is distinct from 'number' or (item->>'priority')::numeric not between -1000 and 1000
      or (item->>'priority')::numeric<>trunc((item->>'priority')::numeric)
      or jsonb_typeof(item->'revision') is distinct from 'number' or (item->>'revision')::numeric<1
      or (item->>'revision')::numeric>9007199254740991 or (item->>'revision')::numeric<>trunc((item->>'revision')::numeric)
      or item->>'effectiveFrom' is null or item->>'createdAt' is null then return false; end if;
    perform (item->>'effectiveFrom')::timestamptz; perform (item->>'createdAt')::timestamptz;
    if item->>'matchMode'='exact' and (jsonb_typeof(item->'merchantExact') is distinct from 'string' or char_length(trim(item->>'merchantExact')) not between 1 and 2000) then return false; end if;
    if item->>'matchMode'='all' and item->'merchantExact' is distinct from 'null'::jsonb then return false; end if;
  end loop;
  if (select count(*) from jsonb_array_elements(document->'rules'))<>(select count(distinct value->>'id') from jsonb_array_elements(document->'rules'))
    or (select count(*) from jsonb_array_elements(document->'rules'))<>(select count(distinct jsonb_build_array(value->>'accountId',value->>'matchMode',value->>'merchantExact',value->>'direction')) from jsonb_array_elements(document->'rules')) then return false; end if;
  for item in select value from jsonb_array_elements(document->'bindings') loop
    perform (item->>'id')::uuid;
    if item->>'id' is null or jsonb_typeof(item->'accountId') is distinct from 'string' or char_length(item->>'accountId') not between 1 and 512
      or jsonb_typeof(item->'provider') is distinct from 'string' or char_length(trim(item->>'provider')) not between 1 and 120
      or item->>'accountSuffix' is null or item->>'accountSuffix' !~ '^\d{3,4}$' or item->>'currency' is null or item->>'currency' !~ '^[A-Z]{3}$'
      or jsonb_typeof(item->'active') is distinct from 'boolean' or jsonb_typeof(item->'revision') is distinct from 'number' or (item->>'revision')::numeric<1
      or (item->>'revision')::numeric>9007199254740991 or (item->>'revision')::numeric<>trunc((item->>'revision')::numeric)
      or item->>'createdAt' is null then return false; end if;
    perform (item->>'createdAt')::timestamptz;
  end loop;
  if (select count(*) from jsonb_array_elements(document->'bindings'))<>(select count(distinct value->>'id') from jsonb_array_elements(document->'bindings'))
    or (select count(*) from jsonb_array_elements(document->'bindings'))<>(select count(distinct jsonb_build_array(value->>'provider',value->>'accountSuffix',value->>'currency')) from jsonb_array_elements(document->'bindings')) then return false; end if;
  return true;
exception when others then return false;
end $$;

create table if not exists public.account_rule_states(
  owner_id uuid primary key references public.profiles(id) on delete cascade,
  revision bigint not null check(revision>=0), state jsonb not null, updated_at timestamptz not null default now(),
  check(public.alfred_account_rule_document_valid(state,owner_id)), check((state->>'revision')::bigint=revision)
);
create table if not exists public.account_rule_events(
  owner_id uuid not null references public.account_rule_states(owner_id) on delete cascade,
  revision bigint not null check(revision>0), request_id text not null check(request_id ~ '^[A-Za-z0-9_:.-]{1,200}$'),
  action_fingerprint text not null check(action_fingerprint ~ '^[a-f0-9]{64}$'), before_state jsonb not null, after_state jsonb not null,
  created_at timestamptz not null default now(), primary key(owner_id,revision), unique(owner_id,request_id),
  check(public.alfred_account_rule_document_valid(before_state,owner_id)), check(public.alfred_account_rule_document_valid(after_state,owner_id))
);
alter table public.account_rule_states enable row level security;
alter table public.account_rule_events enable row level security;
revoke all on public.account_rule_states,public.account_rule_events from public,anon,authenticated;
grant select on public.account_rule_states,public.account_rule_events to authenticated;
drop policy if exists account_rule_states_select_own on public.account_rule_states;
create policy account_rule_states_select_own on public.account_rule_states for select to authenticated using(owner_id=auth.uid());
drop policy if exists account_rule_events_select_own on public.account_rule_events;
create policy account_rule_events_select_own on public.account_rule_events for select to authenticated using(owner_id=auth.uid());

create or replace function public.alfred_write_account_rules(owner uuid,expected_revision bigint,request_key text,fingerprint text,next_state jsonb)
returns jsonb language plpgsql set search_path=public as $$
declare current_state jsonb; current_revision bigint; prior_fingerprint text; accounts jsonb; item jsonb; initial jsonb;
begin
  -- Same owner lock as accounting/imports: an account cannot disappear between validation and rule commit.
  perform pg_advisory_xact_lock(hashtextextended(owner::text,81627));
  select state,revision into current_state,current_revision from public.account_rule_states where owner_id=owner for update;
  select action_fingerprint into prior_fingerprint from public.account_rule_events where owner_id=owner and request_id=request_key;
  if found then
    if prior_fingerprint<>fingerprint then return jsonb_build_object('status','conflict'); end if;
    return jsonb_build_object('status','duplicate','state',current_state);
  end if;
  if coalesce(current_revision,0)<>expected_revision then return jsonb_build_object('status','stale'); end if;
  if not public.alfred_account_rule_document_valid(next_state,owner) or (next_state->>'revision')::bigint<>expected_revision+1 then raise exception 'Invalid account-rule state'; end if;
  select state->'accounts' into accounts from public.accounting_states where owner_id=owner for share;
  for item in select value from jsonb_array_elements(next_state->'rules') loop
    if not exists(select 1 from jsonb_array_elements(coalesce(accounts,'[]'::jsonb)) a where a->>'id'=item->>'accountId')
      and not exists(select 1 from jsonb_array_elements(coalesce(current_state->'rules','[]'::jsonb)) old where old->>'id'=item->>'id' and old->>'accountId'=item->>'accountId' and (old=item or item->>'active'='false'))
      then return jsonb_build_object('status','ownership'); end if;
  end loop;
  for item in select value from jsonb_array_elements(next_state->'bindings') loop
    if not exists(select 1 from jsonb_array_elements(coalesce(accounts,'[]'::jsonb)) a where a->>'id'=item->>'accountId' and a->>'currency'=item->>'currency')
      and not exists(select 1 from jsonb_array_elements(coalesce(current_state->'bindings','[]'::jsonb)) old where old=item)
      then return jsonb_build_object('status','ownership'); end if;
  end loop;
  initial=jsonb_build_object('ownerId',owner,'revision',0,'rules','[]'::jsonb,'bindings','[]'::jsonb);
  insert into public.account_rule_states(owner_id,revision,state) values(owner,expected_revision+1,next_state)
    on conflict(owner_id) do update set revision=excluded.revision,state=excluded.state,updated_at=now();
  insert into public.account_rule_events(owner_id,revision,request_id,action_fingerprint,before_state,after_state)
    values(owner,expected_revision+1,request_key,fingerprint,coalesce(current_state,initial),next_state);
  return jsonb_build_object('status','saved','state',next_state);
end $$;

-- The single definition of the accounting source version from here on. Imported historical
-- evidence joins the version once the portability table exists, so a later migration never
-- needs to redefine this function and re-applying this file cannot silently drop that evidence.
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
revoke all on function public.alfred_account_rule_document_valid(jsonb,uuid) from public,anon,authenticated;
revoke all on function public.alfred_write_account_rules(uuid,bigint,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.alfred_accounting_source_version(uuid) from public,anon,authenticated;


-- Completion marker: stamp only after all ABI objects and permission revokes succeeded.
-- Future incompatible schemas must use a new versioned marker name and token.
create or replace function public.alfred_account_rules_schema_20261102_v1()
returns text language sql immutable set search_path=public as $$ select 'alfred.account-rules:20261102:v1'::text $$;
revoke all on function public.alfred_account_rules_schema_20261102_v1() from public,anon,authenticated;
comment on function public.alfred_account_rules_schema_20261102_v1() is 'alfred.account-rules:20261102:v1';
