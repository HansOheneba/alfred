-- Money the person borrowed from someone, and paying it back, alongside what
-- they lent out. What the person owes someone is borrowed minus paid back.
alter table public.loans drop constraint if exists loans_kind_check;
alter table public.loans add constraint loans_kind_check check (kind in ('lent', 'repaid', 'borrowed', 'paid_back'));

alter table public.bank_messages drop constraint if exists bank_messages_status_check;
alter table public.bank_messages
  add constraint bank_messages_status_check
  check (status in ('needs_label', 'recorded', 'matched', 'transfer', 'loan', 'skipped', 'lent', 'repaid', 'borrowed', 'paid_back'));
