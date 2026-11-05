-- Additive. A small shared space for the people who build Alfred: project ideas and notes on
-- how to build them. Unlike everything else in Alfred these rows are shared between members,
-- so access is by membership, never by owner. Membership rows are added by hand, not by the app.
create table public.team_members (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  added_at timestamptz not null default now()
);

create table public.team_projects (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 120),
  summary text not null default '' check (char_length(summary) <= 2000),
  status text not null default 'idea' check (status in ('idea', 'planned', 'building', 'shipped', 'parked')),
  -- Who's taking it: one member, or null for both of them.
  lead_id uuid references public.team_members(profile_id) on delete set null,
  created_by uuid not null references public.team_members(profile_id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.team_project_notes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.team_projects(id) on delete cascade,
  author_id uuid not null references public.team_members(profile_id) on delete cascade,
  body text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);

create index team_projects_updated on public.team_projects(updated_at desc);
create index team_project_notes_project on public.team_project_notes(project_id, created_at);

alter table public.team_members enable row level security;
alter table public.team_projects enable row level security;
alter table public.team_project_notes enable row level security;
-- Server-owned: the app checks membership on every read and write.
revoke all on table public.team_members, public.team_projects, public.team_project_notes from public, anon, authenticated;
