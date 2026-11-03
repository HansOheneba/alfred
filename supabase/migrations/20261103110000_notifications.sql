-- Local draft: apply separately after review. No device registration or delivery is enabled by this migration.
create table if not exists public.notification_preferences (
  owner_id uuid primary key references public.profiles(id) on delete cascade,
  payment_mentions boolean not null default false,
  payment_push boolean not null default false,
  bill_reminders boolean not null default false,
  weekly_overview boolean not null default false,
  payment_mentions_since timestamptz,
  payment_push_since timestamptz,
  bill_reminders_since timestamptz,
  weekly_overview_since timestamptz,
  payment_epoch bigint not null default 0,
  bill_epoch bigint not null default 0,
  weekly_epoch bigint not null default 0,
  last_dispatch_at timestamptz,
  updated_at timestamptz not null default now()
);
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  endpoint_hash text not null unique check(endpoint_hash ~ '^[a-f0-9]{64}$'),
  subscription jsonb not null check(jsonb_typeof(subscription)='object'),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists push_subscriptions_owner on public.push_subscriptions(owner_id);
create or replace function public.alfred_bound_push_devices() returns trigger language plpgsql set search_path=public as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(new.owner_id::text,81655));
  if not exists(select 1 from public.push_subscriptions where endpoint_hash=new.endpoint_hash and owner_id=new.owner_id and (expires_at is null or expires_at>now()))
     and (select count(*) from public.push_subscriptions where owner_id=new.owner_id and (expires_at is null or expires_at>now()))>=5 then
    raise exception using errcode='P0001',message='Remove a notification device before adding another';
  end if;
  return new;
end $$;
create trigger push_subscriptions_bound before insert on public.push_subscriptions for each row execute function public.alfred_bound_push_devices();
revoke all on function public.alfred_bound_push_devices() from public,anon,authenticated;
create table if not exists public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  subscription_id uuid not null references public.push_subscriptions(id) on delete cascade,
  kind text not null check(kind in ('payment','bill','weekly')),
  event_key text not null check(char_length(event_key) between 1 and 160),
  resource_id uuid,
  target_date date,
  preference_epoch bigint not null,
  status text not null default 'queued' check(status in ('queued','attempted','accepted','rejected','unconfirmed','canceled')),
  attempts smallint not null default 0 check(attempts between 0 and 3),
  next_attempt_at timestamptz not null default now(),
  attempted_at timestamptz,
  last_result text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_id,subscription_id,event_key)
);
create index if not exists notification_deliveries_pending on public.notification_deliveries(owner_id,next_attempt_at) where status='queued';
alter table public.notification_preferences enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.notification_deliveries enable row level security;
revoke all on public.notification_preferences,public.push_subscriptions,public.notification_deliveries from public,anon,authenticated;
grant select on public.notification_preferences to authenticated;
create policy notification_preferences_read_own on public.notification_preferences for select to authenticated using(owner_id=auth.uid());
-- No client role can read push endpoints/encryption keys, enqueue work, or mark delivery.
create or replace function public.alfred_notifications_schema_20261103_v1() returns text language sql immutable as $$select 'alfred.notifications:20261103:v1'::text$$;
revoke all on function public.alfred_notifications_schema_20261103_v1() from public,anon,authenticated;
