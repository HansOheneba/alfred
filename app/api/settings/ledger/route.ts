import { connection } from "next/server";
import { requireOwner } from "@/lib/web/api";
import { loadLedger } from "@/lib/web/ledger";

const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
export async function GET() {
  await connection();
  try {
    const owner = await requireOwner();
    if (owner instanceof Response) return new Response(owner.body, { status: owner.status, headers: { ...Object.fromEntries(owner.headers), ...headers } });
    return Response.json({ ok: true, ownerId: owner.profile.profileId, ledger: await loadLedger(owner.profile, owner.settings) }, { headers });
  } catch {
    return Response.json({ ok: false, text: "Your financial records could not be loaded. Please try again." }, { status: 500, headers });
  }
}
