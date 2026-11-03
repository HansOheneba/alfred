-- Additive draft; does not register a scheduler or enable notification preferences.
create table if not exists public.notification_recovery_health (
  id text primary key check(id='dispatcher'),
  configuration_fingerprint text not null check(configuration_fingerprint ~ '^[a-f0-9]{64}$'),
  last_completed_at timestamptz,
  last_failed_at timestamptz
);
alter table public.notification_recovery_health enable row level security;
revoke all on public.notification_recovery_health from public,anon,authenticated;

-- A mute/re-activation invalidates queued work atomically with the preference
-- update. Delivery deferral and scheduler outages do not invalidate opted-in work.
create or replace function public.alfred_cancel_muted_notifications() returns trigger language plpgsql set search_path=public as $$
begin
  update public.notification_deliveries set status='canceled',last_result='preference-changed',updated_at=now()
  where owner_id=new.owner_id and status='queued' and
    ((kind='payment' and (not new.payment_push or preference_epoch<>new.payment_epoch))
     or (kind='bill' and (not new.bill_reminders or preference_epoch<>new.bill_epoch))
     or (kind='weekly' and (not new.weekly_overview or preference_epoch<>new.weekly_epoch)));
  return new;
end $$;
create trigger notification_preferences_cancel_muted after update on public.notification_preferences
  for each row execute function public.alfred_cancel_muted_notifications();
revoke all on function public.alfred_cancel_muted_notifications() from public,anon,authenticated;
