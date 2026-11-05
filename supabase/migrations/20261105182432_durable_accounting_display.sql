-- Additive, server-only accounting display projection. Review before deployment.
-- No financial writer/validator/hash ABI is replaced. Apply as one transaction.
-- Source writers append immutable invalidations; ONLY readers/workers touch jobs.
create schema alfred_display;
revoke all on schema alfred_display from public,anon,authenticated;

create table alfred_display.clock(
  singleton boolean primary key default true check(singleton),
  epoch bigint not null default 0 check(epoch>=0),
  schema_version text not null default 'accounting-display-v1'
);
insert into alfred_display.clock default values;
create table alfred_display.dirty_events(
  id bigint generated always as identity primary key,
  owner_id uuid not null,
  transaction_id bigint not null,
  created_at timestamptz not null default clock_timestamp(),
  unique(owner_id,transaction_id)
);
create index display_dirty_owner on alfred_display.dirty_events(owner_id,id);
-- Guards against accidentally running a builder in an enclosing financial
-- transaction. The worker-wide claim has no owner yet, so it needs this index.
create index display_dirty_transaction on alfred_display.dirty_events(transaction_id,owner_id);
create table alfred_display.publications(
  owner_id uuid primary key references auth.users(id) on delete cascade,
  definition text,
  token bigint not null default 0 check(token>=0),
  publish_revision bigint not null default 0 check(publish_revision>=0),
  epoch bigint not null default -1 check(epoch>=-1),
  manifest jsonb,
  updated_at timestamptz not null default clock_timestamp()
);
create table alfred_display.rows(
  owner_id uuid not null references alfred_display.publications(owner_id) on delete cascade,
  definition text not null check(definition~'^[A-Za-z0-9_.:-]{1,96}$'),
  token bigint not null check(token>=0),epoch bigint not null check(epoch>=0),
  kind text not null check(kind in ('movement','snapshot','transfer','settlement','return','evidence','ledger')),
  id text not null check(length(id) between 1 and 4096),
  ordinal bigint not null check(ordinal between 0 and 9007199254740991),
  account_id text,date text,currency text,category text,direction text,status text,
  amount_minor bigint check(amount_minor between -9007199254740991 and 9007199254740991),
  search_text text not null default '',
  rank_date_asc integer,rank_date_desc integer,rank_amount_asc integer,rank_amount_desc integer,
  needs_attention boolean not null default false,group_key text,relation_id text,
  payload jsonb not null check(jsonb_typeof(payload)='object'),
  primary key(owner_id,definition,kind,ordinal)
);
create index display_rows_id on alfred_display.rows using hash(id);
create index display_rows_date_asc on alfred_display.rows(owner_id,definition,kind,rank_date_asc);
create index display_rows_date_desc on alfred_display.rows(owner_id,definition,kind,rank_date_desc);
create index display_rows_amount_asc on alfred_display.rows(owner_id,definition,kind,rank_amount_asc);
create index display_rows_amount_desc on alfred_display.rows(owner_id,definition,kind,rank_amount_desc);
create index display_rows_relation on alfred_display.rows(owner_id,definition,kind,relation_id);
create table alfred_display.jobs(
  owner_id uuid primary key references auth.users(id) on delete cascade,
  desired_definition text not null check(desired_definition~'^[A-Za-z0-9_.:-]{1,96}$'),
  lease_definition text,lease_token uuid,lease_until timestamptz,
  due_at timestamptz not null default clock_timestamp(),
  requested_at timestamptz not null default clock_timestamp(),
  attempts integer not null default 0 check(attempts between 0 and 1000000),
  last_completed_at timestamptz,last_failed_at timestamptz,last_error_code text,
  check((lease_token is null and lease_until is null and lease_definition is null) or
    (lease_token is not null and lease_until is not null and lease_definition is not null))
);
create index display_jobs_due on alfred_display.jobs(desired_definition,due_at,lease_until);
create table alfred_display.worker_health(
  singleton boolean primary key default true check(singleton),
  last_worker_at timestamptz,last_published_at timestamptz,last_failed_at timestamptz
);
insert into alfred_display.worker_health default values;
create table alfred_display.contracts(signature text primary key,body_hash text not null,owner_oid oid not null);

do $permissions$
declare name text;
begin
  foreach name in array array['clock','dirty_events','publications','rows','jobs','worker_health','contracts'] loop
    execute format('alter table alfred_display.%I enable row level security',name);
  end loop;
end $permissions$;
revoke all on all tables in schema alfred_display from public,anon,authenticated;
revoke all on all sequences in schema alfred_display from public,anon,authenticated;

create function alfred_display.changed() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if TG_OP='INSERT' then
    insert into alfred_display.dirty_events(owner_id,transaction_id)
      select distinct owner_id,txid_current() from display_new where owner_id is not null
      on conflict(owner_id,transaction_id) do nothing;
  elsif TG_OP='DELETE' then
    insert into alfred_display.dirty_events(owner_id,transaction_id)
      select distinct owner_id,txid_current() from display_old where owner_id is not null
      on conflict(owner_id,transaction_id) do nothing;
  else
    insert into alfred_display.dirty_events(owner_id,transaction_id)
      select owner_id,txid_current() from (
        select owner_id from display_old union select owner_id from display_new
      ) owners where owner_id is not null on conflict(owner_id,transaction_id) do nothing;
  end if;
  return null;
end $$;
create function alfred_display.truncated() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  update alfred_display.clock set epoch=epoch+1 where singleton;
  return null;
end $$;

do $triggers$
declare relation text;
begin
  foreach relation in array array['transactions','bank_messages','imported_finance_sources','account_rule_states','accounting_states'] loop
    execute format('create trigger display_insert after insert on public.%I referencing new table as display_new for each statement execute function alfred_display.changed()',relation);
    execute format('create trigger display_update after update on public.%I referencing old table as display_old new table as display_new for each statement execute function alfred_display.changed()',relation);
    execute format('create trigger display_delete after delete on public.%I referencing old table as display_old for each statement execute function alfred_display.changed()',relation);
    execute format('create trigger display_truncate after truncate on public.%I for each statement execute function alfred_display.truncated()',relation);
  end loop;
end $triggers$;

create function alfred_display.readiness() returns boolean
language sql stable security invoker set search_path='' as $$
select exists(select 1 from alfred_display.clock where singleton and schema_version='accounting-display-v1')
and current_setting('session_replication_role')='origin'
and not exists(
  select 1 from (values
    ('alfred_display.changed()'),('alfred_display.truncated()'),('alfred_display.readiness()'),
    ('alfred_display.manifest(uuid,text)'),('alfred_display.enqueue(uuid,text)'),
    ('alfred_display.claim(text,uuid,integer)'),('alfred_display.claim_owner(uuid,text,uuid,integer)'),('alfred_display.capture(uuid,text,uuid)'),
    ('alfred_display.publish(uuid,text,uuid,jsonb,jsonb,jsonb)'),('alfred_display.fail(uuid,uuid,text)'),
    ('alfred_display.status()'),('alfred_display.cleanup(integer)')
  ) expected(signature)
  left join alfred_display.contracts k on k.signature=expected.signature
  left join pg_catalog.pg_proc p on p.oid=pg_catalog.to_regprocedure(expected.signature)
  where k.signature is null or p.oid is null or md5(pg_catalog.pg_get_functiondef(p.oid))<>k.body_hash
    or p.proowner<>k.owner_oid or p.prosecdef
    or has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE')
) and not exists(
  select 1 from (values('transactions'),('bank_messages'),('imported_finance_sources'),('account_rule_states'),('accounting_states')) relations(name)
  cross join (values('display_insert',4,'','display_new','changed'),('display_update',16,'display_old','display_new','changed'),
    ('display_delete',8,'display_old','','changed'),('display_truncate',32,'','','truncated')) expected(name,kind,old_table,new_table,procedure)
  where not exists(select 1 from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid=t.tgrelid
    where t.tgrelid=pg_catalog.to_regclass('public.'||relations.name) and c.relkind='r' and not c.relhassubclass
      and t.tgname=expected.name and t.tgtype=expected.kind and not t.tgisinternal and not t.tgdeferrable
      and t.tgfoid=pg_catalog.to_regprocedure('alfred_display.'||expected.procedure||'()')
      and t.tgenabled in ('O','A') and t.tgnargs=0 and t.tgqual is null
      and coalesce(t.tgoldtable,'')=expected.old_table and coalesce(t.tgnewtable,'')=expected.new_table)
);
$$;

create function alfred_display.manifest(owner uuid,p_definition text) returns jsonb
language sql stable security invoker set search_path='' as $$
select jsonb_build_object('token',p.token::text,'epoch',p.epoch::text,'manifest',p.manifest)
from alfred_display.publications p cross join alfred_display.clock c
where p.owner_id=owner and p.definition=p_definition and p.manifest is not null
  and p.epoch=c.epoch and c.singleton and alfred_display.readiness()
  and not exists(select 1 from alfred_display.dirty_events e where e.owner_id=owner);
$$;

create function alfred_display.enqueue(owner uuid,p_definition text) returns jsonb
language plpgsql security invoker set search_path='' as $$
begin
  if not alfred_display.readiness() then return jsonb_build_object('status','not_ready'); end if;
  if exists(select 1 from alfred_display.dirty_events where owner_id=owner and transaction_id=txid_current())
    then return jsonb_build_object('status','not_ready'); end if;
  if p_definition is null or p_definition!~'^[A-Za-z0-9_.:-]{1,96}$' then return jsonb_build_object('status','invalid'); end if;
  if not exists(select 1 from auth.users where id=owner) then return jsonb_build_object('status','owner_missing'); end if;
  insert into alfred_display.jobs(owner_id,desired_definition) values(owner,p_definition)
    on conflict(owner_id) do update set desired_definition=excluded.desired_definition,requested_at=clock_timestamp(),
      due_at=case when alfred_display.jobs.desired_definition<>excluded.desired_definition then clock_timestamp()
        when alfred_display.jobs.last_error_code is not null then alfred_display.jobs.due_at
        else least(alfred_display.jobs.due_at,clock_timestamp()) end,
      attempts=case when alfred_display.jobs.desired_definition<>excluded.desired_definition then 0 else alfred_display.jobs.attempts end,
      last_error_code=case when alfred_display.jobs.desired_definition<>excluded.desired_definition then null else alfred_display.jobs.last_error_code end;
  return jsonb_build_object('status','queued');
end $$;

create function alfred_display.cleanup(p_limit integer) returns integer
language plpgsql security invoker set search_path='' as $$
declare removed integer;
begin
  if p_limit<1 or p_limit>1000 or p_limit is null then return 0; end if;
  with owners as (
    select distinct e.owner_id from alfred_display.dirty_events e
      where not exists(select 1 from auth.users u where u.id=e.owner_id) limit p_limit
  ) delete from alfred_display.dirty_events e using owners o where e.owner_id=o.owner_id;
  get diagnostics removed=row_count;
  return removed;
end $$;

create function alfred_display.claim(p_definition text,p_lease_token uuid,p_lease_seconds integer) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare job alfred_display.jobs%rowtype;
begin
  if not alfred_display.readiness() or p_lease_token is null or p_definition is null
    or p_definition!~'^[A-Za-z0-9_.:-]{1,96}$' or p_lease_seconds<10 or p_lease_seconds>300 or p_lease_seconds is null then return null; end if;
  if exists(select 1 from alfred_display.dirty_events where transaction_id=txid_current()) then return null; end if;
  perform alfred_display.cleanup(100);
  -- Discover existing invalidations after commit. Source triggers never touch jobs.
  insert into alfred_display.jobs(owner_id,desired_definition)
    select distinct e.owner_id,p_definition from alfred_display.dirty_events e join auth.users u on u.id=e.owner_id
    where not exists(select 1 from alfred_display.jobs j where j.owner_id=e.owner_id)
    order by e.owner_id limit 100 on conflict(owner_id) do nothing;
  with waking as (
    select j.owner_id from alfred_display.jobs j
    where j.desired_definition=p_definition and j.due_at='infinity'::timestamptz
      and (exists(select 1 from alfred_display.dirty_events e where e.owner_id=j.owner_id)
        or exists(select 1 from alfred_display.publications p cross join alfred_display.clock c
          where p.owner_id=j.owner_id and c.singleton and p.epoch<>c.epoch))
    order by j.owner_id for update of j skip locked limit 100
  ) update alfred_display.jobs j set due_at=clock_timestamp() from waking w where j.owner_id=w.owner_id;
  select * into job from alfred_display.jobs
    where desired_definition=p_definition and due_at<=clock_timestamp()
      and (lease_token is null or lease_until<=clock_timestamp())
    order by due_at,requested_at,owner_id for update skip locked limit 1;
  if not found then
    update alfred_display.worker_health set last_worker_at=clock_timestamp() where singleton;
    return null;
  end if;
  if job.lease_token=p_lease_token then return null; end if;
  update alfred_display.jobs set lease_token=p_lease_token,lease_definition=p_definition,
    lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),
    attempts=least(attempts+1,1000000) where owner_id=job.owner_id returning * into job;
  -- All claim paths follow job -> heartbeat order, as do publish/fail. Never
  -- hold the shared heartbeat while waiting for an inline reader's job row.
  update alfred_display.worker_health set last_worker_at=clock_timestamp() where singleton;
  return jsonb_build_object('ownerId',job.owner_id,'definition',job.desired_definition,'leaseToken',job.lease_token,
    'leaseUntil',job.lease_until,'attempts',job.attempts);
end $$;

-- Inline rebuilds may claim only their authenticated owner. They must never take
-- unrelated work merely because another owner's job sorts first in the queue.
create function alfred_display.claim_owner(owner uuid,p_definition text,p_lease_token uuid,p_lease_seconds integer) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare job alfred_display.jobs%rowtype;
begin
  if not alfred_display.readiness() or p_lease_token is null or p_definition is null
    or p_definition!~'^[A-Za-z0-9_.:-]{1,96}$' or p_lease_seconds<10 or p_lease_seconds>300 or p_lease_seconds is null then return null; end if;
  if exists(select 1 from alfred_display.dirty_events where owner_id=owner and transaction_id=txid_current()) then return null; end if;
  select * into job from alfred_display.jobs
    where owner_id=owner
    for update skip locked;
  if not found then
    -- A visible but locked job is already being published/claimed. Do not
    -- defeat SKIP LOCKED by first upserting that same row in enqueue().
    if exists(select 1 from alfred_display.jobs where owner_id=owner) then return null; end if;
    if not exists(select 1 from auth.users where id=owner) then return null; end if;
    insert into alfred_display.jobs(owner_id,desired_definition) values(owner,p_definition) on conflict(owner_id) do nothing;
    select * into job from alfred_display.jobs where owner_id=owner for update skip locked;
    if not found then return null; end if;
  end if;
  -- enqueue is now applied only after obtaining the owner job lock ourselves.
  perform alfred_display.enqueue(owner,p_definition);
  select * into job from alfred_display.jobs where owner_id=owner;
  if job.due_at>clock_timestamp() or (job.lease_token is not null and job.lease_until>clock_timestamp()) then
    update alfred_display.worker_health set last_worker_at=clock_timestamp() where singleton;
    return null;
  end if;
  if job.lease_token=p_lease_token then return null; end if;
  update alfred_display.jobs set lease_token=p_lease_token,lease_definition=p_definition,
    lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),attempts=least(attempts+1,1000000)
    where owner_id=owner returning * into job;
  update alfred_display.worker_health set last_worker_at=clock_timestamp() where singleton;
  return jsonb_build_object('ownerId',job.owner_id,'definition',job.desired_definition,'leaseToken',job.lease_token,
    'leaseUntil',job.lease_until,'attempts',job.attempts);
end $$;

create function alfred_display.capture(owner uuid,p_definition text,p_lease_token uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare result jsonb;
begin
  if not alfred_display.readiness() then return null; end if;
  if exists(select 1 from alfred_display.dirty_events where owner_id=owner and transaction_id=txid_current()) then return null; end if;
  if not exists(select 1 from alfred_display.jobs where owner_id=owner and desired_definition=p_definition
    and lease_definition=p_definition and lease_token=p_lease_token and lease_until>clock_timestamp()) then return null; end if;
  insert into alfred_display.publications(owner_id) values(owner) on conflict do nothing;
  select jsonb_build_object('token',p.token::text,'publishRevision',p.publish_revision::text,'epoch',c.epoch::text,'events',coalesce((
    select jsonb_agg(e.id::text order by e.id) from alfred_display.dirty_events e where e.owner_id=owner
  ),'[]'::jsonb)) into result
  from alfred_display.publications p cross join alfred_display.clock c cross join alfred_display.jobs j
  where p.owner_id=owner and c.singleton and j.owner_id=owner and j.desired_definition=p_definition
    and j.lease_definition=p_definition and j.lease_token=p_lease_token and j.lease_until>clock_timestamp();
  return result;
end $$;

create function alfred_display.publish(owner uuid,p_definition text,p_lease_token uuid,baseline jsonb,p_manifest jsonb,p_rows jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare job alfred_display.jobs%rowtype; current_token bigint; current_revision bigint; current_epoch bigint; captured bigint[];
  row_count integer; kind_name text;
begin
  if not alfred_display.readiness() then return jsonb_build_object('status','not_ready'); end if;
  -- A marker coalesces every write by this transaction. Consuming it before
  -- that transaction ends could hide a later write, so never publish here.
  if exists(select 1 from alfred_display.dirty_events where owner_id=owner and transaction_id=txid_current())
    then return jsonb_build_object('status','not_ready'); end if;
  if jsonb_typeof(p_manifest) is distinct from 'object' or p_manifest->>'ownerId' is distinct from owner::text
    or jsonb_typeof(p_manifest->'revision') is distinct from 'number'
    or (p_manifest->>'revision')::numeric<0 or (p_manifest->>'revision')::numeric>9007199254740991
    or (p_manifest->>'revision')::numeric<>trunc((p_manifest->>'revision')::numeric)
    or jsonb_typeof(p_manifest->'sourceVersion') is distinct from 'string'
    or jsonb_typeof(p_manifest->'rowCounts') is distinct from 'object'
    or jsonb_typeof(p_rows) is distinct from 'array'
    or jsonb_array_length(p_rows)>400000 or octet_length(p_rows::text)>67108864
    or octet_length(p_manifest::text)>2097152 then return jsonb_build_object('status','invalid'); end if;
  row_count=jsonb_array_length(p_rows);
  if exists(select 1 from jsonb_array_elements(p_rows) r
    where jsonb_typeof(r) is distinct from 'object' or jsonb_typeof(r->'payload') is distinct from 'object'
      or octet_length(r::text)>2097152 or r->>'kind' is null
      or r->>'kind' not in ('movement','snapshot','transfer','settlement','return','evidence','ledger')) then return jsonb_build_object('status','invalid'); end if;
  if exists(select 1 from jsonb_array_elements(p_rows) r group by r->>'kind',r->>'id' having count(*)>1) then return jsonb_build_object('status','invalid'); end if;
  foreach kind_name in array array['movement','snapshot','transfer','settlement','return','evidence','ledger'] loop
    if jsonb_typeof(p_manifest#>array['rowCounts',kind_name]) is distinct from 'number'
      or (p_manifest#>>array['rowCounts',kind_name])::numeric<>(
        select count(*) from jsonb_array_elements(p_rows) r where r->>'kind'=kind_name)
      then return jsonb_build_object('status','invalid'); end if;
  end loop;
  select * into job from alfred_display.jobs where owner_id=owner for update;
  if not found or job.desired_definition is distinct from p_definition or job.lease_definition is distinct from p_definition
    or job.lease_token is distinct from p_lease_token or job.lease_until<=clock_timestamp() or p_lease_token is null
    then return jsonb_build_object('status','lease_lost'); end if;
  select token,publish_revision into current_token,current_revision from alfred_display.publications where owner_id=owner for update;
  if not found or current_token is distinct from (baseline->>'token')::bigint
    or current_revision is distinct from (baseline->>'publishRevision')::bigint then return jsonb_build_object('status','stale'); end if;
  select epoch into current_epoch from alfred_display.clock where singleton;
  if current_epoch is distinct from (baseline->>'epoch')::bigint then return jsonb_build_object('status','stale'); end if;
  if jsonb_typeof(baseline->'events') is distinct from 'array' then return jsonb_build_object('status','invalid'); end if;
  select coalesce(array_agg(value::bigint),'{}'::bigint[]) into captured from jsonb_array_elements_text(baseline->'events');
  if exists(select 1 from alfred_display.dirty_events e where e.owner_id=owner and not(e.id=any(captured)))
    then return jsonb_build_object('status','stale'); end if;
  -- The lease is fenced again after validation/locking; a timed-out old worker cannot publish.
  if job.lease_until<=clock_timestamp() then return jsonb_build_object('status','lease_lost'); end if;
  update alfred_display.publications set definition=p_definition,token=token+1,publish_revision=publish_revision+1,
    epoch=current_epoch,manifest=p_manifest,updated_at=clock_timestamp() where owner_id=owner returning token into current_token;
  delete from alfred_display.rows where owner_id=owner;
  insert into alfred_display.rows(owner_id,definition,token,epoch,kind,id,ordinal,account_id,date,currency,category,direction,status,amount_minor,
    search_text,rank_date_asc,rank_date_desc,rank_amount_asc,rank_amount_desc,needs_attention,group_key,relation_id,payload)
    select owner,p_definition,current_token,current_epoch,r.kind,r.id,r.ordinal,r.account_id,r.date,r.currency,r.category,r.direction,r.status,r.amount_minor,
      coalesce(r.search_text,''),r.rank_date_asc,r.rank_date_desc,r.rank_amount_asc,r.rank_amount_desc,coalesce(r.needs_attention,false),r.group_key,r.relation_id,r.payload
    from jsonb_to_recordset(p_rows) as r(kind text,id text,ordinal bigint,account_id text,date text,currency text,category text,direction text,status text,amount_minor bigint,
      search_text text,rank_date_asc integer,rank_date_desc integer,rank_amount_asc integer,rank_amount_desc integer,needs_attention boolean,group_key text,relation_id text,payload jsonb);
  if (select count(*) from alfred_display.rows where owner_id=owner)<>row_count then raise check_violation using message='Display row count mismatch'; end if;
  -- Insertion/trigger/index work can outlive the lease. Raising rolls back the
  -- whole candidate publication (including replaced rows) before returning a
  -- fenced failure; an expired worker must not publish or acknowledge events.
  if job.lease_until<=clock_timestamp() then
    raise exception using errcode='PD001',message='Display publication lease expired';
  end if;
  delete from alfred_display.dirty_events e where e.owner_id=owner and e.id=any(captured);
  update alfred_display.jobs set lease_token=null,lease_definition=null,lease_until=null,due_at='infinity',
    attempts=0,last_error_code=null,last_completed_at=clock_timestamp() where owner_id=owner;
  update alfred_display.worker_health set last_published_at=clock_timestamp() where singleton;
  return jsonb_build_object('status','saved','token',current_token::text);
exception when sqlstate 'PD001' then return jsonb_build_object('status','lease_lost');
when invalid_text_representation or numeric_value_out_of_range or check_violation or not_null_violation or unique_violation then
  return jsonb_build_object('status','invalid');
end $$;

create function alfred_display.fail(owner uuid,p_lease_token uuid,p_code text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare job alfred_display.jobs%rowtype; code text;
begin
  select * into job from alfred_display.jobs where owner_id=owner for update;
  if not found or job.lease_token is distinct from p_lease_token or p_lease_token is null then return jsonb_build_object('status','lease_lost'); end if;
  code=case when p_code in ('build_failed','source_changed','publish_failed','invalid_model','not_ready','budget_exceeded') then p_code else 'build_failed' end;
  update alfred_display.jobs set lease_token=null,lease_definition=null,lease_until=null,
    due_at=clock_timestamp()+make_interval(secs=>case when desired_definition is distinct from lease_definition then 0
      else least(300,power(2,least(attempts,8))::integer) end),
    last_failed_at=clock_timestamp(),last_error_code=code where owner_id=owner;
  update alfred_display.worker_health set last_failed_at=clock_timestamp() where singleton;
  return jsonb_build_object('status','released');
end $$;

create function alfred_display.status() returns jsonb
language sql stable security invoker set search_path='' as $$
select jsonb_build_object('ready',alfred_display.readiness(),
  'dirtyOwners',(select count(distinct owner_id) from alfred_display.dirty_events),
  'queuedOwners',(select count(*) from alfred_display.jobs where due_at<=clock_timestamp() and (lease_token is null or lease_until<=clock_timestamp())),
  'leasedOwners',(select count(*) from alfred_display.jobs where lease_until>clock_timestamp()),
  'failedOwners',(select count(*) from alfred_display.jobs where last_error_code is not null),
  'modelOwners',(select count(*) from alfred_display.publications where manifest is not null),
  'oldestDirtyAt',(select min(created_at) from alfred_display.dirty_events),
  'lastWorkerAt',h.last_worker_at,'lastPublishedAt',h.last_published_at,'lastFailedAt',h.last_failed_at)
from alfred_display.worker_health h where singleton;
$$;

revoke all on all functions in schema alfred_display from public,anon,authenticated;
-- Capture the completed ABI only after every function and permission revoke succeeds.
insert into alfred_display.contracts(signature,body_hash,owner_oid)
  select p.oid::regprocedure::text,md5(pg_catalog.pg_get_functiondef(p.oid)),p.proowner
  from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='alfred_display';

