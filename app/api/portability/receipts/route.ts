import { listFinanceImportReceipts } from "@/lib/portability/service";
import { portabilityFailure, PRIVATE_HEADERS } from "@/lib/portability/http";
import { requireOwner } from "@/lib/web/api";
export async function GET() {
  const owner = await requireOwner(); if (owner instanceof Response) return owner;
  try { return Response.json({ ok: true, receipts: await listFinanceImportReceipts(owner.settings.supabase, owner.profile.profileId) }, { headers: PRIVATE_HEADERS }); }
  catch (error) { return portabilityFailure(error); }
}
