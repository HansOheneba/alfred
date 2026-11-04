import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { createNotificationStore, type Execute } from "@/lib/notifications/store";
import type { SupabaseSettings } from "@/lib/config";
const a="00000000-0000-4000-8000-000000000001",b="00000000-0000-4000-8000-000000000002";
const message="00000000-0000-4000-8000-000000000010";
const settings={} as SupabaseSettings;
let db:PGlite,subscription:{endpoint:string;keys:{p256dh:string;auth:string}};
const execute:Execute=async<T extends Record<string,unknown>>(_s:SupabaseSettings,sql:string,values:unknown[]=[])=> (await db.query<T>(sql,values)).rows;
const store=()=>createNotificationStore(settings,execute);
async function insertMessage(owner=a,id=message,overrides:{channel?:string;status?:string;kind?:string;old?:boolean}={}) {
  await db.query(`insert into bank_messages(id,owner_id,channel,kind,status,amount,created_at,occurred_at) values($1::uuid,$2::uuid,$3,$4,$5,10,now()+interval '1 second',now()+case when $6 then interval '-7 days' else interval '1 second' end)`,[id,owner,overrides.channel??"mac",overrides.kind??"payment",overrides.status??"needs_label",overrides.old??false]);
}
async function prepare() {
  await store().update(a,{paymentPush:true});
  const device=await store().subscribe(a,subscription);
  await insertMessage();
  await store().enqueuePayment(a,message);
  return device;
}
describe("owner-scoped durable notification storage",()=>{
  beforeAll(async()=>{
    db=new PGlite();
    await db.exec(`create role anon;create role authenticated;create schema auth;create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;
      create table profiles(id uuid primary key);create table bank_messages(id uuid primary key,owner_id uuid,channel text,kind text,status text,amount numeric,created_at timestamptz,occurred_at timestamptz,direction text default 'in',counterparty text default 'Fixture',transaction_id uuid,fee_transaction_id uuid,currency text default 'GHS');
      create table transactions(owner_id uuid,transaction_id uuid,status text,type text,category text,amount numeric,currency text,source_update_id text);
      create table bills(id uuid primary key,owner_id uuid,active boolean);
      insert into profiles values('${a}'),('${b}');`);
    await db.exec(await readFile(new URL("../supabase/migrations/20261103110000_notifications.sql",import.meta.url),"utf8"));
    await db.exec(await readFile(new URL("../supabase/migrations/20261103200000_notification_recovery.sql",import.meta.url),"utf8"));
    await db.exec(await readFile(new URL("../supabase/migrations/20261103233000_payment_activity_notices.sql",import.meta.url),"utf8"));
    await db.exec(await readFile(new URL("../supabase/migrations/20261103235000_fee_notice_readiness.sql",import.meta.url),"utf8"));
    const pair=await webcrypto.subtle.generateKey({name:"ECDH",namedCurve:"P-256"},true,["deriveBits"]);
    subscription={endpoint:"https://fcm.googleapis.com/fcm/send/synthetic-fixture",keys:{p256dh:Buffer.from(await webcrypto.subtle.exportKey("raw",pair.publicKey)).toString("base64url"),auth:Buffer.alloc(16,7).toString("base64url")}};
  });
  beforeEach(async()=>{await db.exec("truncate notification_deliveries,push_subscriptions,notification_preferences,bank_messages,bills cascade");});
  afterAll(async()=>{await db.close();});
  it("defaults off, creates fresh opt-in cutoffs and preserves omitted preferences",async()=>{
    expect(await store().preferences(a)).toMatchObject({paymentMentions:false,outgoingMentions:false,outgoingMentionsSince:null,paymentPush:false,billReminders:false,weeklyOverview:false});
    const first=await store().update(a,{paymentMentions:true,paymentPush:true});
    expect(first.paymentMentionsSince).not.toBeNull();expect(first.paymentPushSince).not.toBeNull();
    expect((await store().update(a,{weeklyOverview:true})).paymentPushSince).toBe(first.paymentPushSince);
    expect((await store().update(a,{paymentPush:false})).paymentPushSince).toBeNull();
    expect((await store().preferences(b)).paymentPush).toBe(false);
  });
  it("keeps incoming and outgoing consent windows independent and resets only explicit re-enablement",async()=>{
    const incoming=await store().update(a,{paymentMentions:true});
    expect(incoming.outgoingMentions).toBe(false);expect(incoming.outgoingMentionsSince).toBeNull();
    const outgoing=await store().update(a,{outgoingMentions:true});
    expect(outgoing.outgoingMentionsSince).not.toBeNull();expect(outgoing.paymentMentionsSince).toBe(incoming.paymentMentionsSince);
    await db.exec("update notification_preferences set outgoing_mentions_since=now()-interval '1 day'");
    const older=(await store().preferences(a)).outgoingMentionsSince;
    const updated=await store().update(a,{weeklyOverview:true});
    expect(updated.outgoingMentionsSince).toBe(older);expect(updated.paymentMentionsSince).toBe(incoming.paymentMentionsSince);
    expect((await store().update(a,{paymentMentions:false})).outgoingMentions).toBe(true);
    expect((await store().update(a,{outgoingMentions:false})).outgoingMentionsSince).toBeNull();
    const enabled=await store().update(a,{outgoingMentions:true});
    expect(Date.parse(enabled.outgoingMentionsSince!)).toBeGreaterThan(Date.parse(older!));
    expect(enabled.paymentMentions).toBe(false);expect(enabled.paymentMentionsSince).toBeNull();
    expect((await store().preferences(b)).outgoingMentions).toBe(false);
  });
  it("adds outgoing consent off to a legacy incoming-only account without changing its saved window",async()=>{
    const legacy=new PGlite();
    try {
      await legacy.exec(`create role anon;create role authenticated;create schema auth;create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;
        create table profiles(id uuid primary key);create table bank_messages(id uuid primary key,owner_id uuid,channel text,kind text,status text,amount numeric,created_at timestamptz,occurred_at timestamptz);
        insert into profiles values('${a}');`);
      await legacy.exec(await readFile(new URL("../supabase/migrations/20261103110000_notifications.sql",import.meta.url),"utf8"));
      const since="2026-11-01T10:00:00.000Z";
      await legacy.query("insert into notification_preferences(owner_id,payment_mentions,payment_mentions_since) values($1::uuid,true,$2::timestamptz)",[a,since]);
      await legacy.exec(await readFile(new URL("../supabase/migrations/20261103233000_payment_activity_notices.sql",import.meta.url),"utf8"));
      const legacyExecute:Execute=async<T extends Record<string,unknown>>(_s:SupabaseSettings,text:string,values:unknown[]=[]) => (await legacy.query<T>(text,values)).rows;
      expect(await createNotificationStore(settings,legacyExecute).preferences(a)).toMatchObject({paymentMentions:true,paymentMentionsSince:since,outgoingMentions:false,outgoingMentionsSince:null});
    } finally { await legacy.close(); }
  });
  it("subscribes privately without exposing endpoint/key in device metadata; cross-owner takeover rejected",async()=>{
    const id=await store().subscribe(a,subscription);
    expect(await store().devices(a)).toEqual([{id,createdAt:expect.any(String)}]);
    expect(await store().deviceForEndpoint(b,subscription.endpoint)).toBeNull();
    await expect(store().subscribe(b,subscription)).rejects.toThrow("cannot be reassigned");
    await store().unsubscribe(b,{id});expect((await store().devices(a)).length).toBe(1);
  });
  it("enqueues exactly once for the owner/device/current epoch",async()=>{
    await prepare();expect(await store().enqueuePayment(a,message)).toBe(0);expect(await store().enqueuePayment(b,message)).toBe(0);
    expect((await store().pending(a,new Date(Date.now()+2000))).length).toBe(1);
    expect(await store().pending(b,new Date(Date.now()+2000))).toEqual([]);
  });
  it("excludes historical imports, manual records, own transfers and skipped alerts",async()=>{
    await store().update(a,{paymentPush:true});await store().subscribe(a,subscription);
    for(const [i,overrides]of [{old:true},{channel:"manual"},{kind:"transfer_own"},{status:"skipped"}].entries()){
      const id=`00000000-0000-4000-8000-${String(20+i).padStart(12,"0")}`;await insertMessage(a,id,overrides);expect(await store().enqueuePayment(a,id)).toBe(0);
    }
  });
  it("claims atomically and does not retry accepted, attempted, or ambiguous requests",async()=>{
    await prepare();const now=new Date(Date.now()+2000),pending=await store().pending(a,now),id=pending[0].id;
    expect(await store().claim(b,id,now)).toBeNull();const claimed=await store().claim(a,id,now);expect(claimed?.attempts).toBe(1);
    expect(await store().claim(a,id,now)).toBeNull();await store().finish(a,id,{status:"unconfirmed",reason:"connection-unconfirmed"});
    expect(await store().pending(a,new Date(Date.now()+60_000))).toEqual([]);
  });
  it("disabling/re-enabling cancels old epoch instead of sending queued history",async()=>{
    await prepare();const now=new Date(Date.now()+2000),id=(await store().pending(a,now))[0].id;
    await store().update(a,{paymentPush:false});await store().update(a,{paymentPush:true});
    expect(await store().claim(a,id,now)).toBeNull();
  });
  it("rechecks classification and device expiry before claiming",async()=>{
    await prepare();const now=new Date(Date.now()+2000),id=(await store().pending(a,now))[0].id;
    await db.query("update bank_messages set kind='transfer_own' where id=$1::uuid",[message]);expect(await store().claim(a,id,now)).toBeNull();
    await db.query("update bank_messages set kind='payment' where id=$1::uuid",[message]);await db.exec("update push_subscriptions set expires_at=now()-interval '1 second'");
    expect(await store().claim(a,id,now)).toBeNull();
  });
  it("retains definite retries with bound attempts and deferral, owner bound finish",async()=>{
    await prepare();const now=new Date(Date.now()+2000),id=(await store().pending(a,now))[0].id;
    await store().claim(a,id,now);await store().finish(b,id,{status:"accepted",reason:"provider-accepted"});
    expect((await db.query<{status:string}>("select status from notification_deliveries where id=$1",[id])).rows[0].status).toBe("attempted");
    await store().finish(a,id,{status:"queued",reason:"HTTP-503",nextAttempt:new Date(now.getTime()+60_000)});
    expect(await store().pending(a,now)).toEqual([]);expect((await store().pending(a,new Date(now.getTime()+60_001)))[0].attempts).toBe(1);
  });
  it("client roles cannot read endpoint keys or delivery internals",async()=>{
    const grants=(await db.query<{sub:boolean;delivery:boolean;marker:boolean}>(`select has_table_privilege('authenticated','public.push_subscriptions','select') sub,has_table_privilege('anon','public.notification_deliveries','select') delivery,has_function_privilege('authenticated','public.alfred_notifications_schema_20261103_v1()','execute') marker`)).rows[0];
    expect(grants).toEqual({sub:false,delivery:false,marker:false});
  });
  it("bounds devices atomically while allowing an existing browser to refresh",async()=>{
    for(let i=0;i<5;i++)await store().subscribe(a,{...subscription,endpoint:subscription.endpoint+String(i)});
    await expect(store().subscribe(a,{...subscription,endpoint:subscription.endpoint+"sixth"})).rejects.toThrow("Remove a notification device");
    await expect(store().subscribe(a,{...subscription,endpoint:subscription.endpoint+"0"})).resolves.toEqual(expect.any(String));
    expect((await store().devices(a)).length).toBe(5);
  });
  it("never repeats an accepted scheduled event after preference toggles",async()=>{
    await store().update(a,{billReminders:true});await store().subscribe(a,subscription);
    const bill="00000000-0000-4000-8000-000000000030";
    await db.query("insert into bills values($1::uuid,$2::uuid,true)",[bill,a]);
    const key=`bill:${bill}:2026-11-04`;expect(await store().enqueueScheduled(a,"bill",key,bill,"2026-11-04")).toBe(1);
    const now=new Date(Date.now()+2000),id=(await store().pending(a,now))[0].id;await store().claim(a,id,now);await store().finish(a,id,{status:"accepted",reason:"provider-accepted"});
    await store().update(a,{billReminders:false});await store().update(a,{billReminders:true});
    expect(await store().enqueueScheduled(a,"bill",key,bill,"2026-11-04")).toBe(0);
  });
  it("expired hidden devices do not consume the active device allowance",async()=>{
    for(let i=0;i<5;i++)await store().subscribe(a,{...subscription,endpoint:subscription.endpoint+String(i)});
    await db.exec("update push_subscriptions set expires_at=now()-interval '1 second'");
    expect(await store().devices(a)).toEqual([]);
    await expect(store().subscribe(a,{...subscription,endpoint:subscription.endpoint+"fresh"})).resolves.toEqual(expect.any(String));
    expect((await store().devices(a)).length).toBe(1);
  });
  it("keeps an opted-in queued payment eligible after a recovery delay over24h",async()=>{
    await prepare();const later=new Date(Date.now()+25*60*60*1000),id=(await store().pending(a,later))[0].id;
    expect(await store().claim(a,id,later)).not.toBeNull();
  });
  it("cancels a legacy held job immediately when muted",async()=>{
    await prepare();const until=new Date(Date.now()+10*60*60*1000);
    await db.query("update notification_deliveries set next_attempt_at=$1::timestamptz",[until.toISOString()]);expect(await store().pending(a,new Date(Date.now()+2000))).toEqual([]);
    await store().update(a,{paymentPush:false});
    expect((await db.query<{status:string}>("select status from notification_deliveries")).rows[0].status).toBe("canceled");
    expect(await store().pending(a,new Date(until.getTime()+1))).toEqual([]);
  });
});
