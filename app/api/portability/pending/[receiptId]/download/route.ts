import { downloadPendingFinanceData } from "@/lib/portability/pending";
import { portabilityFailure,PRIVATE_HEADERS } from "@/lib/portability/http";
import { requireOwner } from "@/lib/web/api";
export async function GET(_request:Request,context:{params:Promise<{receiptId:string}>}) {
 const owner=await requireOwner();if(owner instanceof Response)return owner;
 try{const result=await downloadPendingFinanceData(owner.settings.supabase,owner.profile.profileId,(await context.params).receiptId);return new Response(new Uint8Array(result.bytes),{headers:{...PRIVATE_HEADERS,"Content-Type":"application/zip","Content-Disposition":`attachment; filename="saved-finance-${result.receiptId}.zip"`,"X-Source-Archive-Id":result.archiveId}});}catch(error){return portabilityFailure(error);}
}
