import { MAX_ARCHIVE_BYTES, previewFinanceImport } from "@/lib/portability/service";
import { boundedBody, portabilityFailure, PRIVATE_HEADERS, requireSameOrigin } from "@/lib/portability/http";
import { requireOwner } from "@/lib/web/api";
export async function POST(request: Request) {
  const originError = requireSameOrigin(request); if (originError) return originError;
  const owner = await requireOwner(); if (owner instanceof Response) return owner;
  try { return Response.json({ ok: true, preview: await previewFinanceImport(owner.settings.supabase, owner.profile.profileId, await boundedBody(request, MAX_ARCHIVE_BYTES)) }, { headers: PRIVATE_HEADERS }); }
  catch (error) { return portabilityFailure(error); }
}
