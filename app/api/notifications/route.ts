import { z } from "zod";
import { requireOwner } from "@/lib/web/api";
import { createNotificationStore } from "@/lib/notifications/store";
import { pushConfiguration } from "@/lib/notifications/push";
import { notificationJSON, privateJSON, sameOrigin, displayedOwnerMatches } from "@/lib/notifications/http";
import { loadRecoveryStatus } from "@/lib/notifications/recovery";
import { notificationPolicyAvailable } from "@/lib/notifications/schema-ready";

const patch=z.object({paymentMentions:z.boolean().optional(),outgoingMentions:z.boolean().optional(),paymentPush:z.boolean().optional(),billReminders:z.boolean().optional(),weeklyOverview:z.boolean().optional()}).strict().refine(value=>Object.keys(value).length>0,"Choose a notification preference.");
export async function GET():Promise<Response> {
  try {
    const owner=await requireOwner();if(owner instanceof Response)return owner;
    const store=createNotificationStore(owner.settings.supabase),configuration=pushConfiguration();
    const [preferences,devices,recovery,policyReady]=await Promise.all([store.preferences(owner.profile.profileId),store.devices(owner.profile.profileId),loadRecoveryStatus(owner.settings.supabase),notificationPolicyAvailable(owner.settings.supabase)]);
    const ready=recovery.ready&&policyReady;
    const recoverySummary={configured:recovery.configured,ready,lastCompletedAt:recovery.lastCompletedAt,expectedIntervalSeconds:recovery.expectedIntervalSeconds,reason:policyReady?recovery.reason:"schema-unavailable"};
    return privateJSON({ok:true,ownerId:owner.profile.profileId,preferences,devices,push:{configured:configuration.ready,publicKey:configuration.publicKey,
      deliveryEnabled:process.env.ALFRED_PUSH_DELIVERY_ENABLED==="true",schedulesEnabled:process.env.ALFRED_NOTIFICATION_SCHEDULES_ENABLED==="true",recoveryReady:ready,recovery:recoverySummary}});
  }catch{return privateJSON({ok:false,text:"Notification settings are unavailable. The reviewed notification schema and server configuration must be installed first."},503);}
}
export async function PATCH(request:Request):Promise<Response> {
  if(!sameOrigin(request))return privateJSON({ok:false,text:"Use the signed-in Alfred page to change notifications."},403);
  try {
    const owner=await requireOwner();if(owner instanceof Response)return owner;
    if(!displayedOwnerMatches(request,owner.profile.profileId))return privateJSON({ok:false,text:"Your account changed. Reload Alfred before changing notifications."},409);
    const result=patch.safeParse(await notificationJSON(request));
    if(!result.success)return privateJSON({ok:false,text:"Choose valid notification preferences."},400);
    if(result.data.paymentPush===true||result.data.billReminders===true||result.data.weeklyOverview===true){
      const [recovery,policyReady]=await Promise.all([loadRecoveryStatus(owner.settings.supabase),notificationPolicyAvailable(owner.settings.supabase)]);
      if(!pushConfiguration().ready||process.env.ALFRED_PUSH_DELIVERY_ENABLED!=="true"||!recovery.ready||!policyReady)
        return privateJSON({ok:false,text:"Push notifications need configured delivery and a recent healthy scheduled recovery check-in before they can be enabled.",recoveryReady:false},503);
    }
    const preferences=await createNotificationStore(owner.settings.supabase).update(owner.profile.profileId,result.data);
    return privateJSON({ok:true,preferences});
  }catch{return privateJSON({ok:false,text:"Notification preferences could not be saved."},400);}
}
