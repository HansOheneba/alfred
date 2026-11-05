-- Additive. Charts a person kept on their Overview from chat. Each row holds the chart's
-- description (measure, grouping, period), never figures: the Overview works them out
-- from the books on every load, so a kept chart moves with the month.
create table public.pinned_charts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  query jsonb not null check (jsonb_typeof(query) = 'object' and pg_column_size(query) <= 2048),
  created_at timestamptz not null default now()
);

create index pinned_charts_owner on public.pinned_charts(owner_id, created_at);
create unique index pinned_charts_owner_query on public.pinned_charts(owner_id, md5(query::text));
alter table public.pinned_charts enable row level security;
-- Server-owned: the app reads and writes these for the signed-in owner only.
revoke all on table public.pinned_charts from public, anon, authenticated;
