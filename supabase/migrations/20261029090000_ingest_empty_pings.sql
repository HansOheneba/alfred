-- When the iPhone Shortcut fires but iOS hands it no message text. Lets
-- Settings tell "the automation isn't running" apart from "it runs empty".
alter table public.ingest_tokens
  add column if not exists last_empty_at timestamptz;

-- Texts relayed from the Messages app on a Mac.
alter table public.bank_messages drop constraint if exists bank_messages_channel_check;
alter table public.bank_messages
  add constraint bank_messages_channel_check check (channel in ('shortcut', 'screenshot', 'manual', 'mac'));
