-- Establish a durable, no-history-replay boundary for newly supported card
-- activity pushes. Existing consent, preview choice, epochs and jobs are kept.
-- No notification is enqueued or sent by this migration.
alter table public.notification_preferences
  add column if not exists card_activity_push_since timestamptz;
update public.notification_preferences set card_activity_push_since=now()
  where card_activity_push_since is null;
alter table public.notification_preferences
  alter column card_activity_push_since set default now(),
  alter column card_activity_push_since set not null;
comment on column public.notification_preferences.card_activity_push_since is
  'Earliest source creation and occurrence eligible for newly supported card activity pushes; existing opt-in and device cutoffs also apply.';
