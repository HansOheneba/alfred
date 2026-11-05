import { connection } from "next/server";
import { requireOwner } from "@/lib/web/api";
import { InvalidOverviewPage, loadOverviewTransactionPage, OverviewChanged, parseOverviewTransactionQuery } from "@/lib/web/overview";
import { DurableDisplayUpdating } from "@/lib/finance/accounting/durable-read";

export const maxDuration = 60;
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
export async function GET(request: Request): Promise<Response> {
  await connection();
  try {
    const owner = await requireOwner();
    if (owner instanceof Response) {
      const responseHeaders = new Headers(owner.headers);
      for (const [name, value] of Object.entries(headers)) responseHeaders.set(name, value);
      return new Response(owner.body, { status: owner.status, headers: responseHeaders });
    }
    const params = new URL(request.url).searchParams;
    let query;
    try { query = parseOverviewTransactionQuery(params); }
    catch { return Response.json({ ok: false, text: "Check the transaction filters." }, { status: 400, headers }); }
    const page = await loadOverviewTransactionPage(owner.profile, owner.settings, query, params.get("cursor"));
    return Response.json({ ok: true, ownerId: owner.profile.profileId, page }, { headers });
  } catch (error) {
    if(error instanceof DurableDisplayUpdating)return Response.json({ok:false,updating:true,text:error.message},{status:202,headers});
    if (error instanceof InvalidOverviewPage) return Response.json({ ok: false, text: error.message }, { status: 400, headers });
    if (error instanceof OverviewChanged) return Response.json({ ok: false, text: error.message, stale: true }, { status: 409, headers });
    return Response.json({ ok: false, text: "Your transactions could not be loaded. Please try again." }, { status: 503, headers });
  }
}
