-- Bills and recurring renewals: upcoming payments the person has confirmed,
-- with optional day-before reminders on Telegram.

create table if not exists public.bills (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  next_date date not null,
  amount numeric(16, 2) check (amount is null or amount > 0),
  currency text not null default 'GHS' check (currency ~ '^[A-Z]{3}$'),
  cadence text not null check (cadence in ('once', 'weekly', 'monthly', 'yearly')),
  active boolean not null default true,
  reminded_for date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists bills_owner_idx on public.bills (owner_id, active, next_date);

alter table public.bills enable row level security;
