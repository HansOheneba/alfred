import { createHash } from "node:crypto";
import type { SupabaseSettings } from "@/lib/config";
import { query } from "@/lib/supabase/connection";
import { validateSubscription, type QueuedPushKind, type PushSubscriptionRecord } from "./push";

export type NotificationPreferences = {
  paymentMentions: boolean; outgoingMentions: boolean; paymentPush: boolean; billReminders: boolean; weeklyOverview: boolean;
  paymentMentionsSince: string | null; outgoingMentionsSince: string | null; paymentPushSince: string | null;
  billRemindersSince: string | null; weeklyOverviewSince: string | null;
};
export type PreferencePatch = Partial<Pick<NotificationPreferences,"paymentMentions"|"outgoingMentions"|"paymentPush"|"billReminders"|"weeklyOverview">>;
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  paymentMentions:false,outgoingMentions:false,paymentPush:false,billReminders:false,weeklyOverview:false,
  paymentMentionsSince:null,outgoingMentionsSince:null,paymentPushSince:null,billRemindersSince:null,weeklyOverviewSince:null,
};
type PreferenceRow = {
  payment_mentions:boolean;outgoing_mentions:boolean;payment_push:boolean;bill_reminders:boolean;weekly_overview:boolean;
  payment_mentions_since:Date|string|null;outgoing_mentions_since:Date|string|null;payment_push_since:Date|string|null;
  bill_reminders_since:Date|string|null;weekly_overview_since:Date|string|null;
};
export type Execute = <T extends Record<string,unknown>>(settings:SupabaseSettings,sql:string,values?:unknown[])=>Promise<T[]>;
const date = (value: Date|string|null) => value instanceof Date ? value.toISOString() : value;
const preferences = (row?:PreferenceRow):NotificationPreferences => row ? {
  paymentMentions:row.payment_mentions,outgoingMentions:row.outgoing_mentions,paymentPush:row.payment_push,billReminders:row.bill_reminders,weeklyOverview:row.weekly_overview,
  paymentMentionsSince:date(row.payment_mentions_since),outgoingMentionsSince:date(row.outgoing_mentions_since),paymentPushSince:date(row.payment_push_since),
  billRemindersSince:date(row.bill_reminders_since),weeklyOverviewSince:date(row.weekly_overview_since),
} : {...DEFAULT_NOTIFICATION_PREFERENCES};
export type QueuedDelivery = {
  id:string;ownerId:string;subscriptionId:string;kind:QueuedPushKind;eventKey:string;resourceId:string|null;
  targetDate:string|null;attempts:number;subscription:PushSubscriptionRecord;
};
type DeliveryRow = {id:string;owner_id:string;subscription_id:string;kind:QueuedPushKind;event_key:string;resource_id:string|null;target_date:string|null;attempts:number;subscription:PushSubscriptionRecord};
const fromDelivery=(r:DeliveryRow):QueuedDelivery=>({id:r.id,ownerId:r.owner_id,subscriptionId:r.subscription_id,kind:r.kind,eventKey:r.event_key,resourceId:r.resource_id,targetDate:r.target_date,attempts:r.attempts,subscription:r.subscription});
export const PREFERENCE_COLUMNS = `payment_mentions,outgoing_mentions,payment_push,bill_reminders,weekly_overview,payment_mentions_since,outgoing_mentions_since,payment_push_since,bill_reminders_since,weekly_overview_since`;

export function createNotificationStore(settings:SupabaseSettings,execute:Execute=query) {
  return {
    async preferences(ownerId:string):Promise<NotificationPreferences> {
      const rows=await execute<PreferenceRow>(settings,`select ${PREFERENCE_COLUMNS} from public.notification_preferences where owner_id=$1::uuid`,[ownerId]);
      return preferences(rows[0]);
    },
    async update(ownerId:string,patch:PreferencePatch):Promise<NotificationPreferences> {
      // Null means preserve. A false->true transition establishes a new opt-in
      // window; changing epochs prevents old queued work reviving after re-enable.
      const values=[ownerId,patch.paymentMentions??null,patch.paymentPush??null,patch.billReminders??null,patch.weeklyOverview??null,patch.outgoingMentions??null];
      const rows=await execute<PreferenceRow>(settings,`insert into public.notification_preferences as p
        (owner_id,payment_mentions,payment_push,bill_reminders,weekly_overview,outgoing_mentions,payment_mentions_since,payment_push_since,bill_reminders_since,weekly_overview_since,outgoing_mentions_since,payment_epoch,bill_epoch,weekly_epoch)
        values($1::uuid,coalesce($2::boolean,false),coalesce($3::boolean,false),coalesce($4::boolean,false),coalesce($5::boolean,false),coalesce($6::boolean,false),
          case when $2 then now() end,case when $3 then now() end,case when $4 then now() end,case when $5 then now() end,case when $6 then now() end,
          case when $3 then 1 else 0 end,case when $4 then 1 else 0 end,case when $5 then 1 else 0 end)
        on conflict(owner_id) do update set
          payment_mentions=coalesce($2,p.payment_mentions),outgoing_mentions=coalesce($6,p.outgoing_mentions),payment_push=coalesce($3,p.payment_push),
          bill_reminders=coalesce($4,p.bill_reminders),weekly_overview=coalesce($5,p.weekly_overview),
          payment_mentions_since=case when $2=false then null when $2=true and not p.payment_mentions then now() else p.payment_mentions_since end,
          outgoing_mentions_since=case when $6=false then null when $6=true and not p.outgoing_mentions then now() else p.outgoing_mentions_since end,
          payment_push_since=case when $3=false then null when $3=true and not p.payment_push then now() else p.payment_push_since end,
          bill_reminders_since=case when $4=false then null when $4=true and not p.bill_reminders then now() else p.bill_reminders_since end,
          weekly_overview_since=case when $5=false then null when $5=true and not p.weekly_overview then now() else p.weekly_overview_since end,
          payment_epoch=p.payment_epoch+case when $3 is not null and $3 is distinct from p.payment_push then 1 else 0 end,
          bill_epoch=p.bill_epoch+case when $4 is not null and $4 is distinct from p.bill_reminders then 1 else 0 end,
          weekly_epoch=p.weekly_epoch+case when $5 is not null and $5 is distinct from p.weekly_overview then 1 else 0 end,
          updated_at=now() returning ${PREFERENCE_COLUMNS}`,values);
      return preferences(rows[0]);
    },
    async devices(ownerId:string):Promise<{id:string;createdAt:string}[]> {
      const rows=await execute<{id:string;created_at:Date|string}>(settings,`select id::text,created_at from public.push_subscriptions where owner_id=$1::uuid and (expires_at is null or expires_at>now()) order by created_at`,[ownerId]);
      return rows.map(r=>({id:r.id,createdAt:date(r.created_at)!}));
    },
    async subscribe(ownerId:string,input:unknown):Promise<string> {
      const subscription=await validateSubscription(input);
      const hash=createHash("sha256").update(subscription.endpoint).digest("hex");
      const rows=await execute<{id:string}>(settings,`insert into public.push_subscriptions as s(owner_id,endpoint_hash,subscription,expires_at)
        values($1::uuid,$2,$3::jsonb,$4::timestamptz)
        on conflict(endpoint_hash) do update set subscription=excluded.subscription,expires_at=excluded.expires_at,updated_at=now()
        where s.owner_id=excluded.owner_id returning id::text`,[ownerId,hash,JSON.stringify(subscription),subscription.expirationTime?new Date(subscription.expirationTime).toISOString():null]);
      if(!rows[0]) throw Error("This browser subscription cannot be reassigned. Unsubscribe in the browser and enable it again.");
      return rows[0].id;
    },
    async deviceForEndpoint(ownerId:string,endpoint:string):Promise<{id:string;createdAt:string}|null> {
      const hash=createHash("sha256").update(endpoint).digest("hex");
      const rows=await execute<{id:string;created_at:Date|string}>(settings,`select id::text,created_at from public.push_subscriptions where owner_id=$1::uuid and endpoint_hash=$2 and (expires_at is null or expires_at>now())`,[ownerId,hash]);
      return rows[0]?{id:rows[0].id,createdAt:date(rows[0].created_at)!}:null;
    },
    async unsubscribe(ownerId:string,input:{id?:string;endpoint?:string}):Promise<void> {
      if(input.id)await execute(settings,`delete from public.push_subscriptions where owner_id=$1::uuid and id=$2::uuid`,[ownerId,input.id]);
      else if(input.endpoint)await execute(settings,`delete from public.push_subscriptions where owner_id=$1::uuid and endpoint_hash=$2`,[ownerId,createHash("sha256").update(input.endpoint).digest("hex")]);
    },
    async enqueuePayment(ownerId:string,messageId:string):Promise<number> {
      const rows=await execute<{id:string}>(settings,`insert into public.notification_deliveries(owner_id,subscription_id,kind,event_key,resource_id,preference_epoch)
        select p.owner_id,s.id,'payment','payment:'||b.id::text,b.id,p.payment_epoch
        from public.notification_preferences p join public.bank_messages b on b.owner_id=p.owner_id
        join public.push_subscriptions s on s.owner_id=p.owner_id
        where p.owner_id=$1::uuid and b.id=$2::uuid and p.payment_push and p.payment_push_since is not null
          and b.channel in ('mac','shortcut') and b.amount>0 and b.kind='payment'
          and b.status in ('needs_label','recorded') and b.occurred_at>=p.payment_push_since and b.created_at>=p.payment_push_since
          and b.occurred_at>=s.created_at and (s.expires_at is null or s.expires_at>now())
        on conflict(owner_id,subscription_id,event_key) do nothing returning id::text`,[ownerId,messageId]);
      return rows.length;
    },
    async enqueueScheduled(ownerId:string,kind:"bill"|"weekly",eventKey:string,resourceId:string|null,targetDate:string):Promise<number> {
      const enabled=kind==="bill"?"bill_reminders":"weekly_overview",epoch=kind==="bill"?"bill_epoch":"weekly_epoch";
      const rows=await execute<{id:string}>(settings,`insert into public.notification_deliveries(owner_id,subscription_id,kind,event_key,resource_id,target_date,preference_epoch)
        select p.owner_id,s.id,$2,$3,$4::uuid,$5::date,p.${epoch}
        from public.notification_preferences p join public.push_subscriptions s on s.owner_id=p.owner_id
        where p.owner_id=$1::uuid and p.${enabled} and (s.expires_at is null or s.expires_at>now())
        on conflict(owner_id,subscription_id,event_key) do nothing returning id::text`,[ownerId,kind,eventKey,resourceId,targetDate]);
      return rows.length;
    },
    async pending(ownerId:string,now:Date):Promise<QueuedDelivery[]> {
      const rows=await execute<DeliveryRow>(settings,`select d.id::text,d.owner_id::text,d.subscription_id::text,d.kind,d.event_key,d.resource_id::text,d.target_date::text,d.attempts,s.subscription
        from public.notification_deliveries d join public.push_subscriptions s on s.id=d.subscription_id and s.owner_id=d.owner_id
        where d.owner_id=$1::uuid and d.status='queued' and d.next_attempt_at<=$2::timestamptz and d.attempts<3
        order by d.created_at limit 25`,[ownerId,now.toISOString()]);
      return rows.map(fromDelivery);
    },
    async claim(ownerId:string,id:string,now:Date):Promise<QueuedDelivery|null> {
      const rows=await execute<DeliveryRow>(settings,`update public.notification_deliveries d set status='attempted',attempts=d.attempts+1,attempted_at=$3::timestamptz,updated_at=$3::timestamptz
        from public.push_subscriptions s,public.notification_preferences p
        where d.id=$2::uuid and d.owner_id=$1::uuid and s.id=d.subscription_id and s.owner_id=d.owner_id and p.owner_id=d.owner_id
          and d.status='queued' and d.attempts<3 and d.next_attempt_at<=$3::timestamptz
          and (s.expires_at is null or s.expires_at>$3::timestamptz)
          and ((d.kind='payment' and p.payment_push and d.preference_epoch=p.payment_epoch and exists(select 1 from public.bank_messages b where b.id=d.resource_id and b.owner_id=d.owner_id and b.kind='payment' and b.status in ('needs_label','recorded') and b.channel in ('mac','shortcut') and b.amount>0))
            or (d.kind='bill' and p.bill_reminders and d.preference_epoch=p.bill_epoch and exists(select 1 from public.bills b where b.id=d.resource_id and b.owner_id=d.owner_id and b.active))
            or (d.kind='weekly' and p.weekly_overview and d.preference_epoch=p.weekly_epoch))
        returning d.id::text,d.owner_id::text,d.subscription_id::text,d.kind,d.event_key,d.resource_id::text,d.target_date::text,d.attempts,s.subscription`,[ownerId,id,now.toISOString()]);
      return rows[0]?fromDelivery(rows[0]):null;
    },
    async finish(ownerId:string,id:string,result:{status:"accepted"|"rejected"|"unconfirmed"|"queued"|"canceled";reason:string;nextAttempt?:Date}):Promise<void> {
      await execute(settings,`update public.notification_deliveries set status=$3,last_result=$4,next_attempt_at=coalesce($5::timestamptz,next_attempt_at),updated_at=now()
        where owner_id=$1::uuid and id=$2::uuid and status='attempted'`,[ownerId,id,result.status,result.reason,result.nextAttempt?.toISOString()??null]);
    },
    async cancel(ownerId:string,id:string):Promise<void> {
      await execute(settings,`update public.notification_deliveries set status='canceled',last_result='ineligible',updated_at=now() where owner_id=$1::uuid and id=$2::uuid and status='queued'`,[ownerId,id]);
    },
  };
}
export type NotificationStore=ReturnType<typeof createNotificationStore>;
export const loadNotificationPreferences=(settings:SupabaseSettings,ownerId:string)=>createNotificationStore(settings).preferences(ownerId);
export const updateNotificationPreferences=(settings:SupabaseSettings,ownerId:string,patch:PreferencePatch)=>createNotificationStore(settings).update(ownerId,patch);
