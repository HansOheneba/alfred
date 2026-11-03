import { timingSafeEqual } from "node:crypto";
import { getDatabaseSettings } from "@/lib/env";
import { dispatchScheduledNotifications } from "@/lib/notifications/service";
import { privateJSON } from "@/lib/notifications/http";
import { recoverAllIncomingPaymentMentions } from "@/lib/bank/notices";
import { logError } from "@/lib/log";
import { recoveryConfiguration,recordRecoveryCompletion,recordRecoveryFailure } from "@/lib/notifications/recovery";
import type { SupabaseSettings } from "@/lib/config";
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
    settings=getDatabaseSettings();
    const mentionsRecovered=await recoverAllIncomingPaymentMentions(settings).catch(()=>{
      logError("notification_mentions_recovery",new Error("Private payment mention recovery could not complete."));
      return null;
    });
    const result=await dispatchScheduledNotifications(settings);
    await recordRecoveryCompletion(settings);
    return privateJSON({ok:true,mentionsRecovered,recoveryCheckedIn:true,...result});
  }
  catch{
    if(settings)await recordRecoveryFailure(settings).catch(()=>undefined);
    return privateJSON({ok:false,text:"Scheduled notification processing could not complete."},503);
  }
}
