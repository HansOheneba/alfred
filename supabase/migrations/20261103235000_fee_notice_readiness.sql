-- Give small bare outgoing alerts the same server-observed settling window as
-- payment linking. This changes notice eligibility only; it never edits money,
-- preferences, existing messages, delivery receipts or source alert history.
create or replace function public.alfred_bank_notice_readiness(
 owner uuid,bank_id uuid,checked_at timestamptz
) returns table(state text,ready_at timestamptz)
language sql stable strict security invoker set search_path=public,pg_temp as $$
 select case
   when not small_bare then 'ready'
   when b.status='recorded' and exists(
     select 1 from public.transactions t
     where t.owner_id=owner and t.transaction_id=b.transaction_id
       and t.status='active' and t.type='expense' and t.category='Fees'
       and t.amount=b.amount and t.amount>0 and t.currency=b.currency
       and t.source_update_id='bank:'||b.id::text
   ) then 'suppressed'
   when b.status='needs_label' and b.transaction_id is null
     and checked_at<b.created_at+interval '180 seconds' then 'waiting'
   else 'ready' end,
   case
     when small_bare and b.status='recorded' and exists(
       select 1 from public.transactions t
       where t.owner_id=owner and t.transaction_id=b.transaction_id
         and t.status='active' and t.type='expense' and t.category='Fees'
         and t.amount=b.amount and t.amount>0 and t.currency=b.currency
         and t.source_update_id='bank:'||b.id::text
     ) then null::timestamptz
     when small_bare and b.status='needs_label' and b.transaction_id is null
       and checked_at<b.created_at+interval '180 seconds' then b.created_at+interval '180 seconds'
     else checked_at end
 from public.bank_messages b
 cross join lateral(select b.direction='out' and b.kind in ('payment','hold_settle')
   and b.counterparty='' and b.amount>0 and b.amount<=10 as small_bare) scope
 where b.owner_id=owner and b.id=bank_id
$$;
revoke all on function public.alfred_bank_notice_readiness(uuid,uuid,timestamptz) from public,anon,authenticated;

-- Keep the ten-argument activity writer ABI, consent/activation fences, source
-- comparison and durable receipt key. The readiness check runs after the owned
-- bank row is locked, so a direct caller cannot bypass the settling boundary.
create or replace function public.alfred_record_bank_activity_notice(
 owner uuid,bank_id uuid,client_key text,notice_body text,financial_write boolean,expected_status text,expected_transaction uuid,requires_purpose boolean,expected_purpose jsonb,expected_source jsonb
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare bank public.bank_messages%rowtype; since timestamptz; conversation uuid; saved uuid;
 actual_purpose jsonb; actual_source jsonb; principal_type text; principal_amount text; principal_currency text; ordinary boolean; eligible boolean;
begin
 select * into bank from public.bank_messages where id=bank_id and owner_id=owner for update;
 if not found then return false; end if;
 select case when bank.direction='in' and payment_mentions then payment_mentions_since
             when bank.direction='out' and outgoing_mentions then outgoing_mentions_since end
 into since from public.notification_preferences where owner_id=owner for share;
 if since is not null then since=greatest(since,now()-interval '24 hours'); end if;
 if since is null or bank.created_at<since or bank.occurred_at<since or bank.occurred_at<now()-interval '24 hours'
    or bank.created_at>now()+interval '5 minutes' or bank.occurred_at>now()+interval '5 minutes'
    or bank.channel not in ('mac','shortcut') or bank.amount<=0
    or (bank.kind in ('card_hold','hold_settle') and bank.direction<>'out')
    or bank.status<>expected_status or bank.transaction_id is distinct from expected_transaction then return false; end if;
 ordinary=bank.kind in ('payment','unknown','card_hold') and
   (bank.status='needs_label' or (bank.status in ('recorded','matched') and bank.transaction_id is not null));
 eligible=ordinary or (bank.kind='transfer_own' and bank.status='transfer')
   or (bank.kind in ('payment','loan_in','loan_out','loan_repay') and
       (bank.status='loan' or (bank.direction='out' and bank.status in ('lent','paid_back')) or (bank.direction='in' and bank.status in ('borrowed','repaid'))))
   or (bank.kind='payment' and bank.status='invested')
   or (bank.kind='hold_settle' and bank.status in ('needs_label','recorded','matched'));
 if not eligible or requires_purpose is distinct from (ordinary and bank.status='needs_label') then return false; end if;
 select jsonb_build_object('ownerId',t.owner_id::text,'transactionId',t.transaction_id::text,'category',t.category,'description',t.description,'recordStatus',t.status),t.type,t.amount::text,t.currency
 into actual_purpose,principal_type,principal_amount,principal_currency from public.transactions t
 where t.owner_id=owner and t.transaction_id=bank.transaction_id and t.status='active' for share;
 if actual_purpose is distinct from expected_purpose then return false; end if;
 actual_source=jsonb_build_object('direction',bank.direction,'kind',bank.kind,'amount',bank.amount::text,'fee',bank.fee::text,
   'currency',bank.currency,'counterparty',bank.counterparty,'readBy',bank.read_by,'feeTransactionId',bank.fee_transaction_id::text,'principalType',principal_type,'principalAmount',principal_amount,'principalCurrency',principal_currency);
 if actual_source is distinct from expected_source then return false; end if;
 -- Principal evidence, when present, is now locked as well as the bank row.
 if not exists(select 1 from public.alfred_bank_notice_readiness(owner,bank_id,now()) r where r.state='ready') then return false; end if;
 -- Refresh financial context for a durable special classification without
 -- claiming that this notice itself inserted an income or expense.
 if financial_write is distinct from (bank.fee_transaction_id is not null
    or (bank.status='recorded' and bank.transaction_id is not null)
    or bank.status in ('transfer','lent','borrowed','repaid','paid_back','invested')) then return false; end if;
 -- The receipt survives cleared chat, and both writer versions share its key.
 if exists(select 1 from public.bank_notice_receipts where owner_id=owner and bank_message_id=bank_id) then return false; end if;
 if char_length(client_key) not between 8 and 80 or client_key !~ '^bank_notice_[a-f0-9]{64}$'
    or char_length(notice_body) not between 1 and 1000 then raise exception 'Invalid payment activity notice'; end if;
 select id into conversation from public.conversations where owner_id=owner;
 if conversation is null then return false; end if;
 insert into public.messages(conversation_id,owner_id,channel,role,body,client_id,intent,meta)
 values(conversation,owner,'web','assistant',notice_body,client_key,
   case when bank.direction='in' then 'automation:incoming-payment' else 'automation:outgoing-payment' end,
   jsonb_build_object('ledgerChanged',financial_write,'paymentNotice',jsonb_build_object('bankMessageId',bank_id::text,'requiresPurpose',requires_purpose)))
 on conflict(owner_id,client_id,role) where client_id is not null do update set body=public.messages.body
 returning id into saved;
 insert into public.bank_notice_receipts(owner_id,bank_message_id,message_id) values(owner,bank_id,saved);
 return true;
end $$;
revoke all on function public.alfred_record_bank_activity_notice(uuid,uuid,text,text,boolean,text,uuid,boolean,jsonb,jsonb) from public,anon,authenticated;
