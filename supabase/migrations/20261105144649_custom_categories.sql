-- Additive, owner-scoped category names used by chat, budgeting and transaction validation.
-- Defaults remain in application code. Server-side writes validate names and aliases.
create table public.custom_categories (
  id bigint generated always as identity primary key,
  category_id text not null unique,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40 and name = btrim(name) and name !~ '[[:cntrl:]]'),
  type text not null check (type in ('expense','income')),
  created_at timestamptz not null default now()
);

create unique index custom_categories_owner_type_name on public.custom_categories(owner_id,type,lower(name));
alter table public.custom_categories enable row level security;
revoke all on table public.custom_categories from public,anon,authenticated;
revoke all on sequence public.custom_categories_id_seq from public,anon,authenticated;

-- Browsers may read only their own category names; writes use the existing server-owned store.
grant select on table public.custom_categories to authenticated;
create policy custom_categories_select_owner on public.custom_categories
  for select to authenticated using ((select auth.uid())=owner_id);
