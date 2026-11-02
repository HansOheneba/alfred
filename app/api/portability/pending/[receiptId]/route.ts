import { pendingFinanceDataDetails } from "@/lib/portability/pending";
import { portabilityFailure,PRIVATE_HEADERS } from "@/lib/portability/http";
import { requireOwner } from "@/lib/web/api";
export async function GET(_request:Request,context:{params:Promise<{receiptId:string}>}) {
 const owner=await requireOwner();if(owner instanceof Response)return owner;
 try{return Response.json({ok:true,...await pendingFinanceDataDetails(owner.settings.supabase,owner.profile.profileId,(await context.params).receiptId)},{headers:PRIVATE_HEADERS});}catch(error){return portabilityFailure(error);}
}
