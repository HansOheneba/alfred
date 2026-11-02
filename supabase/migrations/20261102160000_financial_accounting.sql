-- Additive accounting registry. Not a backfill: historic provider labels do not identify real accounts.
-- The document is an owner-scoped aggregate; one locked revision commits account/link/audit changes together.
create or replace function public.alfred_accounting_document_valid(document jsonb, owner uuid)
returns boolean language plpgsql immutable set search_path = public as $$
declare item jsonb;
begin
  if jsonb_typeof(document) is distinct from 'object' or document->>'ownerId' is distinct from owner::text
    or jsonb_typeof(document->'revision') is distinct from 'number' or (document->>'revision')::numeric < 0
    or (document->>'revision')::numeric > 9007199254740991
    or (document->>'revision')::numeric <> trunc((document->>'revision')::numeric) then return false; end if;
  foreach item in array array[document->'accounts',document->'movements',document->'snapshots',document->'transfers',document->'settlements',document->'audit'] loop
    if item is null or jsonb_typeof(item) is distinct from 'array' or jsonb_array_length(item)>50000 then return false; end if;
  end loop;
  if jsonb_array_length(document->'audit')>50 then return false; end if;
  for item in select value from jsonb_array_elements(document->'movements') loop
    if item->>'ownerId' is distinct from owner::text or jsonb_typeof(item->'amountMinor') is distinct from 'number'
      or (item->>'amountMinor')::numeric <= 0 or (item->>'amountMinor')::numeric > 9007199254740991
      or (item->>'amountMinor')::numeric <> trunc((item->>'amountMinor')::numeric)
      or jsonb_typeof(item->'feeMinor') is distinct from 'number' or (item->>'feeMinor')::numeric < 0 or (item->>'feeMinor')::numeric > 9007199254740991
      or (item->>'feeMinor')::numeric <> trunc((item->>'feeMinor')::numeric)
      or item->>'currency' is null or item->>'currency' !~ '^[A-Z]{3}$' then return false; end if;
    if item->>'accountId' is not null and not exists(select 1 from jsonb_array_elements(document->'accounts') a where a->>'id'=item->>'accountId' and a->>'currency'=item->>'currency') then return false; end if;
  end loop;
  for item in select value from jsonb_array_elements(document->'snapshots') loop
    if not exists(select 1 from jsonb_array_elements(document->'accounts') a where a->>'id'=item->>'accountId') then return false; end if;
  end loop;
  return true;
exception when others then return false;
end $$;

create table if not exists public.accounting_states (
  owner_id uuid primary key references public.profiles(id) on delete cascade,
  revision bigint not null default 0 check(revision>=0),
  state jsonb not null,
  updated_at timestamptz not null default now(),
  constraint accounting_state_owner_and_shape check(public.alfred_accounting_document_valid(state,owner_id)),
  constraint accounting_state_revision check((state->>'revision')::bigint=revision)
);
create table if not exists public.accounting_events (
  owner_id uuid not null references public.accounting_states(owner_id) on delete cascade,
  revision bigint not null check(revision>0),
  request_id text not null check(request_id ~ '^[A-Za-z0-9_:.-]{1,200}$'),
  action_fingerprint text not null check(octet_length(action_fingerprint)<=65536),
  action text not null,
  before_state jsonb not null,
  after_state jsonb not null,
  created_at timestamptz not null default now(),
  primary key(owner_id,revision), unique(owner_id,request_id),
  constraint accounting_event_before_owner check(public.alfred_accounting_document_valid(before_state,owner_id)),
  constraint accounting_event_after_owner check(public.alfred_accounting_document_valid(after_state,owner_id))
);
alter table public.accounting_states enable row level security;
alter table public.accounting_events enable row level security;
revoke all on public.accounting_states, public.accounting_events from anon, authenticated;
grant select on public.accounting_states, public.accounting_events to authenticated;
create policy accounting_states_select_own on public.accounting_states for select to authenticated using(owner_id=auth.uid());
create policy accounting_events_select_own on public.accounting_events for select to authenticated using(owner_id=auth.uid());

-- Includes every raw field so edits/undo/date corrections invalidate an optimistic source read.
create or replace function public.alfred_accounting_source_version(owner uuid)
returns text language sql stable set search_path = public as $$
  select md5(coalesce((select jsonb_agg(to_jsonb(t) order by t.id)::text from public.transactions t where t.owner_id=owner),'[]') || ':' ||
    coalesce((select jsonb_agg(to_jsonb(b) order by b.id)::text from public.bank_messages b where b.owner_id=owner),'[]'));
$$;

-- Invoker-only, server role. A single SQL call supplies the transaction boundary; no pooled BEGIN/COMMIT.
create or replace function public.alfred_write_accounting_state(
  owner uuid, expected_revision bigint, request_key text, fingerprint text, source_version text, next_state jsonb
) returns jsonb language plpgsql set search_path = public as $$
declare current_state jsonb; current_revision bigint; event_fingerprint text; initial jsonb;
begin
  -- Serialize the owner's first insert as well as subsequent revisions.
  perform pg_advisory_xact_lock(hashtextextended(owner::text,81627));
  select state,revision into current_state,current_revision from public.accounting_states where owner_id=owner for update;
  select action_fingerprint into event_fingerprint from public.accounting_events where owner_id=owner and request_id=request_key;
  if found then
    if event_fingerprint<>fingerprint then return jsonb_build_object('status','conflict'); end if;
    return jsonb_build_object('status','duplicate','state',current_state);
  end if;
  if coalesce(current_revision,0)<>expected_revision then return jsonb_build_object('status','stale'); end if;
  -- Short shared locks prevent insert/update ingestion racing between source validation and commit.
  -- They are intentionally restricted to this atomic write, never held during network/model work.
  lock table public.transactions,public.bank_messages in share mode;
  if public.alfred_accounting_source_version(owner) is distinct from source_version then return jsonb_build_object('status','source_changed'); end if;
  if not public.alfred_accounting_document_valid(next_state,owner) or (next_state->>'revision')::bigint<>expected_revision+1
    or next_state#>>'{audit,-1,requestId}' is distinct from request_key
    or next_state#>>'{audit,-1,actionFingerprint}' is distinct from fingerprint
    or next_state#>>'{audit,-1,revision}' is distinct from (expected_revision+1)::text then
    raise exception 'Invalid accounting state';
  end if;
  initial=jsonb_build_object('ownerId',owner,'revision',0,'accounts','[]'::jsonb,'movements','[]'::jsonb,'snapshots','[]'::jsonb,'transfers','[]'::jsonb,'settlements','[]'::jsonb,'audit','[]'::jsonb);
  insert into public.accounting_states(owner_id,revision,state) values(owner,expected_revision+1,next_state)
    on conflict(owner_id) do update set revision=excluded.revision,state=excluded.state,updated_at=now();
  insert into public.accounting_events(owner_id,revision,request_id,action_fingerprint,action,before_state,after_state)
    values(owner,expected_revision+1,request_key,fingerprint,next_state#>>'{audit,-1,action}',coalesce(current_state,initial),next_state);
  return jsonb_build_object('status','saved','state',next_state);
end $$;
revoke all on function public.alfred_accounting_document_valid(jsonb,uuid) from public,anon,authenticated;
revoke all on function public.alfred_accounting_source_version(uuid) from public,anon,authenticated;
revoke all on function public.alfred_write_accounting_state(uuid,bigint,text,text,text,jsonb) from public,anon,authenticated;
