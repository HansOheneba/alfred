import { accountingActionSchema, MAX_ACCOUNTING_COMMAND_BYTES } from "@/lib/finance/accounting/schema";
import { loadAccountingState, saveAccountingAction, type AccountingResult } from "@/lib/finance/accounting/persisted-store";
import { AccountingError } from "@/lib/finance/accounting/types";
import { fail, requireOwner } from "@/lib/web/api";

const publicResult=(result:AccountingResult) => ({state:result.state,availability:result.availability});

function failure(error:unknown):Response {
  if (error instanceof AccountingError) return Response.json({ok:false,text:error.message,code:error.code},{status:error.code==="stale" || error.code==="conflict" ? 409 : error.code==="ownership" ? 403 : 400,headers:{"Cache-Control":"no-store"}});
  return fail("The financial records could not be loaded. Try again shortly.",500);
}
export async function GET() {
  const owner=await requireOwner();
  if (owner instanceof Response) return owner;
  try { return Response.json({ok:true,...publicResult(await loadAccountingState(owner.settings.supabase,owner.profile.profileId))},{headers:{"Cache-Control":"no-store"}}); }
  catch(error) { return failure(error); }
}
export async function POST(request:Request) {
  const owner=await requireOwner();
  if (owner instanceof Response) return owner;
  if (Number(request.headers.get("content-length"))>MAX_ACCOUNTING_COMMAND_BYTES) return fail("Financial request is too large.",413);
  // Stream-bound before parsing; clients cannot bypass the limit with omitted Content-Length.
  const reader=request.body?.getReader();
  if (!reader) return fail("A financial action is required.",400);
  let size=0; const chunks:Uint8Array[]=[];
  try {
    while (true) { const item=await reader.read(); if(item.done) break; size+=item.value.byteLength; if(size>MAX_ACCOUNTING_COMMAND_BYTES) {await reader.cancel();return fail("Financial request is too large.",413);} chunks.push(item.value); }
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    const parsed=accountingActionSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    if(!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Check the financial action.",400);
    const result=await saveAccountingAction(owner.settings.supabase,owner.profile.profileId,parsed.data);
    if(result.availability!=="ready") return Response.json({ok:false,text:"The accounting migration is required before saving. No financial change was made.",...publicResult(result)},{status:503,headers:{"Cache-Control":"no-store"}});
    return Response.json({ok:true,...publicResult(result)},{headers:{"Cache-Control":"no-store"}});
  } catch(error) {if(error instanceof SyntaxError) return fail("That financial request could not be read.",400);return failure(error);}
}
