import { z } from "zod";
import { readCollectorHealthBody, removeCollectorHealth } from "@/lib/bank/collector-health";
import { privateJSON, sameOrigin, displayedOwnerMatches } from "@/lib/notifications/http";
import { requireOwner } from "@/lib/web/api";

export const maxDuration = 10;
const selection = z.object({ deviceId: z.uuid().transform(value => value.toLowerCase()) }).strict();

/** Signed-in owner action only. A forwarding key cannot remove saved status. */
export async function DELETE(request: Request): Promise<Response> {
  if (new URL(request.url).search || !sameOrigin(request)) return privateJSON({ ok: false, text: "Use the signed-in Automations page." }, 403);
  try {
    const owner = await requireOwner();
    if (owner instanceof Response) return privateJSON({ ok: false, text: owner.status === 401 ? "Sign in first." : "Mac status is unavailable." }, owner.status);
    const ownerId = owner.profile.profileId;
    if (!displayedOwnerMatches(request, ownerId)) return privateJSON({ ok: false, text: "Your account changed. Reload Alfred before removing Mac status." }, 409);
    let value;
    try { value = selection.safeParse(await readCollectorHealthBody(request)); }
    catch { return privateJSON({ ok: false, text: "Choose a saved Mac status to remove." }, 400); }
    if (!value.success) return privateJSON({ ok: false, text: "Choose a saved Mac status to remove." }, 400);
    const removed = await removeCollectorHealth(owner.settings.supabase, ownerId, value.data.deviceId);
    return privateJSON({ ok: true, ownerId, deviceId: value.data.deviceId, removed });
  } catch {
    return privateJSON({ ok: false, text: "The saved Mac status could not be removed. Try again." }, 503);
  }
}
