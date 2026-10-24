-- What each assistant reply was (for the off-topic counter) and any chart
-- shown beside it in the web chat.
alter table public.messages
  add column if not exists intent text check (intent is null or char_length(intent) <= 40),
  add column if not exists meta jsonb;
