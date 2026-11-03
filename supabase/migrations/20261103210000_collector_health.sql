-- Counts-only operational status. Applying this draft does not register or start a Mac.
create table if not exists public.collector_health (
  owner_id uuid not null references public.profiles(id) on delete cascade,
  device_id uuid not null,
  state text not null check(state in ('ready','needs_review','capture_error')),
  source_quarantine_count integer not null check(source_quarantine_count between 0 and 1000000),
  unreadable_count integer not null check(unreadable_count between 0 and 1000000),
  incomplete_count integer not null check(incomplete_count between 0 and 1000000),
  held_for_review_count integer not null check(held_for_review_count between 0 and 1000000),
  pending_count integer not null check(pending_count between 0 and 1000000),
  last_seen_at timestamptz not null default now(),
  last_successful_capture_at timestamptz,
  last_accepted_at timestamptz,
  created_at timestamptz not null default now(),
  primary key(owner_id,device_id),
  check(unreadable_count+incomplete_count<=source_quarantine_count),
  check(held_for_review_count<=pending_count),
  check(state<>'ready' or (source_quarantine_count+held_for_review_count+pending_count=0 and last_successful_capture_at is not null))
);
alter table public.collector_health enable row level security;
revoke all on public.collector_health from public,anon,authenticated;

create or replace function public.alfred_record_collector_health(
  owner uuid, device uuid, reported_state text, source_count integer, unreadable integer,
  incomplete integer, held integer, pending integer, captured_at timestamptz, accepted_at timestamptz
) returns text language plpgsql security definer set search_path=public,pg_temp as $$
declare seen timestamptz;
begin
  if owner is null or device is null or reported_state not in ('ready','needs_review','capture_error')
     or source_count is null or unreadable is null or incomplete is null or held is null or pending is null
     or source_count not between 0 and 1000000 or unreadable not between 0 and 1000000
     or incomplete not between 0 and 1000000 or held not between 0 and 1000000 or pending not between 0 and 1000000
     or unreadable+incomplete>source_count or held>pending
     or (reported_state='ready' and (source_count+held+pending>0 or captured_at is null))
     or captured_at>now()+interval '5 minutes' or accepted_at>now()+interval '5 minutes' then
    raise exception 'Invalid collector status';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(owner::text,92351));
  select last_seen_at into seen from public.collector_health where owner_id=owner and device_id=device for update;
  if found then
    if seen>now()-interval '30 seconds' then return 'too_soon'; end if;
  elsif (select count(*) from public.collector_health where owner_id=owner)>=5 then return 'device_limit';
  end if;
  insert into public.collector_health(owner_id,device_id,state,source_quarantine_count,unreadable_count,incomplete_count,held_for_review_count,pending_count,last_seen_at,last_successful_capture_at,last_accepted_at)
  values(owner,device,reported_state,source_count,unreadable,incomplete,held,pending,now(),captured_at,accepted_at)
  on conflict(owner_id,device_id) do update set
    state=excluded.state,source_quarantine_count=excluded.source_quarantine_count,unreadable_count=excluded.unreadable_count,
    incomplete_count=excluded.incomplete_count,held_for_review_count=excluded.held_for_review_count,pending_count=excluded.pending_count,
    last_seen_at=now(),last_successful_capture_at=greatest(public.collector_health.last_successful_capture_at,excluded.last_successful_capture_at),
    last_accepted_at=greatest(public.collector_health.last_accepted_at,excluded.last_accepted_at);
  return 'stored';
end $$;
revoke all on function public.alfred_record_collector_health(uuid,uuid,text,integer,integer,integer,integer,integer,timestamptz,timestamptz) from public,anon,authenticated;
