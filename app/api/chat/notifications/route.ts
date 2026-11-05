import { z } from "zod";
import { requireOwner } from "@/lib/web/api";
import { createMessageNotificationStore } from "@/lib/notifications/messages";
import { displayedOwnerMatches, notificationJSON, privateJSON, sameOrigin } from "@/lib/notifications/http";
import { loadRecoveryStatus } from "@/lib/notifications/recovery";
import { pushConfiguration } from "@/lib/notifications/push";

const action = z.discriminatedUnion("op", [
  z.object({ op: z.literal("initialize") }).strict(),
  z.object({ op: z.literal("read"), messageId: z.uuid().nullable(), presenceId: z.uuid(), active: z.boolean() }).strict(),
]);
const patch = z.object({ messagePush: z.boolean().optional(), messagePreview: z.boolean().optional() }).strict().refine(value => Object.keys(value).length > 0);
const unavailable = () => privateJSON({ ok: false, text: "Message updates are unavailable right now. Reload to try again." }, 503);

export async function GET(): Promise<Response> {
  try {
    const owner = await requireOwner(); if (owner instanceof Response) return owner;
    const store = createMessageNotificationStore(owner.settings.supabase);
    if (!await store.available()) return unavailable();
    return privateJSON({ ok: true, ownerId: owner.profile.profileId, ...await store.snapshot(owner.profile.profileId) });
  } catch { return unavailable(); }
}

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return privateJSON({ ok: false }, 403);
  try {
    const owner = await requireOwner(); if (owner instanceof Response) return owner;
    if (!displayedOwnerMatches(request, owner.profile.profileId)) return privateJSON({ ok: false, text: "Your account changed. Reload Alfred." }, 409);
    const input = action.safeParse(await notificationJSON(request));
    if (!input.success) return privateJSON({ ok: false, text: "Choose a valid message update." }, 400);
    const store = createMessageNotificationStore(owner.settings.supabase);
    if (!await store.available()) return unavailable();
    if (input.data.op === "initialize") await store.initialize(owner.profile.profileId);
    else if (!await store.read(owner.profile.profileId, input.data.messageId, input.data.presenceId, input.data.active)) return privateJSON({ ok: false, text: "That message is unavailable in your account." }, 404);
    return privateJSON({ ok: true, ownerId: owner.profile.profileId, ...await store.snapshot(owner.profile.profileId) });
  } catch { return unavailable(); }
}

export async function PATCH(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return privateJSON({ ok: false }, 403);
  try {
    const owner = await requireOwner(); if (owner instanceof Response) return owner;
    if (!displayedOwnerMatches(request, owner.profile.profileId)) return privateJSON({ ok: false, text: "Your account changed. Reload Alfred." }, 409);
    const input = patch.safeParse(await notificationJSON(request));
    if (!input.success) return privateJSON({ ok: false, text: "Choose valid message notification preferences." }, 400);
    const store = createMessageNotificationStore(owner.settings.supabase);
    if (!await store.available()) return unavailable();
    if (input.data.messagePush === true && (!pushConfiguration().ready || process.env.ALFRED_PUSH_DELIVERY_ENABLED !== "true" || !(await loadRecoveryStatus(owner.settings.supabase)).ready)) {
      return privateJSON({ ok: false, text: "Message push needs configured delivery and a recent healthy scheduled recovery check-in." }, 503);
    }
    const preferences = await store.update(owner.profile.profileId, input.data);
    return privateJSON({ ok: true, ownerId: owner.profile.profileId, preferences });
  } catch { return privateJSON({ ok: false, text: "Message notification preferences could not be saved." }, 503); }
}
