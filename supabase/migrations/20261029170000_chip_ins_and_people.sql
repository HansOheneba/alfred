-- A chip-in (someone paying their share of a bill) is stored as a negative
-- expense in the bill's category, so the category shows what the person
-- really paid. Only expenses can be negative.
alter table public.transactions drop constraint if exists transactions_amount_check;
alter table public.transactions
  add constraint transactions_amount_check check ((amount > 0 or (type = 'expense' and amount < 0)) and abs(amount) <= 9999999.99);

-- A learned payee can mean a category, or "chipping in" toward one.
alter table public.payee_rules add column if not exists kind text not null default 'category';
alter table public.payee_rules drop constraint if exists payee_rules_kind_check;
alter table public.payee_rules add constraint payee_rules_kind_check check (kind in ('category', 'chip_in'));

-- What the person has told Alfred about the people they send money to and get it from.
create table if not exists public.people (
  owner_id uuid not null references public.profiles (id) on delete cascade,
  person_key text not null check (char_length(person_key) between 1 and 120),
  name text not null check (char_length(name) between 1 and 120),
  note text not null check (char_length(note) between 1 and 300),
  updated_at timestamptz not null default now(),
  primary key (owner_id, person_key)
);

alter table public.people enable row level security;
revoke all on table public.people from public, anon, authenticated;
