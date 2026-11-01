-- Texts from any bank, not just MoMo and GCB.
-- Absa has its own rules; banks Alfred has no rules for are read by the model,
-- and their source is a short slug like 'ecobank'. read_by says which did it,
-- so Alfred can check its reading with the person while it learns a new bank.
-- A card payment the bank puts on hold is a 'card_hold'; a later debit that may
-- be the same payment going through is a 'hold_settle', asked about first.
alter table public.bank_messages drop constraint if exists bank_messages_source_check;
alter table public.bank_messages
  add constraint bank_messages_source_check check (source ~ '^[a-z][a-z0-9_]{1,23}$');

alter table public.bank_messages drop constraint if exists bank_messages_kind_check;
alter table public.bank_messages
  add constraint bank_messages_kind_check
  check (kind in ('payment', 'transfer_own', 'loan_in', 'unknown', 'loan_out', 'loan_repay', 'card_hold', 'hold_settle'));

alter table public.bank_messages
  add column if not exists read_by text not null default 'rules' check (read_by in ('rules', 'model'));
