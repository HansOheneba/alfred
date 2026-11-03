-- Delivery receipts are operational state: history import must never replay them.
create table if not exists public.bank_notice_receipts (
 owner_id uuid not null references public.profiles(id) on delete cascade,
 bank_message_id uuid not null references public.bank_messages(id) on delete cascade,
 message_id uuid not null,
 created_at timestamptz not null default now(),
 primary key(owner_id,bank_message_id)
);
-- Keep the receipt after Clear conversation. A historical notice must not reappear.
-- The identifier is audit metadata rather than a live FK to the clearable thread.
alter table public.bank_notice_receipts enable row level security;
revoke all on public.bank_notice_receipts from public,anon,authenticated;
create index if not exists bank_messages_notice_candidates on public.bank_messages(owner_id,created_at)
 where channel in ('mac','shortcut') and direction='in';

create or replace function public.alfred_record_bank_notice(
 owner uuid,bank_id uuid,client_key text,notice_body text,financial_write boolean,expected_status text,expected_transaction uuid,requires_purpose boolean,expected_purpose jsonb
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare bank public.bank_messages%rowtype; since timestamptz; conversation uuid; saved uuid; actual_purpose jsonb;
begin
 -- Serialize against concurrent announcement and classification changes.
 select * into bank from public.bank_messages where id=bank_id and owner_id=owner for update;
 if not found then return false; end if;
 select payment_mentions_since into since from public.notification_preferences where owner_id=owner and payment_mentions for share;
 if since is null or bank.created_at<since or bank.occurred_at<since or bank.occurred_at<now()-interval '24 hours'
    or bank.created_at>now()+interval '5 minutes' or bank.occurred_at>now()+interval '5 minutes'
    or bank.channel not in ('mac','shortcut') or bank.direction<>'in' or bank.amount<=0
    or bank.kind not in ('payment','unknown') or bank.status not in ('needs_label','recorded','matched')
    or (bank.status in ('recorded','matched') and bank.transaction_id is null)
    or bank.status<>expected_status or bank.transaction_id is distinct from expected_transaction then return false; end if;
 if requires_purpose and bank.status<>'needs_label' then return false; end if;
 -- Bind an acknowledgement to the active principal record, never the fee or
 -- another owner's row. A concurrent classification edit leaves it for retry.
 select jsonb_build_object('ownerId',t.owner_id::text,'transactionId',t.transaction_id::text,'category',t.category,'description',t.description,'recordStatus',t.status)
   into actual_purpose from public.transactions t where t.owner_id=owner and t.transaction_id=bank.transaction_id and t.status='active' for share;
 if actual_purpose is distinct from expected_purpose then return false; end if;
 if exists(select 1 from public.bank_notice_receipts where owner_id=owner and bank_message_id=bank_id) then return false; end if;
 if char_length(client_key) not between 8 and 80 or client_key !~ '^bank_notice_[a-f0-9]{64}$'
    or char_length(notice_body) not between 1 and 1000 then raise exception 'Invalid payment notice'; end if;
 select id into conversation from public.conversations where owner_id=owner;
 if conversation is null then return false; end if;
 insert into public.messages(conversation_id,owner_id,channel,role,body,client_id,intent,meta)
 values(conversation,owner,'web','assistant',notice_body,client_key,'automation:incoming-payment',jsonb_build_object('ledgerChanged',financial_write,'paymentNotice',jsonb_build_object('bankMessageId',bank_id::text,'requiresPurpose',requires_purpose)))
 on conflict(owner_id,client_id,role) where client_id is not null do update set body=public.messages.body
 returning id into saved;
 insert into public.bank_notice_receipts(owner_id,bank_message_id,message_id) values(owner,bank_id,saved);
 return true;
end $$;
revoke all on function public.alfred_record_bank_notice(uuid,uuid,text,text,boolean,text,uuid,boolean,jsonb) from public,anon,authenticated;
