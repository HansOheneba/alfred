import { cookies } from "next/headers";

import { exportFinanceArchive } from "@/lib/portability/service";
import { browserPreferencesFromExportQuery } from "@/lib/portability/browser-preferences";
import { portabilityFailure, PRIVATE_HEADERS } from "@/lib/portability/http";
import { requireOwner } from "@/lib/web/api";
import { HOME_COOKIE, readHome } from "@/lib/web/home";
export async function GET(request: Request) {
  const owner = await requireOwner(); if (owner instanceof Response) return owner;
  try {
    let browserPreferences;
    try { browserPreferences = browserPreferencesFromExportQuery(new URL(request.url), readHome((await cookies()).get(HOME_COOKIE)?.value)); }
    catch { return Response.json({ ok: false, text: "Choose valid appearance and privacy settings before exporting." }, { status: 400, headers: PRIVATE_HEADERS }); }
    const bytes = await exportFinanceArchive(owner.settings.supabase, owner.profile.profileId, browserPreferences);
    return new Response(new Uint8Array(bytes), { headers: { ...PRIVATE_HEADERS, "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="alfred-finance-${new Date().toISOString().slice(0,10)}.zip"` } });
  } catch (error) { return portabilityFailure(error); }
}
