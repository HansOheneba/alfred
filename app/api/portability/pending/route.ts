import { listPendingFinanceData } from "@/lib/portability/pending";
import { portabilityFailure,PRIVATE_HEADERS } from "@/lib/portability/http";
import { requireOwner } from "@/lib/web/api";
export async function GET(request:Request) {
 const owner=await requireOwner();if(owner instanceof Response)return owner;
 try{return Response.json({ok:true,...await listPendingFinanceData(owner.settings.supabase,owner.profile.profileId,new URL(request.url).searchParams.get("cursor")??undefined)},{headers:PRIVATE_HEADERS});}catch(error){return portabilityFailure(error);}
}
