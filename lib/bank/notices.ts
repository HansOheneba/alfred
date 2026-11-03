import { createHash } from "node:crypto";
import type { BankMessage } from "@/lib/bank/store";
import type { SupabaseSettings } from "@/lib/config";
import { formatAmount } from "@/lib/finance/money";
import { loadNotificationPreferences, type NotificationPreferences } from "@/lib/notifications/store";
import { query } from "@/lib/supabase/connection";
import { knownPaymentPurpose,type StoredPaymentPurpose } from "./purpose";

/** Deterministic private app copy; excluded from push payloads and model history. */
export type MentionCandidate = Pick<BankMessage,
  "id"|"ownerId"|"channel"|"direction"|"kind"|"amount"|"currency"|"counterparty"|"occurredAt"|"status"|"transactionId"|"feeTransactionId"|"readBy"> & { createdAt: string;purpose?:StoredPaymentPurpose|null };
export type PaymentMention = {clientId:string;body:string;intent:"automation:incoming-payment";ledgerChanged:boolean;requiresPurpose:boolean};
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
export function mentionEligible(message:MentionCandidate,ownerId:string,prefs:NotificationPreferences,now:Date):boolean {
  if(!prefs.paymentMentions||!prefs.paymentMentionsSince||message.ownerId!==ownerId)return false;
  const since=Math.max(Date.parse(prefs.paymentMentionsSince),now.getTime()-MENTION_MAX_AGE_MS);
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
    const mention=incomingPaymentMention(candidate);
    if(mention&&await save(candidate,mention))written++;
  }
  return written;
}

type CandidateRow={id:string;owner_id:string;channel:BankMessage['channel'];direction:BankMessage['direction'];kind:BankMessage['kind'];amount:string;currency:string;counterparty:string;occurred_at:Date;created_at:Date;status:BankMessage['status'];transaction_id:string|null;fee_transaction_id:string|null;read_by:BankMessage['readBy'];purpose_owner_id:string|null;purpose_transaction_id:string|null;purpose_category:string|null;purpose_description:string|null;purpose_record_status:string|null};
/** Recovery is bounded and independent of ingestion's duplicate response. No raw SMS is selected. */
export async function recoverIncomingPaymentMentions(settings:SupabaseSettings,ownerId:string,now=new Date(),deadlineAt=Date.now()+10_000,loaded?:{ownerId:string;preferences:NotificationPreferences}):Promise<number>{
  // This snapshot only avoids a duplicate read. The atomic receipt function
  // still rechecks the owner's live mute choice and activation date on write.
  const prefs=loaded?.ownerId===ownerId?loaded.preferences:await loadNotificationPreferences(settings,ownerId);
  if(!prefs.paymentMentions||!prefs.paymentMentionsSince)return 0;
  const since=new Date(Math.max(Date.parse(prefs.paymentMentionsSince),now.getTime()-MENTION_MAX_AGE_MS));
  const rows=await query<CandidateRow>(settings,`select b.id::text,b.owner_id::text,b.channel,b.direction,b.kind,b.amount::text,b.currency,b.counterparty,
    b.occurred_at,b.created_at,b.status,b.transaction_id::text,b.fee_transaction_id::text,b.read_by,
    t.owner_id::text as purpose_owner_id,t.transaction_id::text as purpose_transaction_id,t.category as purpose_category,t.description as purpose_description,t.status as purpose_record_status
    from public.bank_messages b left join public.bank_notice_receipts r on r.owner_id=b.owner_id and r.bank_message_id=b.id
    left join public.transactions t on t.owner_id=b.owner_id and t.transaction_id=b.transaction_id and t.status='active'
    where b.owner_id=$1::uuid and r.bank_message_id is null and b.channel in ('mac','shortcut') and b.direction='in'
      and b.kind in ('payment','unknown') and (b.status='needs_label' or (b.status in ('recorded','matched') and b.transaction_id is not null)) and b.amount>0
      and b.occurred_at>=$2::timestamptz and b.created_at>=$2::timestamptz
      and b.occurred_at<=$3::timestamptz and b.created_at<=$3::timestamptz
    order by b.created_at,b.id limit 10`,[ownerId,since.toISOString(),new Date(now.getTime()+5*60_000).toISOString()]);
  const candidates=rows.map(r=>({id:r.id,ownerId:r.owner_id,channel:r.channel,direction:r.direction,kind:r.kind,amount:r.amount,currency:r.currency,counterparty:r.counterparty,
    occurredAt:r.occurred_at.toISOString(),createdAt:r.created_at.toISOString(),status:r.status,transactionId:r.transaction_id,feeTransactionId:r.fee_transaction_id,readBy:r.read_by,
    purpose:r.purpose_owner_id&&r.purpose_transaction_id?{ownerId:r.purpose_owner_id,transactionId:r.purpose_transaction_id,category:r.purpose_category??'',description:r.purpose_description??'',recordStatus:r.purpose_record_status??''}:null}));
  return writePaymentMentions(ownerId,prefs,candidates,now,async(candidate,mention)=>{
    const result=await query<{written:boolean}>(settings,`select public.alfred_record_bank_notice($1::uuid,$2::uuid,$3,$4,$5,$6,$7::uuid,$8::boolean,$9::jsonb) as written`,
      [ownerId,candidate.id,mention.clientId,mention.body,mention.ledgerChanged,candidate.status,candidate.transactionId,mention.requiresPurpose,candidate.purpose?JSON.stringify(candidate.purpose):null]);
    return result[0]?.written===true;
  },deadlineAt);
}
/** Optional scheduler recovery; no scheduler is configured by this code. */
export async function recoverAllIncomingPaymentMentions(settings:SupabaseSettings,now=new Date()):Promise<number>{
  const deadlineAt=Date.now()+10_000;
  const owners=await query<{owner_id:string}>(settings,`select distinct p.owner_id::text from public.notification_preferences p join public.bank_messages b on b.owner_id=p.owner_id
    left join public.bank_notice_receipts r on r.owner_id=b.owner_id and r.bank_message_id=b.id
    where p.payment_mentions and r.bank_message_id is null and b.direction='in' and b.kind in ('payment','unknown') and b.channel in ('mac','shortcut')
      and b.occurred_at>=p.payment_mentions_since and b.created_at>=p.payment_mentions_since and b.occurred_at>now()-interval '24 hours'
      and (b.status='needs_label' or (b.status in ('recorded','matched') and b.transaction_id is not null)) order by p.owner_id::text limit 10`);
  let count=0;for(const row of owners){if(Date.now()>=deadlineAt)break;count+=await recoverIncomingPaymentMentions(settings,row.owner_id,now,deadlineAt);}
  return count;
}
