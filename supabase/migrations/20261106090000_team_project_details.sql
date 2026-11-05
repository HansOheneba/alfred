-- Additive. Gives team projects a priority, links (references, PRs, docs), the time they
-- shipped, and lets a note show when its author last edited it. Existing rows keep their
-- data: priority starts at medium, links start empty.
alter table public.team_projects
  add column priority text not null default 'medium' check (priority in ('high', 'medium', 'low')),
  add column links jsonb not null default '[]'::jsonb check (jsonb_typeof(links) = 'array' and jsonb_array_length(links) <= 12),
  add column shipped_at timestamptz;

alter table public.team_project_notes
  add column edited_at timestamptz;
