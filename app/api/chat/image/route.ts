import { isClientMessageId, type ChatMessageRecord } from "@/lib/accounts/messages";
import { createSupabaseMessageLog } from "@/lib/accounts/supabase-messages";
import { LIMITS } from "@/lib/config";
import { logError } from "@/lib/log";
import { IMAGE_TYPES, MAX_IMAGE_BYTES, readImageText } from "@/lib/ocr/read-image";
import { bankScreenshotReply } from "@/lib/ocr/screenshot-turn";
import { DbRateLimiter } from "@/lib/security/db-rate-limit";
import { createStudioDeps, handleProfileTurn } from "@/lib/studio/handle";
import { fail, requireOwner } from "@/lib/web/api";

export const maxDuration = 60;

function present(message: ChatMessageRecord) {
  return {
    id: message.id,
    role: message.role,
    text: message.body,
    channel: message.channel,
    createdAt: message.createdAt,
    clientId: message.clientId,
    chart: message.chart ?? null,
  };
}

/** Reads a screenshot sent from the web chat: bank texts are filed, anything else goes to Alfred as a message. */
export async function POST(request: Request): Promise<Response> {
  const owner = await requireOwner();
  if (owner instanceof Response) return owner;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail("Send an image.", 400);
  }
  const image = form.get("image");
  const clientId = String(form.get("clientId") ?? "");
  if (!(image instanceof Blob) || !isClientMessageId(clientId)) return fail("Send an image.", 400);
  if (image.size === 0 || image.size > MAX_IMAGE_BYTES) return fail("That image is too large. Try a screenshot under 4 MB.", 413);
  const mime = image.type || "image/jpeg";
  if (!IMAGE_TYPES.includes(mime)) return fail("Send a PNG, JPEG, WebP or HEIC image.", 415);

  const { settings, profile } = owner;
  const allowed = await new DbRateLimiter(settings.supabase, LIMITS.rateLimit, LIMITS.rateWindowMs).allow(profile.profileId, Date.now());
  if (!allowed) return fail("Too many messages. Wait a minute and try again.", 429);

  const messages = createSupabaseMessageLog(settings.supabase);
  const thread = async () => (await messages.listByClientId(profile.profileId, clientId)).map(present);
  try {
    const existing = await messages.listByClientId(profile.profileId, clientId);
    if (existing.some((item) => item.role === "assistant")) return Response.json({ ok: true, messages: existing.map(present) });
    await messages.append({ ownerId: profile.profileId, role: "user", body: "📷 Screenshot", channel: "web", clientId });

    const read = await readImageText({ bytes: Buffer.from(await image.arrayBuffer()), mime, deepseek: settings.deepseek, google: settings.google });
    if (!read.text) {
      await messages.append({ ownerId: profile.profileId, role: "assistant", body: "I couldn't make out any text in that image. A sharper screenshot usually does it.", channel: "web", clientId });
      return Response.json({ ok: true, messages: await thread() });
    }

    const bankReply = await bankScreenshotReply(settings.supabase, profile, read);
    if (bankReply) {
      await messages.append({ ownerId: profile.profileId, role: "assistant", body: bankReply, channel: "web", clientId, intent: "bank:screenshot" });
      return Response.json({ ok: true, text: bankReply, messages: await thread() });
    }

    // A receipt or anything else: Alfred reads the text like a message, and always confirms before saving.
    const deps = createStudioDeps({ ...settings, confirmTransactions: "always" });
    const result = await handleProfileTurn(profile, { text: `📷 Screenshot\n${read.text}`.slice(0, LIMITS.maxUserTextChars), clientId }, deps);
    return Response.json({ ok: true, text: result.text, actionId: result.actionId ?? null, messages: (result.messages ?? []).map(present) });
  } catch (error) {
    logError("chat_image", error);
    return fail("Alfred couldn't read that image. Try again in a moment.", 500);
  }
}
