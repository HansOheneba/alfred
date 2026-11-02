import { previewPendingFinanceActivation } from "@/lib/portability/pending";
import { portabilityFailure,PRIVATE_HEADERS,requireSameOrigin } from "@/lib/portability/http";
import { requireOwner } from "@/lib/web/api";
export async function POST(request:Request,context:{params:Promise<{receiptId:string}>}) {
 const originError=requireSameOrigin(request);if(originError)return originError;
 const owner=await requireOwner();if(owner instanceof Response)return owner;
 try{return Response.json({ok:true,...await previewPendingFinanceActivation(owner.settings.supabase,owner.profile.profileId,(await context.params).receiptId)},{headers:PRIVATE_HEADERS});}catch(error){return portabilityFailure(error);}
}
