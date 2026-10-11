create table if not exists public.alfred_schema_migrations (
  filename text primary key,
  applied_at timestamptz not null default now()
);

create table if not exists public.transactions (
  id bigint generated always as identity primary key,
  transaction_id uuid not null unique,
  created_at timestamptz not null,
  transaction_date date not null,
  user_id text not null,
  type text not null check (type in ('income', 'expense')),
  amount numeric(12, 2) not null check (amount > 0 and amount <= 9999999.99),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  category text not null,
  description text not null,
  payment_method text not null default '',
  notes text not null default '',
  status text not null check (status in ('active', 'deleted')),
  updated_at timestamptz not null,
  source_update_id text not null
);

create index if not exists transactions_user_date_idx
  on public.transactions (user_id, transaction_date);

create index if not exists transactions_user_source_idx
  on public.transactions (user_id, source_update_id);

create table if not exists public.budgets (
  id bigint generated always as identity primary key,
  budget_id text not null unique,
  user_id text not null,
  period text not null,
  category text not null,
  amount numeric(12, 2) not null check (amount >= 0 and amount <= 9999999.99),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (user_id, period, category, currency)
);

create table if not exists public.savings_goals (
  id bigint generated always as identity primary key,
  goal_id text not null unique,
  user_id text not null,
  name text not null,
  target_amount numeric(12, 2) not null check (target_amount >= 0 and target_amount <= 9999999.99),
  current_amount numeric(12, 2) not null check (current_amount >= 0 and current_amount <= 9999999.99),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  target_date text not null default '',
  status text not null check (status in ('active', 'completed', 'deleted')),
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create index if not exists savings_goals_user_idx on public.savings_goals (user_id);

create table if not exists public.processed_updates (
  id bigint generated always as identity primary key,
  update_id text not null unique,
  user_id text not null,
  status text not null check (status in ('processing', 'completed', 'failed', 'duplicate_skipped')),
  result_reference text not null,
  processed_at timestamptz not null
);

create table if not exists public.pending_actions (
  id bigint generated always as identity primary key,
  action_id text not null unique,
  user_id text not null,
  chat_id text not null,
  action_type text not null,
  payload_json text not null,
  status text not null check (status in ('pending', 'processing', 'completed', 'cancelled', 'expired')),
  expires_at timestamptz not null,
  created_at timestamptz not null
);

create index if not exists pending_actions_user_idx on public.pending_actions (user_id);

do $$
declare
  ledger_table text;
begin
  foreach ledger_table in array array[
    'alfred_schema_migrations',
    'transactions',
    'budgets',
    'savings_goals',
    'processed_updates',
    'pending_actions'
  ]
  loop
    execute format('alter table public.%I enable row level security', ledger_table);
    execute format('revoke all on table public.%I from public, anon, authenticated', ledger_table);
  end loop;
end $$;
