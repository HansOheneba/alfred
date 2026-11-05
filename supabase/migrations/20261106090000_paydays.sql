-- Additive. The payday a person confirmed or set, or that they have no regular payday.
-- No row means Alfred learns payday from incomes labelled Salary and asks them to confirm it.
create table public.paydays (
  owner_id uuid primary key references public.profiles(id) on delete cascade,
  day smallint check (day between 1 and 31),
  regular boolean not null default true,
  updated_at timestamptz not null default now(),
  check (regular = (day is not null))
);

alter table public.paydays enable row level security;
-- Server-owned: the app reads and writes these for the signed-in owner only.
revoke all on table public.paydays from public, anon, authenticated;
