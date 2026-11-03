import type { SupabaseSettings } from "@/lib/config";
import { nextOccurrence } from "@/lib/finance/bill-schedule";
import { query } from "@/lib/supabase/connection";
import { createNotificationStore, type NotificationStore, type QueuedDelivery } from "./store";
import { PushFailure, pushConfiguration, sendWebPush, type PushConfiguration, type QueuedPushKind, type PushSubscriptionRecord } from "./push";
import { loadRecoveryStatus, recoveryConfiguration } from "./recovery";

type Sender=(subscription:PushSubscriptionRecord,configuration:PushConfiguration,kind:QueuedPushKind,targetId?:string)=>Promise<Response>;
export type DeliveryOptions={now?:Date;store?:NotificationStore;send?:Sender;configuration?:PushConfiguration|null;deliveryEnabled?:boolean;timeZone?:string;maxAttemptsPerRun?:number;timeBudgetMs?:number;clock?:()=>number;recoveryReady?:boolean};
export type DeliverySummary={configured:boolean;enabled:boolean;recoveryReady:boolean;attempted:number;accepted:number;retrying:number;rejected:number;unconfirmed:number;skipped:number;deferred:number};
export function localClock(now:Date,timeZone:string):{day:string;hour:number;weekday:string} {
  const p=new Intl.DateTimeFormat("en-CA",{timeZone,year:"numeric",month:"2-digit",day:"2-digit",hour:"numeric",hourCycle:"h23",weekday:"short"}).formatToParts(now);
  const part=(kind:Intl.DateTimeFormatPartTypes)=>p.find(x=>x.type===kind)?.value??"";
  return {day:`${part("year")}-${part("month")}-${part("day")}`,hour:Number(part("hour")),weekday:part("weekday")};
}
export function pushResult(status:number|"authorization"|"encryption"|"connection",attempts:number,now:Date) {
  if(status==="connection")return {status:"unconfirmed" as const,reason:"connection-unconfirmed"};
  if(typeof status==="number"&&status>=200&&status<300)return {status:"accepted" as const,reason:"provider-accepted"};
  const retry=status==="authorization"||status==="encryption"||[429,500,502,503,504].includes(Number(status));
  if(retry&&attempts<3)return {status:"queued" as const,reason:typeof status==="number"?`HTTP-${status}`:status,nextAttempt:new Date(now.getTime()+60_000*attempts)};
  return {status:"rejected" as const,reason:typeof status==="number"?`HTTP-${status}`:status};
}
async function ownerZone(settings:SupabaseSettings,ownerId:string):Promise<string> {
  const rows=await query<{timezone:string}>(settings,"select timezone from public.profiles where id=$1::uuid",[ownerId]);
  try{new Intl.DateTimeFormat("en",{timeZone:rows[0]?.timezone}).format();return rows[0]?.timezone??"Africa/Accra";}catch{return "Africa/Accra";}
}
export async function enqueuePaymentNotice(settings:SupabaseSettings,ownerId:string,bankMessageId:string):Promise<number> {
  return createNotificationStore(settings).enqueuePayment(ownerId,bankMessageId);
}
/** Recover bank-commit/enqueue gaps, including duplicate ingestion retries. No history replay. */
export async function recoverPaymentNotifications(settings:SupabaseSettings,ownerId:string,options:{deadlineAt?:number;limit?:number}={}):Promise<number> {
  const deadline=options.deadlineAt??Date.now()+5_000,limit=Math.max(1,Math.min(options.limit??10,50));
  if(Date.now()>=deadline)return 0;
  const missing=await query<{id:string}>(settings,`select b.id::text from public.bank_messages b join public.notification_preferences p on p.owner_id=b.owner_id
    where b.owner_id=$1::uuid and p.payment_push and b.channel in ('mac','shortcut') and b.kind='payment' and b.amount>0
      and b.status in ('needs_label','recorded') and b.created_at>=p.payment_push_since and b.occurred_at>=p.payment_push_since
      and exists(select 1 from public.alfred_bank_notice_readiness(b.owner_id,b.id,now()) n where n.state='ready')
      and exists(select 1 from public.push_subscriptions s where s.owner_id=b.owner_id and s.created_at<=b.occurred_at
        and (s.expires_at is null or s.expires_at>now()) and not exists(select 1 from public.notification_deliveries d
          where d.owner_id=b.owner_id and d.subscription_id=s.id and d.event_key='payment:'||b.id::text))
    order by b.created_at limit $2::integer`,[ownerId,limit]);
  let queued=0;for(const row of missing){if(Date.now()>=deadline)break;queued+=await enqueuePaymentNotice(settings,ownerId,row.id);}
  return queued;
}
async function stillScheduled(settings:SupabaseSettings,delivery:QueuedDelivery,now:Date,timeZone:string):Promise<boolean> {
  // Payment nudges are immediate at every local hour. Only bill and weekly
  // notices use a time window; device/system notification settings still apply.
  if(delivery.kind==="payment")return true;
  const clock=localClock(now,timeZone);
  if(delivery.kind==="weekly")return clock.weekday==="Sun"&&clock.hour===18&&delivery.targetDate===clock.day&&await recentAcceptedAlert(settings,delivery.ownerId,now);
  if(clock.hour!==9||!delivery.resourceId)return false;
  const rows=await query<{next_date:string;cadence:"once"|"weekly"|"monthly"|"yearly";active:boolean}>(settings,
    "select next_date::text,cadence,active from public.bills where owner_id=$1::uuid and id=$2::uuid",[delivery.ownerId,delivery.resourceId]);
  const bill=rows[0];
  return !!bill?.active&&nextOccurrence({nextDate:bill.next_date,cadence:bill.cadence,active:bill.active},clock.day)===delivery.targetDate&&delivery.targetDate===addDay(clock.day);
}
export async function drainOwnerNotifications(settings:SupabaseSettings,ownerId:string,options:DeliveryOptions={}):Promise<DeliverySummary> {
  const clock=options.clock??Date.now,deadline=clock()+Math.max(0,Math.min(options.timeBudgetMs??20_000,20_000));
  const now=options.now??new Date(),store=options.store??createNotificationStore(settings);
  const configuration=options.configuration===undefined?pushConfiguration().config:options.configuration;
  const enabled=options.deliveryEnabled??process.env.ALFRED_PUSH_DELIVERY_ENABLED==="true";
  const result:DeliverySummary={configured:!!configuration,enabled,recoveryReady:false,attempted:0,accepted:0,retrying:0,rejected:0,unconfirmed:0,skipped:0,deferred:0};
  if(!enabled||!configuration)return result;
  const zone=options.timeZone??await ownerZone(settings,ownerId);
  result.recoveryReady=options.recoveryReady??(await loadRecoveryStatus(settings,{now})).ready;
  if(!result.recoveryReady)return result;
  const pending=await store.pending(ownerId,now),max=Math.max(1,Math.min(options.maxAttemptsPerRun??3,3));
  result.deferred=Math.max(0,pending.length-max);
  // At most three concurrent provider requests, each with a 15s timeout. Stop
  // before claiming if the serverless invocation lacks a safe completion budget.
  const runs=await Promise.allSettled(pending.slice(0,max).map(async(item)=>{
    if(clock()+17_000>deadline){result.deferred++;return;}
    if(!await stillScheduled(settings,item,now,zone)){await store.cancel(ownerId,item.id);result.skipped++;return;}
    if(clock()+17_000>deadline){result.deferred++;return;}
    const claim=await store.claim(ownerId,item.id,now);
    if(!claim){
      if(await store.deferWaiting(ownerId,item.id,now)){result.deferred++;return;}
      if(await store.cancel(ownerId,item.id,now))result.skipped++;else result.deferred++;
      return;
    }
    result.attempted++;
    let outcome:ReturnType<typeof pushResult>;
    try {
      const send:Sender=options.send??((subscription,config,kind,targetId)=>sendWebPush(subscription,config,kind,undefined,targetId));
      const response=await send(claim.subscription,configuration,claim.kind,claim.kind==="payment"?claim.resourceId??undefined:undefined);
      outcome=pushResult(response.status,claim.attempts,now);
      if(response.status===404||response.status===410)await store.unsubscribe(ownerId,{id:claim.subscriptionId});
    } catch(error) {
      // Unclassified errors could have occurred after a send; never retry them.
      outcome=pushResult(error instanceof PushFailure?error.stage:"connection",claim.attempts,now);
    }
    await store.finish(ownerId,claim.id,outcome);
    if(outcome.status==="accepted")result.accepted++;
    else if(outcome.status==="queued")result.retrying++;
    else if(outcome.status==="unconfirmed")result.unconfirmed++;
    else result.rejected++;
  }));
  if(runs.some(run=>run.status==="rejected"))throw new Error("Notification delivery bookkeeping could not complete.");
  return result;
}
function addDay(day:string):string{return new Date(Date.parse(day+"T12:00:00Z")+86_400_000).toISOString().slice(0,10);}
async function recentAcceptedAlert(settings:SupabaseSettings,ownerId:string,now:Date):Promise<boolean> {
  // Conservatively suppress weekly notices when no recent accepted provider
  // alert exists. This is not claimed to be a collector health/heartbeat check.
  const rows=await query<{fresh:boolean}>(settings,`select exists(select 1 from public.bank_messages where owner_id=$1::uuid and channel in ('mac','shortcut') and created_at>$2::timestamptz-interval '48 hours') as fresh`,[ownerId,now.toISOString()]);
  return rows[0]?.fresh===true;
}
export async function dispatchScheduledNotifications(settings:SupabaseSettings,now=new Date(),options:{delivery?:DeliveryOptions}={}):Promise<{enabled:boolean;queued:number;owners:number}> {
  if(!recoveryConfiguration().configured)return {enabled:false,queued:0,owners:0};
  const owners=await query<{owner_id:string;timezone:string;bill_reminders:boolean;weekly_overview:boolean}>(settings,`select p.owner_id::text,r.timezone,p.bill_reminders,p.weekly_overview from public.notification_preferences p join public.profiles r on r.id=p.owner_id
    where (p.bill_reminders or p.weekly_overview or p.payment_push or exists(select 1 from public.notification_deliveries d where d.owner_id=p.owner_id and d.status='queued' and d.next_attempt_at<=$1::timestamptz))
      and exists(select 1 from public.push_subscriptions s where s.owner_id=p.owner_id and (s.expires_at is null or s.expires_at>$1::timestamptz))
    order by exists(select 1 from public.notification_deliveries d where d.owner_id=p.owner_id and d.status='queued' and d.next_attempt_at<=$1::timestamptz) desc,p.last_dispatch_at nulls first,p.owner_id limit 10`,[now.toISOString()]);
  const store=createNotificationStore(settings),deadline=Date.now()+45_000;let queued=0,processed=0;
  for(const owner of owners){
    if(Date.now()+20_000>deadline)break;
    let clock:ReturnType<typeof localClock>;try{clock=localClock(now,owner.timezone);}catch{continue;}
    if(owner.bill_reminders&&clock.hour===9){
      const bills=await query<{id:string;next_date:string;cadence:"once"|"weekly"|"monthly"|"yearly";active:boolean}>(settings,"select id::text,next_date::text,cadence,active from public.bills where owner_id=$1::uuid and active",[owner.owner_id]);
      for(const bill of bills){const due=nextOccurrence({nextDate:bill.next_date,cadence:bill.cadence,active:bill.active},clock.day);if(due===addDay(clock.day))queued+=await store.enqueueScheduled(owner.owner_id,"bill",`bill:${bill.id}:${due}`,bill.id,due);}
    }
    if(owner.weekly_overview&&clock.weekday==="Sun"&&clock.hour===18&&await recentAcceptedAlert(settings,owner.owner_id,now))queued+=await store.enqueueScheduled(owner.owner_id,"weekly",`weekly:${clock.day}`,null,clock.day);
    queued+=await recoverPaymentNotifications(settings,owner.owner_id,{deadlineAt:Math.min(deadline-20_000,Date.now()+5_000),limit:10});
    await drainOwnerNotifications(settings,owner.owner_id,{...options.delivery,now,timeZone:owner.timezone});
    await query(settings,"update public.notification_preferences set last_dispatch_at=now() where owner_id=$1::uuid",[owner.owner_id]);
    processed++;
  }
  return {enabled:true,queued,owners:processed};
}
