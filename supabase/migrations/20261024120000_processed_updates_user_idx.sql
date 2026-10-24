-- Conversation context reads the user's latest completed updates on every
-- message. update_id lookups already use the unique index on that column.
create index if not exists processed_updates_user_completed_idx
  on public.processed_updates (user_id, id desc)
  where status = 'completed';
