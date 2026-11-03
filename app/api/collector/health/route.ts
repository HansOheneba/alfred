import { collectorHealthOwner, loadCollectorHealth, parseCollectorHealth, readCollectorHealthBody, recordCollectorHealth } from "@/lib/bank/collector-health";
import { getDatabaseSettings } from "@/lib/env";
import { requireOwner } from "@/lib/web/api";

export const maxDuration = 10;
function answer(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "private, no-store", pragma: "no-cache", vary: "Authorization, Cookie, Origin", "x-content-type-options": "nosniff" } });
}

/** Browser status is visible only through the signed-in account, never a device ID/key. */
export async function GET(request: Request): Promise<Response> {
  if (new URL(request.url).search) return answer({ ok: false, text: "Use the signed-in Automations page." }, 400);
  try {
    const owner = await requireOwner();
    if (owner instanceof Response) return answer({ ok: false, text: owner.status === 401 ? "Sign in first." : "Collector status is unavailable." }, owner.status);
    const devices = await loadCollectorHealth(owner.settings.supabase, owner.profile.profileId);
    return answer({ ok: true, ownerId: owner.profile.profileId, checkedAt: new Date().toISOString(), devices });
  } catch { return answer({ ok: false, text: "Mac status is unavailable. Try again later." }, 503); }
}

/** A native, already-connected Mac reports counts only; this cannot ingest SMS. */
export async function POST(request: Request): Promise<Response> {
  if (new URL(request.url).search) return answer({ ok: false, text: "Collector status must not include URL parameters." }, 400);
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return answer({ ok: false, text: "Collector status was refused." }, 403);
  const match = /^Bearer (alf_[A-Za-z0-9_-]{20,64})$/i.exec(request.headers.get("authorization") ?? "");
  if (!match) return answer({ ok: false, text: "A valid account connection is required." }, 401);
  const expectedOwner = request.headers.get("x-alfred-collector-owner") ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(expectedOwner)) return answer({ ok: false, text: "The connected account must be confirmed." }, 400);
  let report;
  try { report = parseCollectorHealth(await readCollectorHealthBody(request)); }
  catch { return answer({ ok: false, text: "Send only the supported collector status counts." }, 400); }
  try {
    const settings = getDatabaseSettings();
    const ownerId = await collectorHealthOwner(settings, match[1]);
    if (!ownerId) return answer({ ok: false, text: "This account connection could not be verified." }, 401);
    if (ownerId !== expectedOwner.toLowerCase()) return answer({ ok: false, text: "The connected account changed. No status was saved." }, 409);
    const result = await recordCollectorHealth(settings, ownerId, report);
    if (result === "too_soon") return answer({ ok: false, text: "Collector status was already checked recently." }, 429);
    if (result === "device_limit") return answer({ ok: false, text: "This account already has the supported number of Macs." }, 409);
    return answer({ ok: true });
  } catch { return answer({ ok: false, text: "Mac status could not be saved. Payment collection is independent." }, 503); }
}
