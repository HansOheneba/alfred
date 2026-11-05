-- Local review draft. Does not enable delivery, opt in anyone, or send notifications.
create table if not exists public.chat_message_notification_preferences (
  owner_id uuid primary key references public.profiles(id) on delete cascade,
  message_push boolean not null default false,
  message_preview boolean not null default false,
  message_push_since timestamptz,
  preference_epoch bigint not null default 0,
  last_dispatch_at timestamptz,
  updated_at timestamptz not null default now()
);
create table if not exists public.chat_message_read_state (
  owner_id uuid primary key references public.profiles(id) on delete cascade,
  started_at timestamptz not null default now(),
  read_created_at timestamptz not null default now(),
  read_message_id uuid,
  updated_at timestamptz not null default now()
);
create table if not exists public.chat_message_presence (
  owner_id uuid not null references public.profiles(id) on delete cascade,
  presence_id uuid not null,
  visible_until timestamptz not null,
  primary key(owner_id,presence_id)
);
create unique index if not exists messages_owned_identity on public.messages(owner_id,id);
create unique index if not exists push_subscriptions_owned_identity on public.push_subscriptions(owner_id,id);
create index if not exists messages_assistant_updates on public.messages(owner_id,created_at,id) where role='assistant';
create table if not exists public.chat_message_notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  message_id uuid not null,
  subscription_id uuid not null,
  preference_epoch bigint not null,
  status text not null default 'queued' check(status in ('queued','attempted','accepted','rejected','unconfirmed','canceled')),
  attempts smallint not null default 0 check(attempts between 0 and 3),
  next_attempt_at timestamptz not null default now(),
  attempted_at timestamptz,
  last_result text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key(owner_id,message_id) references public.messages(owner_id,id) on delete cascade,
  foreign key(owner_id,subscription_id) references public.push_subscriptions(owner_id,id) on delete cascade,
  unique(owner_id,message_id,subscription_id)
);
create index if not exists chat_message_delivery_pending on public.chat_message_notification_deliveries(owner_id,next_attempt_at) where status='queued';
create index if not exists chat_message_visible_presence on public.chat_message_presence(owner_id,visible_until);
alter table public.chat_message_notification_preferences enable row level security;
alter table public.chat_message_read_state enable row level security;
alter table public.chat_message_presence enable row level security;
alter table public.chat_message_notification_deliveries enable row level security;
revoke all on public.chat_message_notification_preferences,public.chat_message_read_state,public.chat_message_presence,public.chat_message_notification_deliveries from public,anon,authenticated;
-- Only authenticated, owner-checked server routes can read cursors or mutate delivery state.
