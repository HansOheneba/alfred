import { createHash } from "node:crypto";
import type { BankMessage } from "@/lib/bank/store";
import type { SupabaseSettings } from "@/lib/config";
import { formatAmount, toMinor } from "@/lib/finance/money";
import { loadNotificationPreferences, type NotificationPreferences } from "@/lib/notifications/store";
import { query } from "@/lib/supabase/connection";
import { knownPaymentPurpose,type StoredPaymentPurpose } from "./purpose";

/** Deterministic private app copy; excluded from push payloads and model history. */
export type MentionCandidate = Pick<BankMessage,
  "id"|"ownerId"|"channel"|"direction"|"kind"|"amount"|"currency"|"counterparty"|"occurredAt"|"status"|"transactionId"|"feeTransactionId"|"readBy"> & { createdAt: string;purpose?:StoredPaymentPurpose|null;fee?:string;principalType?:string|null;principalAmount?:string|null;principalCurrency?:string|null };
export type PaymentMention = {clientId:string;body:string;intent:"automation:incoming-payment"|"automation:outgoing-payment";ledgerChanged:boolean;requiresPurpose:boolean};
export const MENTION_MAX_AGE_MS = 24 * 60 * 60_000;

export function incomingPaymentMention(message:MentionCandidate):PaymentMention|null {
  if (!['mac','shortcut'].includes(message.channel) || message.direction !== 'in' ||
      !['payment','unknown'].includes(message.kind) || !['needs_label','recorded','matched'].includes(message.status) ||
      !Number.isFinite(Number(message.amount)) || Number(message.amount)<=0) return null;
  if (['recorded','matched'].includes(message.status)&&!message.transactionId) return null;
  let amount:string;
  try { amount=formatAmount(message.amount,message.currency); } catch { return null; }
  const name=/https?:\/\/|www\.|[<>\[\]`]/i.test(message.counterparty)?'':message.counterparty.replace(/[\u0000-\u001f\u007f\p{Cf}]/gu,' ').replace(/\s+/g,' ').trim().slice(0,80);
  const from=name?` from ${name}`:'';
  const uncertain=message.readBy==='model'||message.kind==='unknown';
  const purpose=knownPaymentPurpose(message.purpose,message.ownerId,message.transactionId,message.counterparty);
  const requiresPurpose=message.status==='needs_label';
  let body:string;
  if (uncertain) body=requiresPurpose?`I spotted a possible incoming alert for ${amount}${from}. Can you check that it looks right, and tell me what it was for?`:`I spotted a possible incoming alert for ${amount}${from}. Please check the linked record before relying on it.`;
  else if (requiresPurpose) body=`I picked up a ${amount} payment alert${from}. What was this for? I'll leave it unlabelled until you tell me.`;
  else if (message.status==='matched') body=purpose?`That ${amount} alert${from} looks like your ${purpose.detail??purpose.category} entry. I've linked it, so it's only counted once.`:`That ${amount} alert${from} looks like an entry already in your records. What was this for? Please check the match in Review before changing it; I won't guess its purpose.`;
  else if (purpose) body=purpose.detail?`Got the ${amount} alert${from} for ${purpose.detail}. I've filed it under ${purpose.category}.`:`Got the ${amount} alert${from}. It's filed under ${purpose.category}.`;
  else body=`I picked up the ${amount} alert${from}. The linked record doesn't explain its purpose. What was this for? Please check it in Review before making a correction.`;
  // The source is an alert, not an independently verified bank settlement.
  return {clientId:`bank_notice_${createHash('sha256').update(`${message.ownerId}\0${message.id}`).digest('hex')}`,
    body,intent:'automation:incoming-payment',requiresPurpose,ledgerChanged:Boolean(message.feeTransactionId)||(message.status==='recorded'&&Boolean(message.transactionId))};
}

/** Direction-aware copy uses durable source/classification evidence only. It
 * never classifies a payment, updates a ledger or claims bank settlement. */
export function paymentActivityMention(message:MentionCandidate):PaymentMention|null {
  if(!['mac','shortcut'].includes(message.channel)||!['in','out'].includes(message.direction)||!Number.isFinite(Number(message.amount))||Number(message.amount)<=0)return null;
  if(['card_hold','hold_settle'].includes(message.kind)&&message.direction!=='out')return null;
  const ordinary=['payment','unknown','card_hold'].includes(message.kind)&&['needs_label','recorded','matched'].includes(message.status);
  const transfer=message.kind==='transfer_own'&&message.status==='transfer';
  const loan=['payment','loan_in','loan_out','loan_repay'].includes(message.kind)&&(message.status==='loan'||message.direction==='out'&&['lent','paid_back'].includes(message.status)||message.direction==='in'&&['borrowed','repaid'].includes(message.status));
  const investment=message.status==='invested'&&message.kind==='payment';
  const settlement=message.kind==='hold_settle'&&['needs_label','recorded','matched'].includes(message.status);
  if(!ordinary&&!transfer&&!loan&&!investment&&!settlement)return null;
  if(ordinary&&['recorded','matched'].includes(message.status)&&!message.transactionId)return null;
  let amount:string,fee='';
  try {
    amount=formatAmount(message.amount,message.currency);
    if(message.fee&&toMinor(message.fee)>0)fee=` The alert also lists ${formatAmount(message.fee,message.currency)} in fees.`;
  }catch{return null;}
  const name=/https?:\/\/|www\.|[<>\[\]`]/i.test(message.counterparty)?'':message.counterparty.replace(/[\u0000-\u001f\u007f\p{Cf}]/gu,' ').replace(/\s+/g,' ').trim().slice(0,80);
  const party=name?` ${message.direction==='in'?'from':'to'} ${name}`:'';
  const uncertain=message.readBy==='model'||message.kind==='unknown';
  const purpose=knownPaymentPurpose(message.purpose,message.ownerId,message.transactionId,message.counterparty);
  const ownedPrincipal=message.purpose?.ownerId===message.ownerId&&message.purpose.transactionId===message.transactionId&&message.purpose.recordStatus==='active';
  let spendingAdjustment=false;
  try{spendingAdjustment=Boolean(ownedPrincipal&&message.direction==='in'&&['recorded','matched'].includes(message.status)&&message.principalType==='expense'&&message.principalCurrency===message.currency&&message.principalAmount&&toMinor(message.principalAmount)<0&&-toMinor(message.principalAmount)===toMinor(message.amount));}catch{spendingAdjustment=false;}
  // Preserve the established incoming wording and one-reply protections.
  if(message.direction==='in'&&ordinary&&message.kind!=='card_hold'&&!spendingAdjustment){
    const existing=incomingPaymentMention(message);return existing?{...existing,body:existing.body+fee}:null;
  }
  const direction=message.direction==='in'?'money-in':'money-out';
  const intro=`I picked up ${uncertain?'a possible':'a'} ${amount} ${direction} alert${party}.`;
  let body:string;
  const requiresPurpose=ordinary&&message.status==='needs_label';
  if(settlement)body=`${intro} It may be a card payment already recorded. Check it in Review before counting it again.`;
  else if(transfer)body=`${intro} This is marked as money moving between your own accounts, rather than spending or income.`;
  else if(loan){
    const meaning={lent:'money you lent, rather than spending',borrowed:'money you borrowed, rather than income',repaid:'a loan repayment received, rather than income',paid_back:'a loan repayment you made, rather than spending',loan:'a possible loan-related movement; check it in Review before relying on it'}[message.status as 'lent'|'borrowed'|'repaid'|'paid_back'|'loan'];
    body=`${intro} It is marked as ${meaning}.`;
  }else if(investment)body=`${intro} It is marked as an investment movement, rather than spending or income.`;
  else if(spendingAdjustment)body=`${intro} The linked record${purpose?` under ${purpose.category}`:''} reduces recorded spending rather than adding income.`;
  else if(uncertain)body=requiresPurpose?`${intro} Can you check that it looks right, and tell me what it was for?`:`${intro} Please check the linked record before relying on it.`;
  else if(requiresPurpose)body=`${intro} What was this for? I'll leave it unlabelled until you tell me.`;
  else if(message.status==='matched')body=`${intro} It is linked to an existing entry, so it is only counted once.${purpose?` It is filed under ${purpose.category}.`:' Check the match in Review before making a correction.'}`;
  else if(purpose)body=`${intro} It is filed under ${purpose.category}${purpose.detail?` for ${purpose.detail}`:''}.`;
  else body=`${intro} The linked record does not explain its purpose. Check it in Review before making a correction.`;
  if(message.kind==='card_hold')body+=' This is a card hold; a final settlement has not been independently confirmed.';
  if(uncertain&&!ordinary&&!settlement)body+=' Please check the linked record before relying on it.';
  return {clientId:`bank_notice_${createHash('sha256').update(`${message.ownerId}\0${message.id}`).digest('hex')}`,body:body+fee,
    intent:message.direction==='in'?'automation:incoming-payment':'automation:outgoing-payment',requiresPurpose,
    // These durable classifications change financial source/loan/investment
    // context even when they intentionally create no income/expense row.
    ledgerChanged:Boolean(message.feeTransactionId)||(message.status==='recorded'&&Boolean(message.transactionId))||['transfer','lent','borrowed','repaid','paid_back','invested'].includes(message.status)};
}
export function mentionEligible(message:MentionCandidate,ownerId:string,prefs:NotificationPreferences,now:Date):boolean {
  const enabled=message.direction==='in'?prefs.paymentMentions:message.direction==='out'?prefs.outgoingMentions:false;
  const activated=message.direction==='in'?prefs.paymentMentionsSince:prefs.outgoingMentionsSince;
  if(!enabled||!activated||message.ownerId!==ownerId)return false;
  const since=Math.max(Date.parse(activated),now.getTime()-MENTION_MAX_AGE_MS);
  const occurred=Date.parse(message.occurredAt),created=Date.parse(message.createdAt);
  return Number.isFinite(since)&&Number.isFinite(occurred)&&Number.isFinite(created)&&occurred>=since&&created>=since&&
    occurred<=now.getTime()+5*60_000&&created<=now.getTime()+5*60_000;
}
export async function writePaymentMentions(
  ownerId:string,prefs:NotificationPreferences,candidates:MentionCandidate[],now:Date,
  save:(message:MentionCandidate,mention:PaymentMention)=>Promise<boolean>,
  deadlineAt=Number.POSITIVE_INFINITY,
):Promise<number> {
  let written=0;
  for(const candidate of candidates){
    if(Date.now()>=deadlineAt)break;
    if(!mentionEligible(candidate,ownerId,prefs,now))continue;
    const mention=paymentActivityMention(candidate);
    if(mention&&await save(candidate,mention))written++;
  }
  return written;
}

type CandidateRow={id:string;owner_id:string;channel:BankMessage['channel'];direction:BankMessage['direction'];kind:BankMessage['kind'];amount:string;fee:string;currency:string;counterparty:string;occurred_at:Date;created_at:Date;status:BankMessage['status'];transaction_id:string|null;fee_transaction_id:string|null;read_by:BankMessage['readBy'];purpose_owner_id:string|null;purpose_transaction_id:string|null;purpose_category:string|null;purpose_description:string|null;purpose_record_status:string|null;principal_type:string|null;principal_amount:string|null;principal_currency:string|null};
const ACTIVITY_STATE_SQL=`((b.kind in ('payment','unknown','card_hold') and (b.status='needs_label' or (b.status in ('recorded','matched') and b.transaction_id is not null)))
  or (b.kind='transfer_own' and b.status='transfer')
  or (b.kind in ('payment','loan_in','loan_out','loan_repay') and (b.status='loan' or (b.direction='out' and b.status in ('lent','paid_back')) or (b.direction='in' and b.status in ('borrowed','repaid'))))
  or (b.kind='payment' and b.status='invested')
  or (b.kind='hold_settle' and b.status in ('needs_label','recorded','matched')))
  and (b.kind not in ('card_hold','hold_settle') or b.direction='out')`;
/** Recovery is bounded and independent of ingestion's duplicate response. No raw SMS is selected. */
export async function recoverPaymentActivityMentions(settings:SupabaseSettings,ownerId:string,now=new Date(),deadlineAt=Date.now()+10_000,loaded?:{ownerId:string;preferences:NotificationPreferences}):Promise<number>{
  const prefs=loaded?.ownerId===ownerId?loaded.preferences:await loadNotificationPreferences(settings,ownerId);
  const window=(enabled:boolean|undefined,value:string|null|undefined)=>enabled&&value&&Number.isFinite(Date.parse(value))?new Date(Math.max(Date.parse(value),now.getTime()-MENTION_MAX_AGE_MS)):null;
  const incomingSince=window(prefs.paymentMentions,prefs.paymentMentionsSince),outgoingSince=window(prefs.outgoingMentions,prefs.outgoingMentionsSince);
  if(!incomingSince&&!outgoingSince)return 0;
  const since=new Date(Math.min(...[incomingSince,outgoingSince].filter((value):value is Date=>value!==null).map(value=>value.getTime())));
  const rows=await query<CandidateRow>(settings,`select b.id::text,b.owner_id::text,b.channel,b.direction,b.kind,b.amount::text,b.fee::text,b.currency,b.counterparty,
    b.occurred_at,b.created_at,b.status,b.transaction_id::text,b.fee_transaction_id::text,b.read_by,
    t.owner_id::text as purpose_owner_id,t.transaction_id::text as purpose_transaction_id,t.category as purpose_category,t.description as purpose_description,t.status as purpose_record_status,
    t.type as principal_type,t.amount::text as principal_amount,t.currency as principal_currency
    from public.bank_messages b left join public.bank_notice_receipts r on r.owner_id=b.owner_id and r.bank_message_id=b.id
    left join public.transactions t on t.owner_id=b.owner_id and t.transaction_id=b.transaction_id and t.status='active'
    where b.owner_id=$1::uuid and r.bank_message_id is null and b.channel in ('mac','shortcut') and b.amount>0
      and ${ACTIVITY_STATE_SQL}
      and exists(select 1 from public.alfred_bank_notice_readiness(b.owner_id,b.id,now()) n where n.state='ready')
      and ((b.direction='in' and b.occurred_at>=$4::timestamptz and b.created_at>=$4::timestamptz)
        or (b.direction='out' and b.occurred_at>=$5::timestamptz and b.created_at>=$5::timestamptz))
      and b.occurred_at>=$2::timestamptz and b.created_at>=$2::timestamptz
      and b.occurred_at<=$3::timestamptz and b.created_at<=$3::timestamptz
    order by b.created_at,b.id limit 10`,[ownerId,since.toISOString(),new Date(now.getTime()+5*60_000).toISOString(),incomingSince?.toISOString()??null,outgoingSince?.toISOString()??null]);
  const candidates=rows.map(r=>({id:r.id,ownerId:r.owner_id,channel:r.channel,direction:r.direction,kind:r.kind,amount:r.amount,fee:r.fee??'0.00',currency:r.currency,counterparty:r.counterparty,
    occurredAt:r.occurred_at.toISOString(),createdAt:r.created_at.toISOString(),status:r.status,transactionId:r.transaction_id,feeTransactionId:r.fee_transaction_id,readBy:r.read_by,
    principalType:r.principal_type??null,principalAmount:r.principal_amount??null,principalCurrency:r.principal_currency??null,
    purpose:r.purpose_owner_id&&r.purpose_transaction_id?{ownerId:r.purpose_owner_id,transactionId:r.purpose_transaction_id,category:r.purpose_category??'',description:r.purpose_description??'',recordStatus:r.purpose_record_status??''}:null}));
  return writePaymentMentions(ownerId,prefs,candidates,now,async(candidate,mention)=>{
    const source={direction:candidate.direction,kind:candidate.kind,amount:candidate.amount,fee:candidate.fee,currency:candidate.currency,counterparty:candidate.counterparty,readBy:candidate.readBy,feeTransactionId:candidate.feeTransactionId,principalType:candidate.principalType,principalAmount:candidate.principalAmount,principalCurrency:candidate.principalCurrency};
    const result=await query<{written:boolean}>(settings,`select public.alfred_record_bank_activity_notice($1::uuid,$2::uuid,$3,$4,$5,$6,$7::uuid,$8::boolean,$9::jsonb,$10::jsonb) as written`,
      [ownerId,candidate.id,mention.clientId,mention.body,mention.ledgerChanged,candidate.status,candidate.transactionId,mention.requiresPurpose,candidate.purpose?JSON.stringify(candidate.purpose):null,JSON.stringify(source)]);
    return result[0]?.written===true;
  },deadlineAt);
}
/** Compatibility export: callers now recover each explicitly enabled direction. */
export const recoverIncomingPaymentMentions=recoverPaymentActivityMentions;
export async function recoverAllPaymentActivityMentions(settings:SupabaseSettings,now=new Date()):Promise<number>{
  const deadlineAt=Date.now()+10_000;
  const owners=await query<{owner_id:string}>(settings,`select distinct p.owner_id::text from public.notification_preferences p join public.bank_messages b on b.owner_id=p.owner_id
    left join public.bank_notice_receipts r on r.owner_id=b.owner_id and r.bank_message_id=b.id
    where r.bank_message_id is null and b.channel in ('mac','shortcut') and b.amount>0 and ${ACTIVITY_STATE_SQL}
      and exists(select 1 from public.alfred_bank_notice_readiness(b.owner_id,b.id,now()) n where n.state='ready')
      and ((b.direction='in' and p.payment_mentions and b.occurred_at>=p.payment_mentions_since and b.created_at>=p.payment_mentions_since)
        or (b.direction='out' and p.outgoing_mentions and b.occurred_at>=p.outgoing_mentions_since and b.created_at>=p.outgoing_mentions_since))
      and b.occurred_at>now()-interval '24 hours'
    order by p.owner_id::text limit 10`);
  let count=0;for(const row of owners){if(Date.now()>=deadlineAt)break;count+=await recoverPaymentActivityMentions(settings,row.owner_id,now,deadlineAt);}
  return count;
}
export const recoverAllIncomingPaymentMentions=recoverAllPaymentActivityMentions;
