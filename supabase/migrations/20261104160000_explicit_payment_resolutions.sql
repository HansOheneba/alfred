-- Explicit user-confirmed payment exceptions are audited dispositions, never a
-- generic dismissal. Existing source text, amounts, balances and fees are kept.
alter table public.bank_messages drop constraint if exists bank_messages_status_check;
alter table public.bank_messages add constraint bank_messages_status_check check
 (status in ('needs_label','recorded','matched','transfer','loan','skipped','lent','repaid','borrowed','paid_back','invested','not_completed','returned'));
create unique index if not exists bank_messages_owner_identity_idx on public.bank_messages(owner_id,id);
create table if not exists public.bank_payment_resolutions (
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null references auth.users(id) on delete cascade,
 bank_message_id uuid not null,
 kind text not null check(kind in ('not_completed','returned')),
 reason text not null check(reason in ('failed','not_completed','returned')),
 request_id text not null check(length(request_id) between 1 and 200),
 source_fingerprint text not null,
 resolved_source_fingerprint text not null,
 bank_evidence_fingerprint text not null,
 live_facts_fingerprint text not null,
 source_snapshot jsonb not null check(jsonb_typeof(source_snapshot)='object'),
 original_movement_id text,
 original_source_fingerprint text,
 principal_minor bigint,
 settlement_id text,
 accounting_revision bigint not null check(accounting_revision>0),
 created_at timestamptz not null default now(),
 reopened_at timestamptz,
 unique(owner_id,request_id),
 foreign key(owner_id,bank_message_id) references public.bank_messages(owner_id,id) on delete cascade,
 check((kind='not_completed' and reason in ('failed','not_completed') and original_movement_id is null and original_source_fingerprint is null and principal_minor is null and settlement_id is null)
  or (kind='returned' and reason='returned' and original_movement_id is not null and original_source_fingerprint is not null and principal_minor>0 and settlement_id is not null))
);
create unique index if not exists bank_payment_resolutions_active_source_idx on public.bank_payment_resolutions(owner_id,bank_message_id) where reopened_at is null;
alter table public.bank_payment_resolutions enable row level security;
revoke all on public.bank_payment_resolutions from public,anon,authenticated;
