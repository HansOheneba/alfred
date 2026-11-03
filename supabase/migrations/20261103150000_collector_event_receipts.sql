-- Operational receipts contain hashes/IDs only, never raw SMS or credentials.
-- They are not exported/replayed as financial history.
create table if not exists public.collector_event_receipts (
  owner_id uuid not null references public.profiles(id) on delete cascade,
  event_id text not null check (event_id ~ '^[a-f0-9]{64}$'),
  payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
  receipt_id uuid not null default gen_random_uuid(),
  state text not null default 'pending' check (state in ('pending','stored')),
  claim_token uuid,
  claim_until timestamptz,
  message_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  stored_at timestamptz,
  primary key(owner_id,event_id),
  check (cardinality(message_ids) <= 64),
  check ((state='pending' and stored_at is null) or (state='stored' and stored_at is not null and cardinality(message_ids)>0))
);
alter table public.collector_event_receipts enable row level security;
revoke all on public.collector_event_receipts from public,anon,authenticated;

create or replace function public.alfred_claim_collector_event(p_owner uuid,p_event text,p_hash text)
returns table(status text,receipt_id uuid,claim_token uuid)
language plpgsql security definer set search_path=public,pg_temp as $$
declare item public.collector_event_receipts%rowtype; fresh uuid;
begin
  if p_event !~ '^[a-f0-9]{64}$' or p_hash !~ '^[a-f0-9]{64}$' then raise exception 'Invalid collector event'; end if;
  insert into public.collector_event_receipts(owner_id,event_id,payload_hash)
    values(p_owner,p_event,p_hash) on conflict(owner_id,event_id) do nothing;
  select * into item from public.collector_event_receipts r where r.owner_id=p_owner and r.event_id=p_event for update;
  if item.payload_hash<>p_hash then return query select 'conflict'::text,null::uuid,null::uuid; return; end if;
  if item.state='stored' then return query select 'stored'::text,item.receipt_id,null::uuid; return; end if;
  if item.claim_until>now() then return query select 'busy'::text,null::uuid,null::uuid; return; end if;
  fresh=gen_random_uuid();
  update public.collector_event_receipts r set claim_token=fresh,claim_until=now()+interval '2 minutes'
    where r.owner_id=p_owner and r.event_id=p_event;
  return query select 'acquired'::text,null::uuid,fresh;
end $$;

create or replace function public.alfred_complete_collector_event(p_owner uuid,p_event text,p_hash text,p_claim uuid,p_messages uuid[])
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare item public.collector_event_receipts%rowtype; expected integer; found_count integer;
begin
  select * into item from public.collector_event_receipts r where r.owner_id=p_owner and r.event_id=p_event for update;
  if not found or item.payload_hash<>p_hash then return null; end if;
  if item.state='stored' then return item.receipt_id; end if;
  if item.claim_token is distinct from p_claim or item.claim_until<=now() or p_claim is null
    or cardinality(p_messages) not between 1 and 64 then return null; end if;
  select count(distinct value) into expected from unnest(p_messages) value;
  -- Every parsed movement must point to a durable row owned by this account.
  -- Holding these locks prevents deletion before the receipt is committed.
  perform b.id from public.bank_messages b where b.owner_id=p_owner and b.id=any(p_messages) for share;
  select count(*) into found_count from public.bank_messages b where b.owner_id=p_owner and b.id=any(p_messages);
  if found_count<>expected then return null; end if;
  update public.collector_event_receipts r set state='stored',message_ids=p_messages,stored_at=now(),claim_token=null,claim_until=null
    where r.owner_id=p_owner and r.event_id=p_event;
  return item.receipt_id;
end $$;

create or replace function public.alfred_release_collector_event(p_owner uuid,p_event text,p_hash text,p_claim uuid)
returns void language sql security definer set search_path=public,pg_temp as $$
  update public.collector_event_receipts r set claim_token=null,claim_until=null
   where r.owner_id=p_owner and r.event_id=p_event and r.payload_hash=p_hash and r.claim_token=p_claim and r.state='pending';
$$;
revoke all on function public.alfred_claim_collector_event(uuid,text,text) from public,anon,authenticated;
revoke all on function public.alfred_complete_collector_event(uuid,text,text,uuid,uuid[]) from public,anon,authenticated;
revoke all on function public.alfred_release_collector_event(uuid,text,text,uuid) from public,anon,authenticated;
