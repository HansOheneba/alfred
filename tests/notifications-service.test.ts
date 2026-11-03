import { describe,expect,it,vi } from "vitest";
import { drainOwnerNotifications,localClock,pushResult } from "@/lib/notifications/service";
import { PushFailure, type PushConfiguration } from "@/lib/notifications/push";
import type { NotificationStore,QueuedDelivery } from "@/lib/notifications/store";
import type { SupabaseSettings } from "@/lib/config";
const now=new Date("2026-11-03T12:00:00Z"),configuration={} as PushConfiguration;
const delivery:QueuedDelivery={id:"1",ownerId:"owner",subscriptionId:"device",kind:"payment",eventKey:"payment:fixture",resourceId:"fixture",targetDate:null,attempts:1,subscription:{endpoint:"https://fcm.googleapis.com/fcm/send/fixture",keys:{p256dh:"synthetic",auth:"synthetic"},expirationTime:null}};
function fakeStore(){return {pending:vi.fn(async()=>[delivery]),claim:vi.fn(async()=>delivery),finish:vi.fn(async()=>{}),cancel:vi.fn(async()=>{}),unsubscribe:vi.fn(async()=>{})} as unknown as NotificationStore;}
describe("privacy-safe notification delivery state machine",()=>{
 it("separates accepted, definite rejection, bounded retry and ambiguous sends",()=>{
  expect(pushResult(201,1,now).status).toBe("accepted");expect(pushResult(403,1,now).status).toBe("rejected");
  expect(pushResult(503,1,now)).toMatchObject({status:"queued",nextAttempt:new Date(now.getTime()+60_000)});
  expect(pushResult(503,3,now).status).toBe("rejected");expect(pushResult("encryption",1,now).status).toBe("queued");expect(pushResult("connection",1,now).status).toBe("unconfirmed");
 });
 it("is off without explicit server activation even with preferences ready",async()=>{
  const store=fakeStore(),send=vi.fn();expect((await drainOwnerNotifications({} as SupabaseSettings,"owner",{now,store,send,configuration,deliveryEnabled:false,timeZone:"Africa/Accra"})).attempted).toBe(0);expect(store.pending).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();
 });
 it("sends an eligible opted-in payment overnight without an intentional hold",async()=>{
  expect(localClock(now,"Africa/Accra").hour).toBe(12);
  const store=fakeStore(),send=vi.fn(async()=>new Response(null,{status:201}));
  await drainOwnerNotifications({} as SupabaseSettings,"owner",{now:new Date("2026-11-03T23:00:00Z"),store,configuration,deliveryEnabled:true,recoveryReady:true,timeZone:"Africa/Accra",send});
  expect(store.claim).toHaveBeenCalledOnce();expect(send).toHaveBeenCalledOnce();
 });
 it("claims before transport and records acceptance without exposing payload details",async()=>{
  const store=fakeStore(),send=vi.fn(async()=>new Response(null,{status:201}));
  const result=await drainOwnerNotifications({} as SupabaseSettings,"owner",{now,store,send,configuration,deliveryEnabled:true,recoveryReady:true,timeZone:"Africa/Accra"});
  expect(result.accepted).toBe(1);expect(store.claim).toHaveBeenCalledBefore(send);expect(send).toHaveBeenCalledWith(delivery.subscription,configuration,"payment");expect(store.finish).toHaveBeenCalledWith("owner","1",{status:"accepted",reason:"provider-accepted"});
 });
 it("never blindly retries connection uncertainty and deletes gone devices",async()=>{
  const store=fakeStore();await drainOwnerNotifications({} as SupabaseSettings,"owner",{now,store,configuration,deliveryEnabled:true,recoveryReady:true,timeZone:"Africa/Accra",send:async()=>{throw new PushFailure("connection");}});expect(store.finish).toHaveBeenCalledWith("owner","1",{status:"unconfirmed",reason:"connection-unconfirmed"});
  const gone=fakeStore();await drainOwnerNotifications({} as SupabaseSettings,"owner",{now,store:gone,configuration,deliveryEnabled:true,recoveryReady:true,timeZone:"Africa/Accra",send:async()=>new Response(null,{status:410})});expect(gone.unsubscribe).toHaveBeenCalledWith("owner",{id:"device"});
 });
 it("leaves excess device work queued and never claims without completion budget",async()=>{
  const store=fakeStore(),rows=Array.from({length:5},(_,i)=>({...delivery,id:String(i)}));
  vi.mocked(store.pending).mockResolvedValue(rows);vi.mocked(store.claim).mockImplementation(async(_owner,id)=>rows.find(r=>r.id===id)??null);
  const send=vi.fn(async()=>new Response(null,{status:201}));
  const result=await drainOwnerNotifications({} as SupabaseSettings,"owner",{now,store,configuration,deliveryEnabled:true,recoveryReady:true,timeZone:"Africa/Accra",send});
  expect(send).toHaveBeenCalledTimes(3);expect(result.deferred).toBe(2);
  const short=fakeStore();const deferred=await drainOwnerNotifications({} as SupabaseSettings,"owner",{now,store:short,configuration,deliveryEnabled:true,recoveryReady:true,timeZone:"Africa/Accra",send,timeBudgetMs:1000});
  expect(short.claim).not.toHaveBeenCalled();expect(deferred.deferred).toBe(1);
 });
});
