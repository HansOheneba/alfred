-- What Alfred learns from: each time the person accepts, rejects or replaces
-- one of Alfred's readings, and a short trace of every chat turn. Neither
-- table holds money or bank text, and nothing reads them back into a reply yet.
create table if not exists public.corrections (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  bank_message_id uuid,
  kind text not null check (kind in ('yes', 'reject', 'edit', 'undo')),
  user_text text check (char_length(user_text) <= 1000),
  proposed jsonb not null check (jsonb_typeof(proposed) in ('object', 'array')),
  final jsonb,
  created_at timestamptz not null default now()
);
create index if not exists corrections_owner_created_idx on public.corrections (owner_id, created_at desc);
alter table public.corrections enable row level security;
revoke all on public.corrections from public, anon, authenticated;

create table if not exists public.turn_traces (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  channel text not null check (channel in ('web', 'telegram')),
  actions text[] not null default '{}',
  model text check (char_length(model) <= 64),
  latency_ms integer not null check (latency_ms >= 0),
  intent text check (char_length(intent) <= 80),
  proposed boolean not null default false,
  refused boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists turn_traces_owner_created_idx on public.turn_traces (owner_id, created_at desc);
alter table public.turn_traces enable row level security;
revoke all on public.turn_traces from public, anon, authenticated;
