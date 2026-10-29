-- Money the person lent out and what came back. What someone still owes is
-- the sum of what they were lent minus what they repaid.
create table if not exists public.loans (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  person text not null check (char_length(person) between 1 and 120),
  person_key text not null check (char_length(person_key) between 1 and 120),
  kind text not null check (kind in ('lent', 'repaid')),
  amount numeric(12, 2) not null check (amount > 0),
  currency text not null default 'GHS' check (currency ~ '^[A-Z]{3}$'),
  occurred_at timestamptz not null,
  note text not null default '' check (char_length(note) <= 200),
  bank_message_id uuid references public.bank_messages (id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists loans_owner_person_idx on public.loans (owner_id, person_key);

-- The last batch of labels Alfred applied, so "undo" can reverse it.
create table if not exists public.label_undo (
  owner_id uuid primary key references public.profiles (id) on delete cascade,
  changes jsonb not null,
  created_at timestamptz not null default now()
);

-- Lent and repaid payments, and whether a forwarded message has been announced yet.
alter table public.bank_messages drop constraint if exists bank_messages_status_check;
alter table public.bank_messages
  add constraint bank_messages_status_check check (status in ('needs_label', 'recorded', 'matched', 'transfer', 'loan', 'skipped', 'lent', 'repaid'));
alter table public.bank_messages drop constraint if exists bank_messages_kind_check;
alter table public.bank_messages
  add constraint bank_messages_kind_check check (kind in ('payment', 'transfer_own', 'loan_in', 'unknown', 'loan_out', 'loan_repay'));

alter table public.bank_messages add column if not exists announced_at timestamptz;
-- Everything already stored has been announced.
update public.bank_messages set announced_at = created_at where announced_at is null;
create index if not exists bank_messages_unannounced_idx on public.bank_messages (owner_id, created_at) where announced_at is null;

alter table public.loans enable row level security;
alter table public.label_undo enable row level security;
revoke all on table public.loans from public, anon, authenticated;
revoke all on table public.label_undo from public, anon, authenticated;
