import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it, vi } from "vitest";
import type { SupabaseSettings } from "@/lib/config";
import { createMessageNotificationStore, recoverOwnerMessageNotifications, type MessageNotificationStore, type MessageSender } from "@/lib/notifications/messages";
import type { Execute } from "@/lib/notifications/store";
import { PushFailure } from "@/lib/notifications/push";

const owner = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222";
const message = "33333333-3333-4333-8333-333333333333", device = "44444444-4444-4444-8444-444444444444", presence = "55555555-5555-4555-8555-555555555555";
const settings = {} as SupabaseSettings;
const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/fictional-only", keys: { p256dh: "sample", auth: "sample" } };

async function database() {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated;
    create table public.profiles(id uuid primary key);
    create table public.messages(id uuid primary key,owner_id uuid not null references profiles(id),role text not null,body text not null,created_at timestamptz not null default now(),intent text);
    create table public.push_subscriptions(id uuid primary key,owner_id uuid not null references profiles(id),subscription jsonb not null,created_at timestamptz not null default now(),expires_at timestamptz);
    create table public.notification_preferences(owner_id uuid primary key,payment_push boolean not null default false,payment_push_since timestamptz,card_activity_push_since timestamptz not null default now());
    create table public.bank_messages(id uuid primary key,owner_id uuid,kind text,status text,direction text,channel text,amount numeric,occurred_at timestamptz,created_at timestamptz,readiness_state text default 'ready');
    create table public.bank_notice_receipts(owner_id uuid,bank_message_id uuid,message_id uuid);
    create table public.notification_deliveries(owner_id uuid,subscription_id uuid,event_key text,status text);
    create function public.alfred_bank_notice_readiness(owner uuid,bank uuid,at_time timestamptz) returns table(state text) language sql as $$select readiness_state from bank_messages where owner_id=owner and id=bank$$;
    insert into public.profiles values('${owner}'),('${other}');`);
  await db.exec(await readFile(new URL("../supabase/migrations/20261105100000_message_notifications.sql", import.meta.url), "utf8"));
  const execute: Execute = async (_settings, sql, values = []) => (await db.query(sql, values)).rows as never;
  return { db, store: createMessageNotificationStore(settings, execute) };
}

describe("message notification database contract", () => {
  it("owner-scopes unread cursors, preserves monotonic reads, and isolates visible tabs", async () => {
    const { db, store } = await database();
    try {
      await db.exec(`insert into messages values('${message}','${owner}','assistant','Fictional earlier message',now()-interval '1 hour');`);
      expect(await store.snapshot(owner)).toMatchObject({ initialized: false, unreadCount: 0, preferences: { messagePush: false, messagePreview: false } });
      await store.initialize(owner);
      const next = "66666666-6666-4666-8666-666666666666", foreign = "77777777-7777-4777-8777-777777777777";
      await db.exec(`insert into messages values('${next}','${owner}','assistant','Fictional new message',now()+interval '1 second'),('${foreign}','${other}','assistant','Other owner private message',now()+interval '1 second');`);
      expect(await store.snapshot(owner)).toMatchObject({ initialized: true, unreadCount: 1, latestMessageId: next });
      expect(await store.read(owner, foreign, presence, true)).toBe(false);
      expect((await store.snapshot(owner)).unreadCount).toBe(1);
      expect(await store.read(owner, next, presence, true)).toBe(true);
      expect((await store.snapshot(owner)).unreadCount).toBe(0);
      await store.read(owner, message, presence, false);
      expect((await store.snapshot(owner)).unreadCount).toBe(0);
      const unseen = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      await db.exec(`insert into messages values('${unseen}','${owner}','assistant','Fictional unseen message',now()+interval '2 seconds');`);
      await store.read(owner, unseen, presence, false);
      expect((await store.snapshot(owner)).unreadCount).toBe(1);
      expect((await db.query<{ allowed: boolean }>("select has_table_privilege('authenticated','public.chat_message_read_state','select') as allowed")).rows[0].allowed).toBe(false);
      const second = "88888888-8888-4888-8888-888888888888";
      await store.read(owner, unseen, second, true);
      const rows = await db.query<{ active: string }>("select count(*)::text as active from chat_message_presence where owner_id=$1 and visible_until>now()", [owner]);
      expect(rows.rows[0].active).toBe("1");
      await store.read(owner, null, presence, false);
      expect((await db.query<{ active: string }>("select count(*)::text as active from chat_message_presence where owner_id=$1 and visible_until>now()", [owner])).rows[0].active).toBe("1");
    } finally { await db.close(); }
  }, 20_000);
  it("enqueues only unread post-opt-in messages and dedupes existing payment/card jobs", async () => {
    const { db, store } = await database();
    try {
      await db.query(`insert into push_subscriptions(id,owner_id,subscription,created_at) values($1,$2,$3::jsonb,now()-interval '2 hours')`, [device, owner, JSON.stringify(subscription)]);
      await db.exec(`insert into chat_message_notification_preferences(owner_id,message_push,message_push_since,preference_epoch) values('${owner}',true,now()-interval '1 hour',1);
        insert into messages values('${message}','${owner}','assistant','Fictional new reply',now()-interval '30 minutes'),
          ('66666666-6666-4666-8666-666666666666','${owner}','assistant','Old history',now()-interval '3 hours'),
          ('77777777-7777-4777-8777-777777777777','${other}','assistant','Other owner',now()-interval '1 minute');`);
      await store.initialize(owner);
      await expect(db.query("insert into chat_message_notification_deliveries(owner_id,message_id,subscription_id,preference_epoch) values($1,$2,$3,1)", [owner, "77777777-7777-4777-8777-777777777777", device])).rejects.toMatchObject({ code: "23503" });
      const now = new Date();
      expect(await store.enqueue(owner, now)).toBe(1); expect(await store.enqueue(owner, now)).toBe(0);
      const pending = await store.pending(owner, now); expect(pending).toHaveLength(1);
      const claimed = await store.claim(owner, pending[0].id, now); expect(claimed?.messageId).toBe(message);
      expect(await store.consent(owner, pending[0].id, now)).toMatchObject({ state: "ready", preview: false });
      await store.update(owner, { messagePreview: true });
      expect(await store.consent(owner, pending[0].id, now)).toMatchObject({ preview: true, text: "Fictional new reply" });
      await store.read(owner, message, presence, true);
      expect((await db.query<{ status: string }>("select status from chat_message_notification_deliveries where id=$1", [pending[0].id])).rows[0].status).toBe("attempted");
      expect(await store.consent(owner, pending[0].id, now)).toBeNull();
      await store.finish(owner, pending[0].id, { status: "canceled", reason: "read" });

      const bank = "99999999-9999-4999-8999-999999999999", bankNotice = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      await db.exec(`insert into messages values('${bankNotice}','${owner}','assistant','Fictional card hold',now(),'automation:outgoing-payment');
        insert into notification_preferences values('${owner}',true,now()-interval '1 hour',now()-interval '1 hour');
        insert into bank_messages values('${bank}','${owner}','card_hold','needs_label','out','mac',1,now(),now(),'ready');
        insert into bank_notice_receipts values('${owner}','${bank}','${bankNotice}');`);
      expect(await store.enqueue(owner, new Date())).toBe(0);
      await db.exec(`update notification_preferences set payment_push=false where owner_id='${owner}';
        insert into notification_deliveries values('${owner}','${device}','payment:${bank}','unconfirmed');`);
      expect(await store.enqueue(owner, new Date())).toBe(0);
      await db.exec("delete from notification_deliveries;");
      await db.exec("update bank_messages set readiness_state='held';");
      expect(await store.enqueue(owner, new Date())).toBe(0);
      await db.exec("update bank_messages set readiness_state='ready';");
      expect(await store.enqueue(owner, new Date())).toBe(1);
      const cardJob = (await store.pending(owner, new Date()))[0];
      expect(await store.claim(owner, cardJob.id, new Date())).toBeNull(); // Existing lease defers until its view is updated.
      await store.read(owner, message, presence, true); // A stale heartbeat must not suppress the newer unread card notice.
      expect(await store.claim(owner, cardJob.id, new Date())).not.toBeNull();
      await store.read(owner, null, presence, false);
      await store.update(owner, { messagePush: false });
      expect(await store.consent(owner, cardJob.id, new Date())).toBeNull();
      expect((await db.query<{ status: string }>("select status from chat_message_notification_deliveries where id=$1", [cardJob.id])).rows[0].status).toBe("attempted");

      await store.update(owner, { messagePush: true });
      const fresh = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", later = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      await db.exec(`insert into messages values('${fresh}','${owner}','assistant','Fictional unread reply',now()+interval '1 second');`);
      expect(await store.enqueue(owner, new Date())).toBe(1);
      const queuedRead = (await store.pending(owner, new Date()))[0];
      await store.read(owner, fresh, presence, true);
      expect((await db.query<{ status: string }>("select status from chat_message_notification_deliveries where id=$1", [queuedRead.id])).rows[0].status).toBe("canceled");
      await db.exec(`insert into messages values('${later}','${owner}','assistant','Fictional later reply',now()+interval '2 seconds');`);
      expect(await store.enqueue(owner, new Date())).toBe(1);
      const queuedMute = (await store.pending(owner, new Date()))[0];
      await store.update(owner, { messagePush: false });
      expect((await db.query<{ status: string }>("select status from chat_message_notification_deliveries where id=$1", [queuedMute.id])).rows[0].status).toBe("canceled");
    } finally { await db.close(); }
  }, 20_000);
  it.each(["enqueue", "claim", "consent"])("enforces bank source history cutoffs at %s even for a newly recovered Chat notice", async phase => {
    const { db, store } = await database();
    try {
      const card = "99999999-9999-4999-8999-999999999999", cardNotice = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      await db.query(`insert into push_subscriptions(id,owner_id,subscription,created_at) values($1,$2,$3::jsonb,now()-interval '20 minutes')`, [device, owner, JSON.stringify(subscription)]);
      await db.exec(`insert into chat_message_notification_preferences(owner_id,message_push,message_push_since,preference_epoch) values('${owner}',true,now()-interval '20 minutes',1);
        insert into notification_preferences values('${owner}',false,null,now()-interval '30 minutes');
        insert into messages values('${message}','${owner}','assistant','Fictional new ordinary reply',now()-interval '1 minute',null),
          ('${cardNotice}','${owner}','assistant','Newly recovered fictional card notice',now()-interval '1 minute','automation:outgoing-payment');
        insert into bank_messages values('${card}','${owner}','card_hold','needs_label','out','mac',1,now()-interval '${phase === "enqueue" ? "1 hour" : "5 minutes"}',now()-interval '${phase === "enqueue" ? "1 hour" : "5 minutes"}','ready');
        insert into bank_notice_receipts values('${owner}','${card}','${cardNotice}');`);
      expect(await store.enqueue(owner, new Date())).toBe(phase === "enqueue" ? 1 : 2);
      const jobs = await store.pending(owner, new Date()), cardJob = jobs.find(job => job.messageId === cardNotice), ordinary = jobs.find(job => job.messageId === message);
      expect(ordinary).toBeDefined();
      if (phase === "enqueue") expect(cardJob).toBeUndefined();
      else {
        if (phase === "consent") expect(await store.claim(owner, cardJob!.id, new Date())).not.toBeNull();
        await db.exec(`update bank_messages set occurred_at=now()-interval '1 hour',created_at=now()-interval '1 hour' where id='${card}';`);
        if (phase === "claim") {
          expect(await store.claim(owner, cardJob!.id, new Date())).toBeNull();
          await store.cancelIneligible(owner, cardJob!.id, new Date());
          expect((await db.query<{ status: string }>("select status from chat_message_notification_deliveries where id=$1", [cardJob!.id])).rows[0].status).toBe("canceled");
        } else expect(await store.consent(owner, cardJob!.id, new Date())).toBeNull();
      }
      expect(await store.claim(owner, ordinary!.id, new Date())).not.toBeNull();
    } finally { await db.close(); }
  }, 20_000);
  it("independently checks source creation and occurrence against opt-in, device and card rollout", async () => {
    const { db, store } = await database();
    try {
      const card = "99999999-9999-4999-8999-999999999999";
      await db.query(`insert into push_subscriptions(id,owner_id,subscription,created_at) values($1,$2,$3::jsonb,now()-interval '30 minutes')`, [device, owner, JSON.stringify(subscription)]);
      await db.exec(`insert into chat_message_notification_preferences(owner_id,message_push,message_push_since,preference_epoch) values('${owner}',true,now()-interval '30 minutes',1);
        insert into notification_preferences values('${owner}',false,null,now()-interval '30 minutes');
        insert into messages values('${message}','${owner}','assistant','Fictional card notice',now()-interval '1 minute','automation:outgoing-payment');
        insert into bank_messages values('${card}','${owner}','card_hold','needs_label','out','mac',1,now(),now(),'ready');
        insert into bank_notice_receipts values('${owner}','${card}','${message}');`);
      for (const boundary of ["message", "device", "rollout"]) {
        await db.exec(`update chat_message_notification_preferences set message_push_since=now()-interval '${boundary === "message" ? 10 : 30} minutes';
          update push_subscriptions set created_at=now()-interval '${boundary === "device" ? 10 : 30} minutes';
          update notification_preferences set card_activity_push_since=now()-interval '${boundary === "rollout" ? 10 : 30} minutes';`);
        for (const older of ["created_at", "occurred_at"]) {
          await db.exec(`update bank_messages set created_at=now()-interval '${older === "created_at" ? 15 : 5} minutes',occurred_at=now()-interval '${older === "occurred_at" ? 15 : 5} minutes';`);
          expect(await store.enqueue(owner, new Date())).toBe(0);
        }
      }
      await db.exec("update notification_preferences set card_activity_push_since=now()-interval '30 minutes';");
      expect(await store.enqueue(owner, new Date())).toBe(1);
    } finally { await db.close(); }
  }, 20_000);
});

function fakeStore(patch: Partial<MessageNotificationStore> = {}): MessageNotificationStore {
  return { available: vi.fn(async () => true), enqueue: vi.fn(async () => 1), pending: vi.fn(async () => [{ id: "job", ownerId: owner, messageId: message, subscriptionId: device, attempts: 0, subscription }]),
    claim: vi.fn(async () => ({ id: "job", ownerId: owner, messageId: message, subscriptionId: device, attempts: 1, subscription })),
    consent: vi.fn(async () => ({ state: "ready" as const, preview: false, text: "Private financial sample" })), finish: vi.fn(async () => {}), cancelIneligible: vi.fn(async () => {}), defer: vi.fn(async () => {}), unsubscribe: vi.fn(async () => {}),
    snapshot: vi.fn(), initialize: vi.fn(), read: vi.fn(), update: vi.fn(), owners: vi.fn(), dispatched: vi.fn(), ...patch };
}
const configuration = { publicKey: "fictional", privateKey: "fictional", subject: "mailto:fictional@example.test" };
describe("message push outcomes", () => {
  it("keeps body text out of a discreet push, and rechecks preview consent before send", async () => {
    const store = fakeStore(), send = vi.fn<MessageSender>(async () => new Response(null, { status: 201 }));
    const result = await recoverOwnerMessageNotifications(settings, owner, new Date(), { store, send, configuration, deliveryEnabled: true, recoveryReady: true });
    expect(result.accepted).toBe(1); expect(send.mock.calls[0][2]).toEqual({ id: message });
    const preview = fakeStore({ consent: vi.fn(async () => ({ state: "ready" as const, preview: true, text: "Opted-in preview" })) });
    await recoverOwnerMessageNotifications(settings, owner, new Date(), { store: preview, send, configuration, deliveryEnabled: true, recoveryReady: true });
    expect(send.mock.calls[1][2]).toEqual({ id: message, text: "Opted-in preview" });
  });
  it("does not send visible/read/opted-out sources, and never retries ambiguous connection outcomes", async () => {
    const send = vi.fn(async () => { throw new Error("Fictional lost response"); }), store = fakeStore();
    expect((await recoverOwnerMessageNotifications(settings, owner, new Date(), { store, send, configuration, deliveryEnabled: true, recoveryReady: true })).unconfirmed).toBe(1);
    expect(store.finish).toHaveBeenCalledWith(owner, "job", { status: "unconfirmed", reason: "connection-unconfirmed" }); expect(send).toHaveBeenCalledOnce();
    const visible = fakeStore({ consent: vi.fn(async () => ({ state: "visible" as const, preview: false, text: "" })) });
    await recoverOwnerMessageNotifications(settings, owner, new Date(), { store: visible, send, configuration, deliveryEnabled: true, recoveryReady: true });
    expect(visible.defer).toHaveBeenCalledOnce(); expect(send).toHaveBeenCalledOnce();
    const read = fakeStore({ consent: vi.fn(async () => null) });
    await recoverOwnerMessageNotifications(settings, owner, new Date(), { store: read, send, configuration, deliveryEnabled: true, recoveryReady: true });
    expect(read.finish).toHaveBeenCalledWith(owner, "job", { status: "canceled", reason: "message-read-or-consent-changed" }); expect(send).toHaveBeenCalledOnce();
  });
  it("never attempts delivery without configured transport, delivery switch and recovery health", async () => {
    const store = fakeStore(), send = vi.fn();
    for (const overrides of [{ configuration: null }, { deliveryEnabled: false }, { recoveryReady: false }]) await recoverOwnerMessageNotifications(settings, owner, new Date(), { store, send, configuration, deliveryEnabled: true, recoveryReady: true, ...overrides });
    expect(send).not.toHaveBeenCalled(); expect(store.enqueue).not.toHaveBeenCalled();
  });
  it("retries a known preparation failure without starting transport and distinguishes exhausted encryption", async () => {
    const send = vi.fn(), store = fakeStore({ consent: vi.fn(async () => { throw new Error("Fictional preparation read failed"); }) });
    await recoverOwnerMessageNotifications(settings, owner, new Date(), { store, send, configuration, deliveryEnabled: true, recoveryReady: true });
    expect(send).not.toHaveBeenCalled(); expect(store.finish).toHaveBeenCalledWith(owner, "job", expect.objectContaining({ status: "queued", reason: "message-preparation-unavailable" }));
    const exhausted = fakeStore({ claim: vi.fn(async () => ({ id: "job", ownerId: owner, messageId: message, subscriptionId: device, attempts: 3, subscription })) });
    const failedSend = vi.fn(async () => { throw new PushFailure("encryption"); });
    const result = await recoverOwnerMessageNotifications(settings, owner, new Date(), { store: exhausted, send: failedSend, configuration, deliveryEnabled: true, recoveryReady: true });
    expect(result.rejected).toBe(1); expect(result.unconfirmed).toBe(0); expect(exhausted.finish).toHaveBeenCalledWith(owner, "job", { status: "rejected", reason: "encryption" });
  });
});
