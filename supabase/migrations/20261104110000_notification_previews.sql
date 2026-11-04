-- Existing users keep discreet lock-screen copy until explicitly opting in.
-- No notification opt-in window or financial record is changed.
alter table public.notification_preferences
  add column if not exists payment_preview boolean not null default false;
