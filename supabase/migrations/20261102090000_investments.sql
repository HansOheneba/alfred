-- Investments: what a person holds, what it's worth, and the money they put in.
-- Money into an investment isn't spending, so it never becomes a ledger
-- transaction; it's a contribution here, and the bank text that carried it is
-- marked 'invested'.

create table if not exists public.investments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  kind text not null check (kind in ('us_stocks', 'gse_stocks', 'tbill', 'fixed_deposit', 'bond', 'mutual_fund', 'pension', 'crypto', 'other')),
  provider text not null default '' check (char_length(provider) <= 80),
  currency text not null default 'GHS' check (currency ~ '^[A-Z]{3}$'),
  -- What was in it before Alfred tracked it, in the investment's currency.
  invested_before numeric(16, 2) not null default 0 check (invested_before >= 0),
  -- Fixed income (T-bills, fixed deposits, bonds): grows by rate until it matures.
  principal numeric(16, 2) check (principal is null or principal > 0),
  rate numeric(7, 4) check (rate is null or (rate >= 0 and rate <= 200)),
  started_on date,
  matures_on date,
  reminded_at timestamptz,
  -- The bank payee that funds it, so later payments go straight in.
  payee_key text check (payee_key is null or char_length(payee_key) between 1 and 120),
  status text not null default 'active' check (status in ('active', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists investments_owner_name_idx
  on public.investments (owner_id, lower(name)) where status = 'active';
create index if not exists investments_owner_idx on public.investments (owner_id, status);

create table if not exists public.investment_holdings (
  id uuid primary key default gen_random_uuid(),
  investment_id uuid not null references public.investments (id) on delete cascade,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  symbol text not null check (symbol ~ '^[A-Z0-9.:-]{1,16}$'),
  quantity numeric(20, 6) not null check (quantity >= 0),
  cost numeric(16, 2) check (cost is null or cost >= 0),
  updated_at timestamptz not null default now(),
  unique (investment_id, symbol)
);

-- A value the person reported (in chat or a screenshot), newest wins over older estimates.
create table if not exists public.investment_values (
  id uuid primary key default gen_random_uuid(),
  investment_id uuid not null references public.investments (id) on delete cascade,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  value numeric(16, 2) not null check (value >= 0),
  as_of timestamptz not null,
  source text not null check (source in ('reported', 'screenshot')),
  created_at timestamptz not null default now()
);

create index if not exists investment_values_idx on public.investment_values (investment_id, as_of desc);

-- Money put in (amount > 0) or taken out (amount < 0), in the currency it moved in.
create table if not exists public.investment_contributions (
  id uuid primary key default gen_random_uuid(),
  investment_id uuid not null references public.investments (id) on delete cascade,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  amount numeric(16, 2) not null check (amount <> 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  occurred_on date not null,
  bank_message_id uuid references public.bank_messages (id) on delete set null,
  note text not null default '' check (char_length(note) <= 200),
  created_at timestamptz not null default now()
);

create index if not exists investment_contributions_idx on public.investment_contributions (owner_id, investment_id, occurred_on);

-- Daily closing prices and exchange rates, shared by everyone.
create table if not exists public.market_prices (
  market text not null check (market in ('us', 'gse', 'fx')),
  symbol text not null check (char_length(symbol) between 1 and 16),
  price numeric(20, 6) not null check (price > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  as_of date not null,
  fetched_at timestamptz not null default now(),
  primary key (market, symbol)
);

alter table public.investments enable row level security;
alter table public.investment_holdings enable row level security;
alter table public.investment_values enable row level security;
alter table public.investment_contributions enable row level security;
alter table public.market_prices enable row level security;

-- A bank payment the person said went into an investment.
alter table public.bank_messages drop constraint if exists bank_messages_status_check;
alter table public.bank_messages
  add constraint bank_messages_status_check
  check (status in ('needs_label', 'recorded', 'matched', 'transfer', 'loan', 'skipped', 'lent', 'repaid', 'borrowed', 'paid_back', 'invested'));

-- A payee that always funds an investment.
alter table public.payee_rules drop constraint if exists payee_rules_kind_check;
alter table public.payee_rules add constraint payee_rules_kind_check check (kind in ('category', 'chip_in', 'investment'));
