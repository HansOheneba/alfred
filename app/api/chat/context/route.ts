import { connection } from "next/server";
import { logError } from "@/lib/log";
import { requireOwner } from "@/lib/web/api";
import { loadChatContext } from "@/lib/web/secondary-read-models";
import { DurableDisplayUpdating } from "@/lib/finance/accounting/durable-read";

/** Optional conversation context. A failed summary must never hide the composer. */
export async function GET(): Promise<Response> {
  await connection();
  try {
    const owner = await requireOwner();
    if (owner instanceof Response) {
      owner.headers.set("cache-control", "no-store");
      return owner;
    }
    const context = await loadChatContext(owner.profile, owner.settings);
    return Response.json({ ok: true, ownerId: owner.profile.profileId, context }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if(error instanceof DurableDisplayUpdating)return Response.json({ok:false,updating:true,text:error.message},{status:202,headers:{'cache-control':'no-store'}});
    logError("chat_context", error);
    return Response.json({ ok: false, text: "Your financial summary could not be loaded. You can keep chatting and try again." }, { status: 500, headers: { "cache-control": "no-store" } });
  }
}
