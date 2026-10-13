create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  preferred_name text not null default '',
  currency text not null default 'GHS' check (currency ~ '^[A-Z]{3}$'),
  timezone text not null default 'Africa/Accra',
  communication_preference text not null default 'concise' check (communication_preference in ('concise', 'detailed')),
  financial_goals text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.telegram_accounts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references public.profiles (id) on delete cascade,
  telegram_user_id bigint unique check (telegram_user_id is null or telegram_user_id > 0),
  chat_id bigint,
  locked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists telegram_accounts_telegram_user_id_idx
  on public.telegram_accounts (telegram_user_id);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  channel text not null check (channel in ('web', 'telegram')),
  role text not null check (role in ('user', 'assistant')),
  body text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);

create index if not exists messages_owner_created_idx
  on public.messages (owner_id, created_at desc);

create table if not exists public.reminder_preferences (
  owner_id uuid primary key references public.profiles (id) on delete cascade,
  morning_enabled boolean not null default false,
  commute_enabled boolean not null default false,
  evening_enabled boolean not null default false,
  morning_minute smallint not null default 480 check (morning_minute between 0 and 1439),
  commute_minute smallint not null default 510 check (commute_minute between 0 and 1439),
  evening_minute smallint not null default 1200 check (evening_minute between 0 and 1439),
  updated_at timestamptz not null default now()
);

create table if not exists public.reminder_deliveries (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('morning', 'commute', 'evening')),
  local_date date not null,
  created_at timestamptz not null default now(),
  unique (owner_id, kind, local_date)
);

create index if not exists reminder_deliveries_owner_idx
  on public.reminder_deliveries (owner_id, local_date);

create table if not exists public.api_rate_limits (
  bucket text primary key,
  window_start timestamptz not null,
  hits integer not null check (hits >= 0),
  updated_at timestamptz not null default now()
);

alter table public.transactions
  add column if not exists owner_id uuid references public.profiles (id);

alter table public.budgets
  add column if not exists owner_id uuid references public.profiles (id);

alter table public.savings_goals
  add column if not exists owner_id uuid references public.profiles (id);

alter table public.processed_updates
  add column if not exists owner_id uuid references public.profiles (id);

alter table public.pending_actions
  add column if not exists owner_id uuid references public.profiles (id);

create index if not exists transactions_owner_date_idx
  on public.transactions (owner_id, transaction_date);

create index if not exists budgets_owner_idx on public.budgets (owner_id);
create index if not exists savings_goals_owner_idx on public.savings_goals (owner_id);
create index if not exists processed_updates_owner_idx on public.processed_updates (owner_id);
create index if not exists pending_actions_owner_idx on public.pending_actions (owner_id);

create unique index if not exists budgets_owner_period_idx
  on public.budgets (owner_id, period, category, currency);

create or replace function public.reject_locked_telegram_id_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.locked_at is not null and new.telegram_user_id is distinct from old.telegram_user_id then
    raise exception 'telegram id is locked' using errcode = 'check_violation';
  end if;
  if old.locked_at is not null and new.locked_at is null then
    raise exception 'telegram id is locked' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists telegram_accounts_lock_id on public.telegram_accounts;
create trigger telegram_accounts_lock_id
  before update on public.telegram_accounts
  for each row
  execute function public.reject_locked_telegram_id_change();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, preferred_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'preferred_name', ''))
  on conflict (id) do nothing;
  insert into public.telegram_accounts (owner_id)
  values (new.id)
  on conflict (owner_id) do nothing;
  insert into public.conversations (owner_id)
  values (new.id)
  on conflict (owner_id) do nothing;
  insert into public.reminder_preferences (owner_id)
  values (new.id)
  on conflict (owner_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();

revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.reject_locked_telegram_id_change() from public, anon, authenticated;
grant execute on function public.reject_locked_telegram_id_change() to authenticated;

alter table public.profiles enable row level security;
alter table public.telegram_accounts enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.reminder_preferences enable row level security;
alter table public.reminder_deliveries enable row level security;
alter table public.api_rate_limits enable row level security;

revoke all on table public.profiles from public, anon, authenticated;
revoke all on table public.telegram_accounts from public, anon, authenticated;
revoke all on table public.conversations from public, anon, authenticated;
revoke all on table public.messages from public, anon, authenticated;
revoke all on table public.reminder_preferences from public, anon, authenticated;
revoke all on table public.reminder_deliveries from public, anon, authenticated;
revoke all on table public.api_rate_limits from public, anon, authenticated;

grant select, update on table public.profiles to authenticated;
grant select on table public.telegram_accounts to authenticated;
grant update (telegram_user_id, updated_at) on table public.telegram_accounts to authenticated;
grant select, update on table public.reminder_preferences to authenticated;

create policy profiles_select on public.profiles
  for select to authenticated
  using ((select auth.uid()) = id);

create policy profiles_update on public.profiles
  for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

create policy telegram_accounts_select on public.telegram_accounts
  for select to authenticated
  using ((select auth.uid()) = owner_id);

create policy telegram_accounts_update on public.telegram_accounts
  for update to authenticated
  using ((select auth.uid()) = owner_id and locked_at is null)
  with check ((select auth.uid()) = owner_id and locked_at is null);

create policy reminder_preferences_select on public.reminder_preferences
  for select to authenticated
  using ((select auth.uid()) = owner_id);

create policy reminder_preferences_update on public.reminder_preferences
  for update to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);
