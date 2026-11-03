import { beforeEach,describe,expect,it,vi } from "vitest";
const execute=vi.hoisted(()=>vi.fn());
vi.mock("@/lib/supabase/connection",()=>({query:execute}));
import { dispatchScheduledNotifications } from "@/lib/notifications/service";
import type { SupabaseSettings } from "@/lib/config";
const owner="00000000-0000-4000-8000-000000000001",bill="00000000-0000-4000-8000-000000000002";
let config:{timezone:string;bill_reminders:boolean;weekly_overview:boolean},fresh:boolean;
beforeEach(()=>{
 vi.clearAllMocks();vi.stubEnv("ALFRED_NOTIFICATION_SCHEDULES_ENABLED","true");vi.stubEnv("ALFRED_PUSH_DELIVERY_ENABLED","false");vi.stubEnv("ALFRED_NOTIFICATION_CRON_SECRET","fixture-only");vi.stubEnv("ALFRED_NOTIFICATION_RECOVERY_SCHEDULE_ID","fixture/scheduler");vi.stubEnv("ALFRED_NOTIFICATION_RECOVERY_INTERVAL_SECONDS","300");
 config={timezone:"Africa/Accra",bill_reminders:false,weekly_overview:false};fresh=true;
 execute.mockImplementation(async(_settings:unknown,sql:string)=>{
  if(sql.includes("select p.owner_id::text,r.timezone"))return [{owner_id:owner,...config}];
  if(sql.includes("select id::text,next_date::text,cadence,active from public.bills"))return [{id:bill,next_date:"2026-11-04",cadence:"once",active:true}];
  if(sql.includes("as fresh"))return [{fresh}];
  if(sql.includes("insert into public.notification_deliveries"))return [{id:"queued"}];
  return [];
 });
});
const queued=()=>execute.mock.calls.filter(call=>String(call[1]).includes("insert into public.notification_deliveries"));
describe("explicit, owner-local notification schedules",()=>{
 it("does not query or deliver without separate schedule activation",async()=>{
  vi.stubEnv("ALFRED_NOTIFICATION_SCHEDULES_ENABLED","false");expect(await dispatchScheduledNotifications({} as SupabaseSettings)).toEqual({enabled:false,queued:0,owners:0});expect(execute).not.toHaveBeenCalled();
 });
 it("queues only a confirmed next-day bill at9 in the owner's timezone",async()=>{
  config.bill_reminders=true;config.timezone="America/New_York";
  expect((await dispatchScheduledNotifications({} as SupabaseSettings,new Date("2026-11-03T14:00:00Z"))).queued).toBe(1);
  expect(queued()[0][2]).toEqual([owner,"bill",`bill:${bill}:2026-11-04`,bill,"2026-11-04"]);
  expect(String(queued()[0][1])).not.toContain("name");
 });
 it("leaves unrelated hours and disabled bill preferences quiet",async()=>{
  config.bill_reminders=true;await dispatchScheduledNotifications({} as SupabaseSettings,new Date("2026-11-03T08:00:00Z"));expect(queued()).toEqual([]);
  config.bill_reminders=false;await dispatchScheduledNotifications({} as SupabaseSettings,new Date("2026-11-03T09:00:00Z"));expect(queued()).toEqual([]);
 });
 it("queues one stable Sunday18 weekly event only with recent accepted alert evidence",async()=>{
  config.weekly_overview=true;const at=new Date("2026-11-08T18:00:00Z");
  await dispatchScheduledNotifications({} as SupabaseSettings,at);expect(queued()[0][2]).toEqual([owner,"weekly","weekly:2026-11-08",null,"2026-11-08"]);
  execute.mockClear();fresh=false;await dispatchScheduledNotifications({} as SupabaseSettings,at);expect(queued()).toEqual([]);
 });
 it("bounds owner discovery fairly and never invokes push while delivery is disabled",async()=>{
  await dispatchScheduledNotifications({} as SupabaseSettings,new Date("2026-11-03T12:00:00Z"));
  const sql=execute.mock.calls.map(call=>String(call[1]));expect(sql[0]).toContain("last_dispatch_at nulls first");expect(sql[0]).toContain("limit 10");expect(sql.some(text=>text.includes("status='attempted'"))).toBe(false);
 });
});
