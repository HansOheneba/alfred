import { z } from "zod";
import { requireOwner } from "@/lib/web/api";
import { createNotificationStore } from "@/lib/notifications/store";
import { notificationJSON, privateJSON, sameOrigin, displayedOwnerMatches } from "@/lib/notifications/http";
const body=z.object({endpoint:z.string().url().max(2048)}).strict();
export async function POST(request:Request):Promise<Response> {
  if(!sameOrigin(request))return privateJSON({ok:false,text:"Use the signed-in Alfred page."},403);
  try {
    const owner=await requireOwner();if(owner instanceof Response)return owner;
    if(!displayedOwnerMatches(request,owner.profile.profileId))return privateJSON({ok:false,text:"Your account changed. Reload Alfred before changing notifications."},409);
    const value=body.safeParse(await notificationJSON(request));if(!value.success)return privateJSON({ok:false,text:"Invalid browser subscription."},400);
    const device=await createNotificationStore(owner.settings.supabase).deviceForEndpoint(owner.profile.profileId,value.data.endpoint);
    return privateJSON({ok:true,ownerId:owner.profile.profileId,device});
  }catch{return privateJSON({ok:false,text:"Browser notification status is unavailable."},503);}
}
