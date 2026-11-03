import { createHash } from "node:crypto";
import type { SupabaseSettings } from "@/lib/config";
import { query } from "@/lib/supabase/connection";
import type { Execute } from "./store";

export type RecoveryStatus = {
  configured: boolean;
  ready: boolean;
  lastCompletedAt: string | null;
  expectedIntervalSeconds: number | null;
  reason: "not-configured" | "schema-unavailable" | "never-completed" | "configuration-changed" | "failed" | "stale" | "ready";
};
type RecoveryEnvironment = Record<string,string|undefined>;
type RecoveryConfiguration = {configured:boolean;fingerprint:string|null;interval:number|null};
/** Registration metadata is an operator assertion, not proof that a scheduler
 * exists. A recent completed authenticated call is additionally required. */
export function recoveryConfiguration(env:RecoveryEnvironment=process.env):RecoveryConfiguration {
  const id=env.ALFRED_NOTIFICATION_RECOVERY_SCHEDULE_ID?.trim()??"";
  const secret=env.ALFRED_NOTIFICATION_CRON_SECRET?.trim()??"";
  const interval=env.ALFRED_NOTIFICATION_RECOVERY_INTERVAL_SECONDS??"";
  const seconds=/^\d+$/.test(interval)?Number(interval):0;
  if(env.ALFRED_NOTIFICATION_SCHEDULES_ENABLED!=="true"||!secret||!/^[A-Za-z0-9_.:/-]{1,160}$/.test(id)||seconds<60||seconds>300)
    return {configured:false,fingerprint:null,interval:null};
  return {configured:true,interval:seconds,fingerprint:createHash("sha256").update(`${id}\0${seconds}\0${secret}`).digest("hex")};
}
type HealthRow={configuration_fingerprint:string;last_completed_at:Date|string|null;last_failed_at:Date|string|null};
export async function loadRecoveryStatus(settings:SupabaseSettings,options:{now?:Date;env?:RecoveryEnvironment;execute?:Execute}={}):Promise<RecoveryStatus> {
  const configuration=recoveryConfiguration(options.env),now=options.now??new Date();
  const base:RecoveryStatus={configured:configuration.configured,ready:false,lastCompletedAt:null,expectedIntervalSeconds:configuration.interval,reason:"not-configured"};
  if(!configuration.configured)return base;
  try {
    const rows=await (options.execute??query)<HealthRow>(settings,"select configuration_fingerprint,last_completed_at,last_failed_at from public.notification_recovery_health where id='dispatcher'",[]);
    const row=rows[0];if(!row?.last_completed_at)return {...base,reason:"never-completed"};
    const completed=new Date(row.last_completed_at),failed=row.last_failed_at?new Date(row.last_failed_at):null;
    const lastCompletedAt=Number.isFinite(completed.getTime())?completed.toISOString():null;
    if(row.configuration_fingerprint!==configuration.fingerprint)return {...base,lastCompletedAt,reason:"configuration-changed"};
    if(failed&&failed.getTime()>=completed.getTime())return {...base,lastCompletedAt,reason:"failed"};
    const age=now.getTime()-completed.getTime(),maximumAge=Math.max(300_000,configuration.interval!*2000);
    if(!lastCompletedAt||age<0||age>maximumAge)return {...base,lastCompletedAt,reason:"stale"};
    return {...base,lastCompletedAt,ready:true,reason:"ready"};
  }catch{return {...base,reason:"schema-unavailable"};}
}
/** Only the authenticated dispatcher route calls these; neither a settings read
 * nor an ingestion request can manufacture a successful recovery heartbeat. */
export async function recordRecoveryCompletion(settings:SupabaseSettings,now=new Date(),execute:Execute=query):Promise<void> {
  const configuration=recoveryConfiguration();if(!configuration.configured)throw new Error("Scheduled recovery is not configured.");
  await execute(settings,`insert into public.notification_recovery_health(id,configuration_fingerprint,last_completed_at,last_failed_at)
    values('dispatcher',$1,$2::timestamptz,null) on conflict(id) do update set configuration_fingerprint=excluded.configuration_fingerprint,last_completed_at=excluded.last_completed_at,last_failed_at=null`,[configuration.fingerprint,now.toISOString()]);
}
export async function recordRecoveryFailure(settings:SupabaseSettings,now=new Date(),execute:Execute=query):Promise<void> {
  const configuration=recoveryConfiguration();if(!configuration.configured)return;
  await execute(settings,`insert into public.notification_recovery_health(id,configuration_fingerprint,last_failed_at)
    values('dispatcher',$1,$2::timestamptz) on conflict(id) do update set configuration_fingerprint=excluded.configuration_fingerprint,last_failed_at=excluded.last_failed_at`,[configuration.fingerprint,now.toISOString()]);
}
