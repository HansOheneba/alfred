-- Private notes on how Alfred should speak to one person. Set by the owner
-- of the deployment, read only by the server, and never shown in Settings.
create table if not exists public.assistant_notes (
  owner_id uuid primary key references public.profiles (id) on delete cascade,
  tone_note text not null default '' check (char_length(tone_note) <= 1000),
  updated_at timestamptz not null default now()
);

alter table public.assistant_notes enable row level security;
revoke all on table public.assistant_notes from public, anon, authenticated;
