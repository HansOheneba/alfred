import { z } from "zod";
import { requireOwner } from "@/lib/web/api";
import { createNotificationStore } from "@/lib/notifications/store";
import { pushConfiguration } from "@/lib/notifications/push";
import { notificationJSON, privateJSON, sameOrigin, displayedOwnerMatches } from "@/lib/notifications/http";
const remove=z.union([z.object({id:z.string().uuid()}).strict(),z.object({endpoint:z.string().url().max(2048)}).strict()]);
export async function POST(request:Request):Promise<Response> {
  if(!sameOrigin(request))return privateJSON({ok:false,text:"Use the signed-in Alfred page to enable this browser."},403);
  try {
    const owner=await requireOwner();if(owner instanceof Response)return owner;
    if(!displayedOwnerMatches(request,owner.profile.profileId))return privateJSON({ok:false,text:"Your account changed. Reload Alfred before changing notifications."},409);
    if(!pushConfiguration().ready)return privateJSON({ok:false,text:"Web push has not been configured on the server."},503);
    const deviceId=await createNotificationStore(owner.settings.supabase).subscribe(owner.profile.profileId,await notificationJSON(request));
    return privateJSON({ok:true,deviceId});
  }catch{return privateJSON({ok:false,text:"This browser could not be registered. Check notification permission and try again."},400);}
}
export async function DELETE(request:Request):Promise<Response> {
  if(!sameOrigin(request))return privateJSON({ok:false,text:"Use the signed-in Alfred page to remove this browser."},403);
  try {
    const owner=await requireOwner();if(owner instanceof Response)return owner;
    if(!displayedOwnerMatches(request,owner.profile.profileId))return privateJSON({ok:false,text:"Your account changed. Reload Alfred before changing notifications."},409);
    const parsed=remove.safeParse(await notificationJSON(request));if(!parsed.success)return privateJSON({ok:false,text:"Choose a valid device."},400);
    await createNotificationStore(owner.settings.supabase).unsubscribe(owner.profile.profileId,parsed.data);
    return privateJSON({ok:true});
  }catch{return privateJSON({ok:false,text:"This browser could not be removed."},400);}
}
