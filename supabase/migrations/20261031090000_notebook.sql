-- What Alfred has learnt about the person: standing facts in their words,
-- like "Paid on the 25th". A note with an account is an account whose texts
-- aren't their money, like a parent's account they manage; those texts are
-- left out entirely.
create table if not exists public.about_me (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  note text not null check (char_length(note) between 1 and 300),
  account text check (account is null or account ~ '^\d{3,4}$'),
  created_at timestamptz not null default now()
);

create index if not exists about_me_owner_idx on public.about_me (owner_id, created_at);
create unique index if not exists about_me_owner_account_idx on public.about_me (owner_id, account) where account is not null;

alter table public.about_me enable row level security;
revoke all on table public.about_me from public, anon, authenticated;
