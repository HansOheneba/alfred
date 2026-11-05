import type { SupabaseSettings } from "@/lib/config";
import { query } from "@/lib/supabase/connection";
import { PushFailure, pushConfiguration, sendWebPush, type PushConfiguration, type PushSubscriptionRecord } from "./push";
import { loadRecoveryStatus, recoveryConfiguration } from "./recovery";
import type { Execute } from "./store";

export type MessageNotificationPreferences = { messagePush: boolean; messagePreview: boolean; messagePushSince: string | null };
export type MessageNotificationSnapshot = { initialized: boolean; unreadCount: number; latestMessageId: string | null; preferences: MessageNotificationPreferences };
type PreferencesRow = { message_push: boolean; message_preview: boolean; message_push_since: Date | string | null };
const preferences = (row?: PreferencesRow): MessageNotificationPreferences => ({ messagePush: row?.message_push === true, messagePreview: row?.message_preview === true, messagePushSince: row?.message_push_since ? new Date(row.message_push_since).toISOString() : null });
const zeroId = "00000000-0000-0000-0000-000000000000";

/** Existing payment work owns matching bank alerts. Never send two notifications
 * for the same source merely because it also produced a durable Chat message. */
const coveredByPayment = `exists(select 1 from public.bank_notice_receipts br
  join public.bank_messages b on b.owner_id=br.owner_id and b.id=br.bank_message_id
  left join public.notification_preferences pp on pp.owner_id=b.owner_id
  where br.owner_id=m.owner_id and br.message_id=m.id and (
    exists(select 1 from public.notification_deliveries prior where prior.owner_id=b.owner_id and prior.subscription_id=s.id
      and prior.event_key='payment:'||b.id::text and prior.status in ('attempted','accepted','unconfirmed'))
    or (pp.payment_push and pp.payment_push_since is not null
    and b.channel in ('mac','shortcut') and b.amount>0
    and ((b.kind='payment' and b.status in ('needs_label','recorded')) or (b.kind='transfer_own' and b.status='transfer')
      or (b.direction='out' and b.kind in ('card_hold','hold_settle') and b.status in ('needs_label','recorded','matched')))
    and (b.kind not in ('card_hold','hold_settle') or (b.created_at>=pp.card_activity_push_since and b.occurred_at>=pp.card_activity_push_since))
    and b.created_at>=pp.payment_push_since and b.occurred_at>=pp.payment_push_since and b.occurred_at>=s.created_at
    and exists(select 1 from public.alfred_bank_notice_readiness(b.owner_id,b.id,$2::timestamptz) n where n.state='ready'))))`;
const unread = `(r.owner_id is null or (m.created_at,m.id)>(r.read_created_at,coalesce(r.read_message_id,'${zeroId}'::uuid)))`;
const sourceReady = `((coalesce(m.intent,'') not in ('automation:incoming-payment','automation:outgoing-payment')
    and not exists(select 1 from public.bank_notice_receipts receipt where receipt.owner_id=m.owner_id and receipt.message_id=m.id)) or exists(
  select 1 from public.bank_notice_receipts source_receipt
    join public.bank_messages bank_source on bank_source.owner_id=source_receipt.owner_id and bank_source.id=source_receipt.bank_message_id
    left join public.notification_preferences card_policy on card_policy.owner_id=bank_source.owner_id
  where source_receipt.owner_id=m.owner_id and source_receipt.message_id=m.id and bank_source.channel in ('mac','shortcut') and bank_source.amount>0
    and bank_source.created_at>=p.message_push_since and bank_source.occurred_at>=p.message_push_since
    and bank_source.created_at>=s.created_at and bank_source.occurred_at>=s.created_at
    and bank_source.created_at<=$2::timestamptz+interval '5 minutes' and bank_source.occurred_at<=$2::timestamptz+interval '5 minutes'
    and (bank_source.kind not in ('card_hold','hold_settle') or (
      bank_source.created_at>=coalesce(card_policy.card_activity_push_since,p.message_push_since)
      and bank_source.occurred_at>=coalesce(card_policy.card_activity_push_since,p.message_push_since)))
    and exists(select 1 from public.alfred_bank_notice_readiness(m.owner_id,bank_source.id,$2::timestamptz) n where n.state='ready')))`;
const eligible = `p.message_push and p.message_push_since is not null and d.preference_epoch=p.preference_epoch
  and m.role='assistant' and length(btrim(m.body))>0 and m.created_at>=p.message_push_since and m.created_at>=s.created_at
  and m.created_at<=$2::timestamptz+interval '5 minutes' and (s.expires_at is null or s.expires_at>$2::timestamptz)
  and ${unread} and ${sourceReady} and not (${coveredByPayment})`;
type MessageDelivery = { id: string; ownerId: string; messageId: string; subscriptionId: string; attempts: number; subscription: PushSubscriptionRecord };
type DeliveryRow = { id: string; owner_id: string; message_id: string; subscription_id: string; attempts: number; subscription: PushSubscriptionRecord };
const delivery = (row: DeliveryRow): MessageDelivery => ({ id: row.id, ownerId: row.owner_id, messageId: row.message_id, subscriptionId: row.subscription_id, attempts: row.attempts, subscription: row.subscription });

export function createMessageNotificationStore(settings: SupabaseSettings, execute: Execute = query) {
  return {
    async available(): Promise<boolean> {
      const rows = await execute<{ ready: boolean }>(settings, `select to_regclass('public.chat_message_notification_preferences') is not null
        and to_regclass('public.chat_message_read_state') is not null and to_regclass('public.chat_message_presence') is not null
        and to_regclass('public.chat_message_notification_deliveries') is not null
        and exists(select 1 from pg_attribute where attrelid=to_regclass('public.notification_preferences')
          and attname='card_activity_push_since' and atttypid='timestamptz'::regtype and not attisdropped) as ready`);
      return rows[0]?.ready === true;
    },
    async snapshot(ownerId: string): Promise<MessageNotificationSnapshot> {
      const [prefs, rows] = await Promise.all([
        execute<PreferencesRow>(settings, "select message_push,message_preview,message_push_since from public.chat_message_notification_preferences where owner_id=$1::uuid", [ownerId]),
        execute<{ initialized: boolean; unread_count: string; latest_message_id: string | null }>(settings, `select exists(select 1 from public.chat_message_read_state where owner_id=$1::uuid) as initialized,
          (select count(*)::text from public.messages m left join public.chat_message_read_state r on r.owner_id=m.owner_id
            left join public.chat_message_notification_preferences p on p.owner_id=m.owner_id
            where m.owner_id=$1::uuid and m.role='assistant' and length(btrim(m.body))>0
              and m.created_at>=coalesce(r.started_at,p.message_push_since,now()) and ${unread}) as unread_count,
          (select id::text from public.messages where owner_id=$1::uuid and role='assistant' and length(btrim(body))>0 order by created_at desc,id desc limit 1) as latest_message_id`, [ownerId]),
      ]);
      return { initialized: rows[0]?.initialized === true, unreadCount: Math.min(9999, Math.max(0, Number(rows[0]?.unread_count ?? 0))), latestMessageId: rows[0]?.latest_message_id ?? null, preferences: preferences(prefs[0]) };
    },
    async initialize(ownerId: string): Promise<void> {
      await execute(settings, `insert into public.chat_message_read_state(owner_id,started_at,read_created_at)
        select $1::uuid,coalesce(p.message_push_since,now()),coalesce(p.message_push_since,now())
        from (select 1) seed left join public.chat_message_notification_preferences p on p.owner_id=$1::uuid
        on conflict(owner_id) do nothing`, [ownerId]);
    },
    async read(ownerId: string, messageId: string | null, presenceId: string, active: boolean): Promise<boolean> {
      const rows = await execute<{ changed: boolean }>(settings, `with target as (
          select id,created_at from public.messages where owner_id=$1::uuid and id=$2::uuid and role='assistant' and length(btrim(body))>0
        ), valid as (select $2::uuid is null or exists(select 1 from target) as ok),
        state as (insert into public.chat_message_read_state as r(owner_id,started_at,read_created_at,read_message_id)
          select $1::uuid,coalesce(p.message_push_since,now()),case when $4::boolean then coalesce(t.created_at,p.message_push_since,now()) else coalesce(p.message_push_since,now()) end,case when $4::boolean then t.id end
          from valid v left join target t on true left join public.chat_message_notification_preferences p on p.owner_id=$1::uuid where v.ok
          on conflict(owner_id) do update set
            read_created_at=case when $4::boolean and $2::uuid is not null and (excluded.read_created_at,excluded.read_message_id)>(r.read_created_at,coalesce(r.read_message_id,'${zeroId}'::uuid)) then excluded.read_created_at else r.read_created_at end,
            read_message_id=case when $4::boolean and $2::uuid is not null and (excluded.read_created_at,excluded.read_message_id)>(r.read_created_at,coalesce(r.read_message_id,'${zeroId}'::uuid)) then excluded.read_message_id else r.read_message_id end,
            updated_at=now() returning owner_id,read_created_at,read_message_id),
        read_jobs as (update public.chat_message_notification_deliveries d set status='canceled',last_result='message-read',updated_at=now()
          from state r,public.messages m where d.owner_id=r.owner_id and d.status='queued' and m.owner_id=d.owner_id and m.id=d.message_id
            and (m.created_at,m.id)<=(r.read_created_at,coalesce(r.read_message_id,'${zeroId}'::uuid)) returning d.id),
        pruned as (delete from public.chat_message_presence where owner_id=$1::uuid and presence_id<>$3::uuid and visible_until<now()-interval '1 hour' returning presence_id),
        presence as (insert into public.chat_message_presence(owner_id,presence_id,visible_until)
          select $1::uuid,$3::uuid,case when $4::boolean and (
              ($2::uuid is null and not exists(select 1 from public.messages latest where latest.owner_id=$1::uuid and latest.role='assistant' and length(btrim(latest.body))>0))
              or exists(select 1 from target t where not exists(select 1 from public.messages newer where newer.owner_id=$1::uuid and newer.role='assistant'
                and length(btrim(newer.body))>0 and (newer.created_at,newer.id)>(t.created_at,t.id)))
            ) then now()+interval '30 seconds' else now() end from valid where ok
            and (exists(select 1 from public.chat_message_presence where owner_id=$1::uuid and presence_id=$3::uuid)
              or (select count(*) from public.chat_message_presence where owner_id=$1::uuid)-(select count(*) from pruned)<256)
          on conflict(owner_id,presence_id) do update set visible_until=excluded.visible_until returning owner_id)
        select exists(select 1 from state) and exists(select 1 from presence) as changed`, [ownerId, messageId, presenceId, active]);
      return rows[0]?.changed === true;
    },
    async update(ownerId: string, patch: Partial<Pick<MessageNotificationPreferences, "messagePush" | "messagePreview">>): Promise<MessageNotificationPreferences> {
      const rows = await execute<PreferencesRow>(settings, `with updated as (insert into public.chat_message_notification_preferences as p(owner_id,message_push,message_preview,message_push_since,preference_epoch)
        values($1::uuid,coalesce($2::boolean,false),coalesce($3::boolean,false),case when $2 then now() end,case when $2 then 1 else 0 end)
        on conflict(owner_id) do update set message_push=coalesce($2,p.message_push),message_preview=coalesce($3,p.message_preview),
          message_push_since=case when $2=false then null when $2=true and not p.message_push then now() else p.message_push_since end,
          preference_epoch=p.preference_epoch+case when $2 is not null and $2 is distinct from p.message_push then 1 else 0 end,updated_at=now()
        returning owner_id,message_push,message_preview,message_push_since,preference_epoch),
        canceled as (update public.chat_message_notification_deliveries d set status='canceled',last_result='preference-changed',updated_at=now()
          from updated p where d.owner_id=p.owner_id and d.status='queued' and (not p.message_push or d.preference_epoch<>p.preference_epoch) returning d.id)
        select message_push,message_preview,message_push_since from updated`, [ownerId, patch.messagePush ?? null, patch.messagePreview ?? null]);
      return preferences(rows[0]);
    },
    async enqueue(ownerId: string, now: Date): Promise<number> {
      const rows = await execute<{ id: string }>(settings, `insert into public.chat_message_notification_deliveries(owner_id,message_id,subscription_id,preference_epoch,next_attempt_at)
        select m.owner_id,m.id,s.id,p.preference_epoch,$2::timestamptz from public.messages m
        join public.chat_message_notification_preferences p on p.owner_id=m.owner_id
        join public.push_subscriptions s on s.owner_id=m.owner_id
        left join public.chat_message_read_state r on r.owner_id=m.owner_id
        where m.owner_id=$1::uuid and p.message_push and p.message_push_since is not null and m.role='assistant' and length(btrim(m.body))>0
          and m.created_at>=p.message_push_since and m.created_at>=s.created_at and m.created_at<=$2::timestamptz+interval '5 minutes'
          and (s.expires_at is null or s.expires_at>$2::timestamptz) and ${unread} and ${sourceReady} and not (${coveredByPayment})
          and not exists(select 1 from public.chat_message_notification_deliveries prior where prior.owner_id=m.owner_id and prior.message_id=m.id and prior.subscription_id=s.id)
        order by m.created_at,m.id limit 50 on conflict(owner_id,message_id,subscription_id) do nothing returning id::text`, [ownerId, now.toISOString()]);
      return rows.length;
    },
    async pending(ownerId: string, now: Date): Promise<MessageDelivery[]> {
      const rows = await execute<DeliveryRow>(settings, `select d.id::text,d.owner_id::text,d.message_id::text,d.subscription_id::text,d.attempts,s.subscription
        from public.chat_message_notification_deliveries d join public.push_subscriptions s on s.owner_id=d.owner_id and s.id=d.subscription_id
        where d.owner_id=$1::uuid and d.status='queued' and d.attempts<3 and d.next_attempt_at<=$2::timestamptz order by d.created_at,d.id limit 3`, [ownerId, now.toISOString()]);
      return rows.map(delivery);
    },
    async claim(ownerId: string, id: string, now: Date): Promise<MessageDelivery | null> {
      const rows = await execute<DeliveryRow>(settings, `update public.chat_message_notification_deliveries d set status='attempted',attempts=d.attempts+1,attempted_at=$2::timestamptz,updated_at=$2::timestamptz
        from public.chat_message_notification_preferences p,public.push_subscriptions s,public.messages m
        left join public.chat_message_read_state r on r.owner_id=m.owner_id
        where d.owner_id=$1::uuid and d.id=$3::uuid and d.status='queued' and d.attempts<3 and d.next_attempt_at<=$2::timestamptz
          and p.owner_id=d.owner_id and s.owner_id=d.owner_id and s.id=d.subscription_id and m.owner_id=d.owner_id and m.id=d.message_id
          and ${eligible} and not exists(select 1 from public.chat_message_presence v where v.owner_id=d.owner_id and v.visible_until>$2::timestamptz)
        returning d.id::text,d.owner_id::text,d.message_id::text,d.subscription_id::text,d.attempts,s.subscription`, [ownerId, now.toISOString(), id]);
      return rows[0] ? delivery(rows[0]) : null;
    },
    async consent(ownerId: string, id: string, now: Date): Promise<{ state: "ready" | "visible"; preview: boolean; text: string } | null> {
      const rows = await execute<{ message_preview: boolean; body: string; visible: boolean }>(settings, `select p.message_preview,m.body,
        exists(select 1 from public.chat_message_presence v where v.owner_id=d.owner_id and v.visible_until>$2::timestamptz) as visible
        from public.chat_message_notification_deliveries d join public.chat_message_notification_preferences p on p.owner_id=d.owner_id
        join public.push_subscriptions s on s.owner_id=d.owner_id and s.id=d.subscription_id join public.messages m on m.owner_id=d.owner_id and m.id=d.message_id
        left join public.chat_message_read_state r on r.owner_id=m.owner_id
        where d.owner_id=$1::uuid and d.id=$3::uuid and d.status='attempted' and ${eligible}`, [ownerId, now.toISOString(), id]);
      return rows[0] ? { state: rows[0].visible ? "visible" : "ready", preview: rows[0].message_preview === true, text: rows[0].body } : null;
    },
    async cancelIneligible(ownerId: string, id: string, now: Date): Promise<void> {
      await execute(settings, `update public.chat_message_notification_deliveries d set status='canceled',last_result='ineligible',updated_at=$2::timestamptz
        where d.owner_id=$1::uuid and d.id=$3::uuid and d.status='queued' and not exists(
          select 1 from public.chat_message_notification_preferences p join public.push_subscriptions s on s.owner_id=p.owner_id and s.id=d.subscription_id
          join public.messages m on m.owner_id=p.owner_id and m.id=d.message_id left join public.chat_message_read_state r on r.owner_id=m.owner_id
          where p.owner_id=d.owner_id and ${eligible})`, [ownerId, now.toISOString(), id]);
    },
    async defer(ownerId: string, id: string, now: Date): Promise<void> {
      await execute(settings, `update public.chat_message_notification_deliveries set status='queued',attempts=greatest(0,attempts-1),next_attempt_at=$3::timestamptz+interval '30 seconds',last_result='chat-visible',updated_at=$3::timestamptz where owner_id=$1::uuid and id=$2::uuid and status='attempted'`, [ownerId, id, now.toISOString()]);
    },
    async finish(ownerId: string, id: string, outcome: { status: string; reason: string; nextAttempt?: Date }): Promise<void> {
      await execute(settings, `update public.chat_message_notification_deliveries set status=$3,last_result=$4,next_attempt_at=coalesce($5::timestamptz,next_attempt_at),updated_at=now() where owner_id=$1::uuid and id=$2::uuid and status='attempted'`, [ownerId, id, outcome.status, outcome.reason, outcome.nextAttempt?.toISOString() ?? null]);
    },
    async unsubscribe(ownerId: string, id: string): Promise<void> {
      await execute(settings, "delete from public.push_subscriptions where owner_id=$1::uuid and id=$2::uuid", [ownerId, id]);
    },
    async owners(now: Date): Promise<string[]> {
      const rows = await execute<{ owner_id: string }>(settings, `select p.owner_id::text from public.chat_message_notification_preferences p where p.message_push
        and exists(select 1 from public.push_subscriptions s where s.owner_id=p.owner_id and (s.expires_at is null or s.expires_at>$1::timestamptz))
        order by p.last_dispatch_at nulls first,p.owner_id limit 10`, [now.toISOString()]);
      return rows.map(row => row.owner_id);
    },
    async dispatched(ownerId: string, now: Date): Promise<void> {
      await execute(settings, "update public.chat_message_notification_preferences set last_dispatch_at=$2::timestamptz where owner_id=$1::uuid", [ownerId, now.toISOString()]);
    },
  };
}

export type MessageNotificationStore = ReturnType<typeof createMessageNotificationStore>;
export type MessageSender = (subscription: PushSubscriptionRecord, config: PushConfiguration, message: { id: string; text?: string }) => Promise<Response>;
export type MessageDeliveryOptions = { store?: MessageNotificationStore; send?: MessageSender; now?: Date; configuration?: PushConfiguration | null; deliveryEnabled?: boolean; recoveryReady?: boolean; clock?: () => number; timeBudgetMs?: number };
export type MessageDeliverySummary = { available: boolean; enabled: boolean; recoveryReady: boolean; queued: number; attempted: number; accepted: number; deferred: number; canceled: number; unconfirmed: number; rejected: number };

/** No arbitrary message body enters the queue. Source, read state and latest
 * preview consent are reloaded immediately before the provider call. */
export async function recoverOwnerMessageNotifications(settings: SupabaseSettings, ownerId: string, now = new Date(), options: MessageDeliveryOptions = {}): Promise<MessageDeliverySummary> {
  const store = options.store ?? createMessageNotificationStore(settings), clock = options.clock ?? Date.now;
  const deadline = clock() + Math.min(20_000, Math.max(0, options.timeBudgetMs ?? 20_000));
  const configuration = options.configuration === undefined ? pushConfiguration().config : options.configuration;
  const result: MessageDeliverySummary = { available: await store.available(), enabled: options.deliveryEnabled ?? process.env.ALFRED_PUSH_DELIVERY_ENABLED === "true", recoveryReady: false, queued: 0, attempted: 0, accepted: 0, deferred: 0, canceled: 0, unconfirmed: 0, rejected: 0 };
  if (!result.available || !result.enabled || !configuration) return result;
  result.recoveryReady = options.recoveryReady ?? (await loadRecoveryStatus(settings, { now })).ready;
  if (!result.recoveryReady) return result;
  result.queued = await store.enqueue(ownerId, now);
  for (const candidate of await store.pending(ownerId, now)) {
    if (clock() + 17_000 > deadline) { result.deferred++; continue; }
    const claim = await store.claim(ownerId, candidate.id, now);
    if (!claim) { await store.cancelIneligible(ownerId, candidate.id, now); result.deferred++; continue; }
    let consent: Awaited<ReturnType<MessageNotificationStore["consent"]>>;
    try { consent = await store.consent(ownerId, claim.id, now); }
    catch {
      // No provider call has begun. A failed preparation read can be retried safely.
      await store.finish(ownerId, claim.id, { status: claim.attempts < 3 ? "queued" : "rejected", reason: "message-preparation-unavailable", ...(claim.attempts < 3 ? { nextAttempt: new Date(now.getTime() + 60_000 * claim.attempts) } : {}) });
      if (claim.attempts < 3) result.deferred++; else result.rejected++;
      continue;
    }
    if (!consent) { await store.finish(ownerId, claim.id, { status: "canceled", reason: "message-read-or-consent-changed" }); result.canceled++; continue; }
    if (consent.state === "visible" || clock() + 17_000 > deadline) { await store.defer(ownerId, claim.id, now); result.deferred++; continue; }
    let outcome: { status: "accepted" | "queued" | "rejected" | "unconfirmed"; reason: string; nextAttempt?: Date };
    result.attempted++;
    try {
      const send: MessageSender = options.send ?? ((subscription, config, message) => sendWebPush(subscription, config, "message", undefined, undefined, undefined, message));
      const response = await send(claim.subscription, configuration, { id: claim.messageId, ...(consent.preview ? { text: consent.text } : {}) });
      if (response.status === 404 || response.status === 410) await store.unsubscribe(ownerId, claim.subscriptionId);
      if (response.status >= 200 && response.status < 300) outcome = { status: "accepted", reason: "provider-accepted" };
      else if ([429, 500, 502, 503, 504].includes(response.status) && claim.attempts < 3) outcome = { status: "queued", reason: `HTTP-${response.status}`, nextAttempt: new Date(now.getTime() + 60_000 * claim.attempts) };
      else outcome = { status: "rejected", reason: `HTTP-${response.status}` };
    } catch (error) {
      outcome = error instanceof PushFailure && error.stage !== "connection"
        ? claim.attempts < 3 ? { status: "queued", reason: error.stage, nextAttempt: new Date(now.getTime() + 60_000 * claim.attempts) } : { status: "rejected", reason: error.stage }
        : { status: "unconfirmed", reason: "connection-unconfirmed" };
    }
    await store.finish(ownerId, claim.id, outcome);
    if (outcome.status === "accepted") result.accepted++;
    else if (outcome.status === "unconfirmed") result.unconfirmed++;
    else if (outcome.status === "queued") result.deferred++;
    else result.rejected++;
  }
  return result;
}

/** Called by the existing authenticated scheduler, not by a browser poll. */
export async function dispatchMessageNotifications(settings: SupabaseSettings, now = new Date(), options: MessageDeliveryOptions = {}): Promise<{ available: boolean; owners: number; queued: number; attempted: number }> {
  const store = options.store ?? createMessageNotificationStore(settings);
  if (!await store.available()) return { available: false, owners: 0, queued: 0, attempted: 0 };
  if (!recoveryConfiguration().configured && options.recoveryReady === undefined) return { available: true, owners: 0, queued: 0, attempted: 0 };
  const deadline = (options.clock ?? Date.now)() + Math.max(0, Math.min(45_000, options.timeBudgetMs ?? 45_000));
  let owners = 0, queued = 0, attempted = 0;
  for (const owner of await store.owners(now)) {
    if ((options.clock ?? Date.now)() + 17_000 > deadline) break;
    const result = await recoverOwnerMessageNotifications(settings, owner, now, { ...options, store, timeBudgetMs: Math.min(20_000, deadline - (options.clock ?? Date.now)()) });
    await store.dispatched(owner, now);
    queued += result.queued; attempted += result.attempted; owners++;
  }
  return { available: true, owners, queued, attempted };
}

/** Eager best-effort delivery after a durable reply; the scheduler repairs gaps. */
export function deliverOwnerMessageNotifications(settings: SupabaseSettings, ownerId: string, options: MessageDeliveryOptions = {}): Promise<MessageDeliverySummary> {
  return recoverOwnerMessageNotifications(settings, ownerId, options.now ?? new Date(), options);
}
