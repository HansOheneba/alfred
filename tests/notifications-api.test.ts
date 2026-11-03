import { beforeEach,describe,expect,it,vi } from "vitest";
const mocks=vi.hoisted(()=>({owner:vi.fn(),preferences:vi.fn(),devices:vi.fn(),update:vi.fn(),subscribe:vi.fn(),unsubscribe:vi.fn(),deviceForEndpoint:vi.fn(),configuration:vi.fn(),dispatch:vi.fn(),mentions:vi.fn(),recovery:vi.fn(),recoveryConfiguration:vi.fn(),completed:vi.fn(),failed:vi.fn(),policy:vi.fn()}));
vi.mock("@/lib/web/api",()=>({requireOwner:mocks.owner}));
vi.mock("@/lib/notifications/store",()=>({createNotificationStore:()=>({preferences:mocks.preferences,devices:mocks.devices,update:mocks.update,subscribe:mocks.subscribe,unsubscribe:mocks.unsubscribe,deviceForEndpoint:mocks.deviceForEndpoint})}));
vi.mock("@/lib/notifications/push",()=>({pushConfiguration:mocks.configuration}));
vi.mock("@/lib/notifications/service",()=>({dispatchScheduledNotifications:mocks.dispatch}));
vi.mock("@/lib/bank/notices",()=>({recoverAllIncomingPaymentMentions:mocks.mentions}));
vi.mock("@/lib/notifications/recovery",()=>({loadRecoveryStatus:mocks.recovery,recoveryConfiguration:mocks.recoveryConfiguration,recordRecoveryCompletion:mocks.completed,recordRecoveryFailure:mocks.failed}));
vi.mock("@/lib/env",()=>({getDatabaseSettings:()=>({fixture:true})}));
vi.mock("@/lib/notifications/schema-ready",()=>({notificationPolicyAvailable:mocks.policy}));
import { GET,PATCH } from "@/app/api/notifications/route";
import { POST,DELETE } from "@/app/api/notifications/subscriptions/route";
import { POST as status } from "@/app/api/notifications/subscriptions/status/route";
import { POST as dispatch } from "@/app/api/notifications/dispatch/route";
const origin="https://alfred.example",ownerId="00000000-0000-4000-8000-000000000001";
const request=(path:string,method:string,body:unknown,source=origin)=>new Request(origin+path,{method,headers:{origin:source,"content-type":"application/json","x-alfred-owner":ownerId},body:JSON.stringify(body)});
beforeEach(()=>{
 vi.clearAllMocks();vi.unstubAllEnvs();mocks.policy.mockResolvedValue(true);vi.stubEnv("ALFRED_PUSH_DELIVERY_ENABLED","true");mocks.recovery.mockResolvedValue({configured:true,ready:true,lastCompletedAt:"2026-11-03T12:00:00Z",expectedIntervalSeconds:300,reason:"ready"});mocks.recoveryConfiguration.mockReturnValue({configured:true});mocks.completed.mockResolvedValue(undefined);mocks.failed.mockResolvedValue(undefined);mocks.owner.mockResolvedValue({profile:{profileId:ownerId},settings:{supabase:{fixture:true}}});
 mocks.preferences.mockResolvedValue({paymentPush:false});mocks.devices.mockResolvedValue([{id:"device",createdAt:"2026-11-03T12:00:00Z"}]);mocks.update.mockResolvedValue({paymentPush:true});
 mocks.configuration.mockReturnValue({ready:true,publicKey:"public-fixture",config:{publicKey:"public-fixture",privateKey:"must-never-be-serialized",subject:"mailto:fixture@example.invalid"}});
 mocks.subscribe.mockResolvedValue("device");mocks.unsubscribe.mockResolvedValue(undefined);mocks.deviceForEndpoint.mockResolvedValue(null);
});
describe("notification API authorization and private responses",()=>{
 it("keeps device opt-in unavailable when the new policy migration is missing despite an old healthy heartbeat",async()=>{
  mocks.policy.mockResolvedValue(false);
  const payload=await (await GET()).json();
  expect(payload.push).toMatchObject({recoveryReady:false,recovery:{ready:false,reason:"schema-unavailable"}});
  expect((await PATCH(request("/api/notifications","PATCH",{paymentPush:true}))).status).toBe(503);
  expect(mocks.update).not.toHaveBeenCalled();
  expect((await PATCH(request("/api/notifications","PATCH",{paymentPush:false}))).status).toBe(200);
 });

 it("requires an authenticated owner for configuration",async()=>{
  mocks.owner.mockResolvedValue(Response.json({ok:false},{status:401}));expect((await GET()).status).toBe(401);expect(mocks.preferences).not.toHaveBeenCalled();
 });
 it("returns public readiness and safe device metadata, never the private key",async()=>{
  const response=await GET(),body=await response.text();expect(body).not.toContain("must-never-be-serialized");expect(JSON.parse(body)).toMatchObject({ownerId,push:{publicKey:"public-fixture",configured:true}});expect(response.headers.get("cache-control")).toContain("no-store");
 });
 it("rejects cross-origin updates before touching account state",async()=>{
  expect((await PATCH(request("/api/notifications","PATCH",{paymentPush:true},"https://evil.example"))).status).toBe(403);expect(mocks.update).not.toHaveBeenCalled();
 });
 it("does not accept caller-chosen owner or unknown preferences",async()=>{
  expect((await PATCH(request("/api/notifications","PATCH",{paymentPush:true,ownerId:"other"}))).status).toBe(400);expect(mocks.update).not.toHaveBeenCalled();
  expect((await PATCH(request("/api/notifications","PATCH",{paymentPush:true}))).status).toBe(200);expect(mocks.update).toHaveBeenCalledWith(ownerId,{paymentPush:true});
 });
 it("rejects stale displayed-account consent after a session switch",async()=>{
  const stale=request("/api/notifications","PATCH",{paymentPush:true});stale.headers.set("x-alfred-owner","00000000-0000-4000-8000-000000000002");
  expect((await PATCH(stale)).status).toBe(409);expect(mocks.update).not.toHaveBeenCalled();
 });
 it("fails closed on payment push opt-in when scheduled recovery is unavailable",async()=>{
  mocks.recovery.mockResolvedValue({configured:false,ready:false,lastCompletedAt:null,expectedIntervalSeconds:null,reason:"not-configured"});
  const response=await PATCH(request("/api/notifications","PATCH",{paymentPush:true}));
  expect(response.status).toBe(503);expect(await response.json()).toMatchObject({recoveryReady:false});expect(mocks.update).not.toHaveBeenCalled();
  expect((await PATCH(request("/api/notifications","PATCH",{paymentMentions:true}))).status).toBe(200);
 });
 it("saves outgoing chat consent independently while push infrastructure is unavailable",async()=>{
  mocks.configuration.mockReturnValue({ready:false,publicKey:null,config:null});
  mocks.recovery.mockResolvedValue({configured:false,ready:false,lastCompletedAt:null,expectedIntervalSeconds:null,reason:"not-configured"});
  const response=await PATCH(request("/api/notifications","PATCH",{outgoingMentions:true}));
  expect(response.status).toBe(200);expect(mocks.update).toHaveBeenCalledWith(ownerId,{outgoingMentions:true});
  expect(mocks.subscribe).not.toHaveBeenCalled();expect(mocks.dispatch).not.toHaveBeenCalled();
 });
 it("rejects outgoing consent from a stale displayed account or a caller-supplied history cutoff",async()=>{
  const stale=request("/api/notifications","PATCH",{outgoingMentions:true});stale.headers.set("x-alfred-owner","00000000-0000-4000-8000-000000000002");
  expect((await PATCH(stale)).status).toBe(409);
  expect((await PATCH(request("/api/notifications","PATCH",{outgoingMentions:true,outgoingMentionsSince:"2000-01-01T00:00:00Z"}))).status).toBe(400);
  expect((await PATCH(request("/api/notifications","PATCH",{outgoingMentions:"yes"}))).status).toBe(400);
  expect(mocks.update).not.toHaveBeenCalled();
 });
 it("subscription operations derive ownership and do not send a notification",async()=>{
  const subscription={endpoint:"https://fcm.googleapis.com/fcm/send/fixture",keys:{p256dh:"fixture",auth:"fixture"}};
  expect(await (await POST(request("/api/notifications/subscriptions","POST",subscription))).json()).toEqual({ok:true,deviceId:"device"});
  expect(mocks.subscribe).toHaveBeenCalledWith(ownerId,subscription);expect(mocks.dispatch).not.toHaveBeenCalled();
  const id="00000000-0000-4000-8000-000000000010";
  expect((await DELETE(request("/api/notifications/subscriptions","DELETE",{id}))).status).toBe(200);expect(mocks.unsubscribe).toHaveBeenCalledWith(ownerId,{id});
 });
 it("browser status is an owner-scoped lookup without subscription mutation",async()=>{
  const endpoint="https://fcm.googleapis.com/fcm/send/fixture";
  const response=await status(request("/api/notifications/subscriptions/status","POST",{endpoint}));
  expect(await response.json()).toEqual({ok:true,ownerId,device:null});expect(mocks.deviceForEndpoint).toHaveBeenCalledWith(ownerId,endpoint);expect(mocks.subscribe).not.toHaveBeenCalled();
 });
 it("cannot register before reviewed VAPID configuration exists",async()=>{
  mocks.configuration.mockReturnValue({ready:false,publicKey:null,config:null});expect((await POST(request("/api/notifications/subscriptions","POST",{}))).status).toBe(503);expect(mocks.subscribe).not.toHaveBeenCalled();
 });
 it("cron does nothing without its separate secret and activation gate",async()=>{
  expect((await dispatch(new Request(origin+"/api/notifications/dispatch",{method:"POST"}))).status).toBe(401);
  vi.stubEnv("ALFRED_NOTIFICATION_CRON_SECRET","synthetic-fixture-only");
  const response=await dispatch(new Request(origin+"/api/notifications/dispatch",{method:"POST",headers:{authorization:"Bearer synthetic-fixture-only"}}));
  expect(await response.json()).toMatchObject({enabled:false});expect(mocks.mentions).not.toHaveBeenCalled();expect(mocks.dispatch).not.toHaveBeenCalled();
 });
 it("records health only after a completed authenticated dispatch, and marks failed runs",async()=>{
  vi.stubEnv("ALFRED_NOTIFICATION_CRON_SECRET","synthetic-fixture-only");vi.stubEnv("ALFRED_NOTIFICATION_SCHEDULES_ENABLED","true");
  const call=()=>dispatch(new Request(origin+"/api/notifications/dispatch",{method:"POST",headers:{authorization:"Bearer synthetic-fixture-only"}}));
  mocks.mentions.mockResolvedValue(0);mocks.dispatch.mockResolvedValue({enabled:true,queued:0,owners:0});
  expect((await call()).status).toBe(200);expect(mocks.completed).toHaveBeenCalledOnce();expect(mocks.failed).not.toHaveBeenCalled();
  mocks.completed.mockClear();mocks.dispatch.mockRejectedValue(new Error("fixture failure"));
  expect((await call()).status).toBe(503);expect(mocks.completed).not.toHaveBeenCalled();expect(mocks.failed).toHaveBeenCalledOnce();
 });
 it("marks mention recovery failure unhealthy and retries both tasks on the next successful run",async()=>{
  vi.stubEnv("ALFRED_NOTIFICATION_CRON_SECRET","synthetic-fixture-only");vi.stubEnv("ALFRED_NOTIFICATION_SCHEDULES_ENABLED","true");
  const call=()=>dispatch(new Request(origin+"/api/notifications/dispatch",{method:"POST",headers:{authorization:"Bearer synthetic-fixture-only"}}));
  const logged=vi.spyOn(console,"error").mockImplementation(()=>{});
  try {
   mocks.mentions.mockRejectedValueOnce(new Error("synthetic private receipt failure: must-not-leak"));
   const failed=await call();expect(failed.status).toBe(503);expect(await failed.text()).not.toContain("must-not-leak");
   expect(mocks.failed).toHaveBeenCalledOnce();expect(mocks.completed).not.toHaveBeenCalled();expect(mocks.dispatch).not.toHaveBeenCalled();
   expect(JSON.stringify(logged.mock.calls)).not.toContain("must-not-leak");
   mocks.mentions.mockResolvedValueOnce(2);mocks.dispatch.mockResolvedValueOnce({enabled:true,queued:1,owners:1});
   const recovered=await call();expect(recovered.status).toBe(200);expect(await recovered.json()).toMatchObject({mentionsRecovered:2,recoveryCheckedIn:true});
   expect(mocks.dispatch).toHaveBeenCalledOnce();expect(mocks.completed).toHaveBeenCalledOnce();
  } finally { logged.mockRestore(); }
 });
});
