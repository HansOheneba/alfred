import { undoFinanceImport } from "@/lib/portability/service";
import { portabilityFailure, PRIVATE_HEADERS, readIdentifier, requireSameOrigin } from "@/lib/portability/http";
import { requireOwner } from "@/lib/web/api";
export async function POST(request: Request) {
  const originError = requireSameOrigin(request); if (originError) return originError;
  const owner = await requireOwner(); if (owner instanceof Response) return owner;
  try { return Response.json({ ok: true, receipt: await undoFinanceImport(owner.settings.supabase, owner.profile.profileId, await readIdentifier(request,"receiptId")) }, { headers: PRIVATE_HEADERS }); }
  catch (error) { return portabilityFailure(error); }
}
