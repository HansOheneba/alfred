import { afterAll,beforeAll,beforeEach,describe,expect,it,vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
const execute=vi.hoisted(()=>vi.fn());
vi.mock("@/lib/supabase/connection",()=>({query:execute}));
import type { SupabaseSettings } from "@/lib/config";
import { createNotificationStore,type Execute } from "@/lib/notifications/store";
import { drainOwnerNotifications,dispatchScheduledNotifications,localClock,recoverPaymentNotifications } from "@/lib/notifications/service";
import { loadRecoveryStatus,recordRecoveryCompletion,recordRecoveryFailure,recoveryConfiguration } from "@/lib/notifications/recovery";
import type { PushConfiguration,PushSubscriptionRecord } from "@/lib/notifications/push";
const owner="00000000-0000-4000-8000-000000000001",message="00000000-0000-4000-8000-000000000010",settings={} as SupabaseSettings;
const configuration={} as PushConfiguration;
let db:PGlite,subscription:PushSubscriptionRecord;
const sql:Execute=async<T extends Record<string,unknown>>(_settings:SupabaseSettings,text:string,values:unknown[]=[]) => (await db.query<T>(text,values)).rows;
const store=()=>createNotificationStore(settings,sql);
function configured(){
 vi.stubEnv("ALFRED_NOTIFICATION_SCHEDULES_ENABLED","true");vi.stubEnv("ALFRED_NOTIFICATION_CRON_SECRET","fixture-only");
 vi.stubEnv("ALFRED_NOTIFICATION_RECOVERY_SCHEDULE_ID","synthetic/schedule");vi.stubEnv("ALFRED_NOTIFICATION_RECOVERY_INTERVAL_SECONDS","300");
}
async function seed(at:Date,queue=true){
 const since=new Date(at.getTime()-60*60*1000).toISOString();
 await store().update(owner,{paymentPush:true});const device=await store().subscribe(owner,subscription);
 await db.query("update notification_preferences set payment_push_since=$1::timestamptz",[since]);
 await db.query("update push_subscriptions set created_at=$1::timestamptz",[since]);
 await db.query("insert into bank_messages(id,owner_id,channel,kind,status,amount,created_at,occurred_at) values($1::uuid,$2::uuid,'mac','payment','needs_label',10,$3::timestamptz,$3::timestamptz)",[message,owner,at.toISOString()]);
 if(queue){expect(await store().enqueuePayment(owner,message)).toBe(1);await db.query("update notification_deliveries set next_attempt_at=$1::timestamptz",[at.toISOString()]);}
 return device;
}
beforeAll(async()=>{
 db=new PGlite();await db.exec(`create role anon;create role authenticated;create schema auth;create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;
 create table profiles(id uuid primary key,timezone text);create table bank_messages(id uuid primary key,owner_id uuid,channel text,kind text,status text,amount numeric,created_at timestamptz,occurred_at timestamptz);
 create table bills(id uuid primary key,owner_id uuid,active boolean,next_date date,cadence text);`);
 for(const file of ["20261103110000_notifications.sql","20261103200000_notification_recovery.sql","20261103233000_payment_activity_notices.sql"])await db.exec(await readFile(new URL("../supabase/migrations/"+file,import.meta.url),"utf8"));
 const pair=await webcrypto.subtle.generateKey({name:"ECDH",namedCurve:"P-256"},true,["deriveBits"]);
 subscription={endpoint:"https://fcm.googleapis.com/fcm/send/synthetic-recovery",keys:{p256dh:Buffer.from(await webcrypto.subtle.exportKey("raw",pair.publicKey)).toString("base64url"),auth:Buffer.alloc(16,9).toString("base64url")}};
});
beforeEach(async()=>{
 vi.clearAllMocks();vi.unstubAllEnvs();configured();
 await db.exec("truncate notification_recovery_health,notification_deliveries,push_subscriptions,notification_preferences,bank_messages,bills,profiles cascade");
 await db.query("insert into profiles values($1::uuid,'Africa/Accra')",[owner]);execute.mockImplementation(sql);
});
afterAll(async()=>{await db.close();vi.unstubAllEnvs();});
describe("immediate payment delivery and durable recovery",()=>{
 it.each([
  ["2026-11-03T22:30:00Z","Africa/Accra",22],
  ["2026-03-08T06:30:00Z","America/New_York",1],
  ["2026-03-08T07:30:00Z","America/New_York",3],
  ["2026-11-01T05:30:00Z","America/New_York",1],
  ["2026-11-01T06:30:00Z","America/New_York",1],
 ])("sends immediately overnight across timezone/DST at %s",async(instant,zone,hour)=>{
  const at=new Date(instant);await seed(at);await recordRecoveryCompletion(settings,new Date(at.getTime()-60_000),sql);
  const send=vi.fn(async()=>new Response(null,{status:201}));
  expect(localClock(at,zone).hour).toBe(hour);
  const result=await drainOwnerNotifications(settings,owner,{now:at,store:store(),configuration,deliveryEnabled:true,timeZone:zone,send});
  expect(result.accepted).toBe(1);expect(send).toHaveBeenCalledOnce();
  await drainOwnerNotifications(settings,owner,{now:at,store:store(),configuration,deliveryEnabled:true,timeZone:zone,send});
  expect(send).toHaveBeenCalledOnce();
 });
 it("requires explicit registration metadata and a recent completed authenticated heartbeat",async()=>{
  const at=new Date("2026-11-04T07:00:00Z");
  expect((await loadRecoveryStatus(settings,{now:at,execute:sql})).reason).toBe("never-completed");
  await recordRecoveryCompletion(settings,at,sql);expect((await loadRecoveryStatus(settings,{now:new Date(at.getTime()+4*60_000),execute:sql})).ready).toBe(true);
  expect((await loadRecoveryStatus(settings,{now:new Date(at.getTime()+11*60_000),execute:sql})).reason).toBe("stale");
  await recordRecoveryFailure(settings,new Date(at.getTime()+60_000),sql);expect((await loadRecoveryStatus(settings,{now:new Date(at.getTime()+2*60_000),execute:sql})).reason).toBe("failed");
  vi.stubEnv("ALFRED_NOTIFICATION_RECOVERY_SCHEDULE_ID","different/schedule");expect((await loadRecoveryStatus(settings,{now:at,execute:sql})).reason).toBe("configuration-changed");
 });
 it("does not equate flags or a secret alone with an available scheduler",()=>{
  vi.stubEnv("ALFRED_NOTIFICATION_RECOVERY_SCHEDULE_ID","");expect(recoveryConfiguration().configured).toBe(false);
  vi.stubEnv("ALFRED_NOTIFICATION_RECOVERY_SCHEDULE_ID","synthetic/schedule");vi.stubEnv("ALFRED_NOTIFICATION_RECOVERY_INTERVAL_SECONDS","3600");expect(recoveryConfiguration().configured).toBe(false);
 });
 it("retains queued work without a scheduler instead of sending or silently canceling it",async()=>{
  const at=new Date("2026-11-04T12:00:00Z");await seed(at);vi.stubEnv("ALFRED_NOTIFICATION_RECOVERY_SCHEDULE_ID","");
  const send=vi.fn(async()=>new Response(null,{status:201}));
  const result=await drainOwnerNotifications(settings,owner,{now:at,store:store(),configuration,deliveryEnabled:true,timeZone:"Africa/Accra",send});
  expect(result.recoveryReady).toBe(false);expect(send).not.toHaveBeenCalled();expect((await store().pending(owner,at)).length).toBe(1);
 });
 it("scheduled recovery drains an eligible payment overnight without another SMS",async()=>{
  const at=new Date("2026-11-03T22:30:00Z");await seed(at);
  const send=vi.fn(async()=>new Response(null,{status:201}));
  await recordRecoveryCompletion(settings,new Date(at.getTime()-60_000),sql);
  expect((await dispatchScheduledNotifications(settings,at,{delivery:{configuration,deliveryEnabled:true,send}})).owners).toBe(1);
  expect(send).toHaveBeenCalledOnce();expect((await db.query<{status:string}>("select status from notification_deliveries")).rows[0].status).toBe("accepted");
  expect((await db.query<{n:number}>("select count(*)::int n from bank_messages")).rows[0].n).toBe(1);
 });
 it("recovers a committed opted-in alert even when enqueue was delayed more than24h",async()=>{
  const old=new Date(Date.now()-25*60*60*1000);await seed(old,false);
  expect(await recoverPaymentNotifications(settings,owner)).toBe(1);
  const now=new Date(Date.now()+2000),id=(await store().pending(owner,now))[0].id;expect(await store().claim(owner,id,now)).not.toBeNull();
 });
 it("muting a queued payment cancels it before overnight recovery",async()=>{
  const at=new Date("2026-11-03T22:30:00Z");await seed(at);
  const send=vi.fn(async()=>new Response(null,{status:201}));
  await store().update(owner,{paymentPush:false});await recordRecoveryCompletion(settings,new Date(at.getTime()-60_000),sql);
  await dispatchScheduledNotifications(settings,at,{delivery:{configuration,deliveryEnabled:true,send}});
  expect(send).not.toHaveBeenCalled();expect((await db.query<{status:string}>("select status from notification_deliveries")).rows[0].status).toBe("canceled");
 });
 it("draft policy migration releases only never-attempted payment holds",async()=>{
  const at=new Date(Date.now()-60_000);await seed(at);
  const future=new Date(Date.now()+8*60*60*1000).toISOString();
  await db.query("update notification_deliveries set next_attempt_at=$1::timestamptz",[future]);
  for(const [suffix,kind,status,attempts,result]of [
   ["retry","payment","queued",1,"HTTP-503"],
   ["bill","bill","queued",0,null],
   ["weekly","weekly","queued",0,null],
   ["accepted","payment","accepted",1,"provider-accepted"],
   ["unconfirmed","payment","unconfirmed",1,"connection-unconfirmed"],
  ]as const)await db.query(`insert into notification_deliveries(owner_id,subscription_id,kind,event_key,resource_id,preference_epoch,status,attempts,attempted_at,last_result,next_attempt_at)
   select owner_id,subscription_id,$1,event_key||':'||$2,resource_id,preference_epoch,$3,$4::smallint,case when $4::smallint>0 then now() end,$5,$6::timestamptz from notification_deliveries where event_key=$7`,[kind,suffix,status,attempts,result,future,`payment:${message}`]);
  const before=(await db.query<{event_key:string;next_attempt_at:Date;status:string;last_result:string|null}>("select event_key,next_attempt_at,status,last_result from notification_deliveries order by event_key")).rows;
  const migration=await readFile(new URL("../supabase/migrations/20261103220000_immediate_payment_nudges.sql",import.meta.url),"utf8");await db.exec(migration);
  const after=(await db.query<{event_key:string;next_attempt_at:Date;status:string;last_result:string|null}>("select event_key,next_attempt_at,status,last_result from notification_deliveries order by event_key")).rows;
  const released=after.find(row=>row.event_key===`payment:${message}`)!;
  expect(released.next_attempt_at.getTime()).toBeLessThanOrEqual(Date.now()+1000);expect(released.last_result).toBe("immediate-payment-policy");
  expect(after.filter(row=>row.event_key!==`payment:${message}`)).toEqual(before.filter(row=>row.event_key!==`payment:${message}`));
  await db.exec(migration);expect((await db.query("select event_key,next_attempt_at,status,last_result from notification_deliveries order by event_key")).rows).toEqual(after);
 });
 it("keeps recovery health and its configuration fingerprint server-only",async()=>{
  expect((await db.query<{allowed:boolean}>("select has_table_privilege('authenticated','public.notification_recovery_health','select') allowed")).rows[0].allowed).toBe(false);
 });
});
