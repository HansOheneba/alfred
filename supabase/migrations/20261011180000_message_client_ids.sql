alter table public.messages
  add column if not exists client_id text;

alter table public.messages
  drop constraint if exists messages_client_id_length;

alter table public.messages
  add constraint messages_client_id_length
  check (client_id is null or char_length(client_id) between 8 and 80);

create unique index if not exists messages_owner_client_role_idx
  on public.messages (owner_id, client_id, role)
  where client_id is not null;

grant select on table public.messages to authenticated;

drop policy if exists messages_select_own on public.messages;

create policy messages_select_own on public.messages
  for select to authenticated
  using ((select auth.uid()) = owner_id);

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1
       from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'messages'
     ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end $$;
