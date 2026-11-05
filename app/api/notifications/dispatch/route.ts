import { timingSafeEqual } from "node:crypto";
import { getDatabaseSettings } from "@/lib/env";
import { dispatchScheduledNotifications } from "@/lib/notifications/service";
import { privateJSON } from "@/lib/notifications/http";
import { recoverAllIncomingPaymentMentions } from "@/lib/bank/notices";
import { logError } from "@/lib/log";
import { recoveryConfiguration,recordRecoveryCompletion,recordRecoveryFailure } from "@/lib/notifications/recovery";
import type { SupabaseSettings } from "@/lib/config";
import { dispatchMessageNotifications } from "@/lib/notifications/messages";
export const maxDuration=60;
export async function POST(request:Request):Promise<Response> {
  const expected=process.env.ALFRED_NOTIFICATION_CRON_SECRET?.trim();
  const supplied=request.headers.get("authorization")?.replace(/^Bearer\s+/i,"")??"";
  const actualBytes=Buffer.from(supplied),expectedBytes=Buffer.from(expected??"");
  if(!expected||actualBytes.length!==expectedBytes.length||!timingSafeEqual(actualBytes,expectedBytes))return privateJSON({ok:false},401);
  if(process.env.ALFRED_NOTIFICATION_SCHEDULES_ENABLED!=="true")return privateJSON({ok:true,enabled:false,queued:0,owners:0});
  if(!recoveryConfiguration().configured)return privateJSON({ok:false,text:"Scheduled recovery registration metadata and interval are not configured."},503);
  let settings:SupabaseSettings|undefined;
  try{
    const deadlineAt=Date.now()+55_000;
    settings=getDatabaseSettings();
    const mentionsRecovered=await recoverAllIncomingPaymentMentions(settings).catch(()=>{
      logError("notification_mentions_recovery",new Error("Private payment mention recovery could not complete."));
      // One heartbeat covers both recovery tasks. A partial run must remain
      // unhealthy so settings and new push opt-ins cannot claim full recovery.
      throw new Error("Private payment mention recovery could not complete.");
    });
    const messages=await dispatchMessageNotifications(settings,new Date(),{timeBudgetMs:Math.max(0,Math.min(20_000,deadlineAt-Date.now()-20_000))});
    const result=await dispatchScheduledNotifications(settings,new Date(),{timeBudgetMs:Math.max(0,deadlineAt-Date.now())});
    await recordRecoveryCompletion(settings);
    return privateJSON({ok:true,mentionsRecovered,messageNotifications:messages,recoveryCheckedIn:true,...result});
  }
  catch{
    if(settings)await recordRecoveryFailure(settings).catch(()=>undefined);
    return privateJSON({ok:false,text:"Scheduled notification processing could not complete."},503);
  }
}
