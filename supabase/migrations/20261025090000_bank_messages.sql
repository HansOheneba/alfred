-- Bank and mobile money messages forwarded from a phone or read from a screenshot.
-- Server-only: row level security is on and no role but the server can read them.

create table if not exists public.bank_messages (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  source text not null check (source in ('momo', 'gcb', 'other')),
  channel text not null check (channel in ('shortcut', 'screenshot', 'manual')),
  -- The provider's own transaction id, when the message has one.
  external_id text check (external_id is null or char_length(external_id) <= 64),
  text_hash text not null,
  direction text not null check (direction in ('in', 'out')),
  kind text not null check (kind in ('payment', 'transfer_own', 'loan_in', 'unknown')),
  amount numeric(12, 2) not null check (amount > 0),
  fee numeric(12, 2) not null default 0 check (fee >= 0),
  currency text not null default 'GHS' check (currency ~ '^[A-Z]{3}$'),
  counterparty text not null default '' check (char_length(counterparty) <= 120),
  balance numeric(14, 2),
  occurred_at timestamptz not null,
  status text not null check (status in ('needs_label', 'recorded', 'matched', 'transfer', 'loan', 'skipped')),
  transaction_id uuid,
  fee_transaction_id uuid,
  asked_at timestamptz,
  raw text not null check (char_length(raw) <= 1200),
  created_at timestamptz not null default now()
);

create unique index if not exists bank_messages_external_idx
  on public.bank_messages (owner_id, source, external_id)
  where external_id is not null;

create unique index if not exists bank_messages_hash_idx
  on public.bank_messages (owner_id, text_hash);

create index if not exists bank_messages_owner_status_idx
  on public.bank_messages (owner_id, status, occurred_at desc);

-- One forwarding link per person. Only a hash of the secret is stored.
create table if not exists public.ingest_tokens (
  owner_id uuid primary key references public.profiles (id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

-- What Alfred has learned about recurring payees, e.g. "rukaya issifu" means Food.
create table if not exists public.payee_rules (
  owner_id uuid not null references public.profiles (id) on delete cascade,
  payee_key text not null check (char_length(payee_key) between 1 and 120),
  category text not null,
  description text not null default '',
  updated_at timestamptz not null default now(),
  primary key (owner_id, payee_key)
);

-- Names on the person's own accounts, so transfers between them aren't counted as income or spending.
alter table public.profiles
  add column if not exists account_names text not null default '' check (char_length(account_names) <= 600);

alter table public.bank_messages enable row level security;
alter table public.ingest_tokens enable row level security;
alter table public.payee_rules enable row level security;
revoke all on table public.bank_messages from public, anon, authenticated;
revoke all on table public.ingest_tokens from public, anon, authenticated;
revoke all on table public.payee_rules from public, anon, authenticated;
