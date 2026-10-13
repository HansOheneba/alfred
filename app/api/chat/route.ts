import { chatDecisionSchema, chatTextSchema } from "@/lib/accounts/chat-request";
import { createSupabaseAccountDirectory } from "@/lib/accounts/supabase-directory";
import { createSupabaseMessageLog } from "@/lib/accounts/supabase-messages";
import type { ChatMessageRecord } from "@/lib/accounts/messages";
import { ensureAccount } from "@/lib/accounts/settings-store";
import { LIMITS } from "@/lib/config";
import { getStudioSettings } from "@/lib/env";
import { logError } from "@/lib/log";
import { DbRateLimiter } from "@/lib/security/db-rate-limit";
import { createStudioDeps, handleProfileTurn } from "@/lib/studio/handle";
import { getAuthUser } from "@/lib/supabase/session";
import { userFacingError } from "@/lib/telegram/messages";

export const maxDuration = 60;

function present(message: ChatMessageRecord) {
  return {
    id: message.id,
    role: message.role,
    text: message.body,
    channel: message.channel,
    createdAt: message.createdAt,
    clientId: message.clientId,
  };
}

export async function GET(): Promise<Response> {
  const user = await getAuthUser();
  if (!user) return Response.json({ ok: false, text: "Sign in to talk to Alfred." }, { status: 401 });
  try {
    const settings = getStudioSettings();
    await ensureAccount(settings.supabase, user.id);
    const history = await createSupabaseMessageLog(settings.supabase).listRecent(user.id, 80);
    return Response.json({ ok: true, messages: history.map(present) });
  } catch (error) {
    logError("web_chat_history", error);
    return Response.json({ ok: false, text: userFacingError(error) }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<Response> {
  const user = await getAuthUser();
  if (!user) return Response.json({ ok: false, text: "Sign in to talk to Alfred." }, { status: 401 });

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > LIMITS.maxBodyBytes) {
    return Response.json({ ok: false, text: "That message is too long." }, { status: 413 });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return Response.json({ ok: false, text: "Send a text message." }, { status: 400 });
  }

  const text = chatTextSchema.safeParse(json);
  const decision = chatDecisionSchema.safeParse(json);
  if (!text.success && !decision.success) {
    return Response.json({ ok: false, text: "Send a text message." }, { status: 400 });
  }

  try {
    const settings = getStudioSettings();
    const allowed = await new DbRateLimiter(settings.supabase, LIMITS.rateLimit, LIMITS.rateWindowMs).allow(
      user.id,
      Date.now(),
    );
    if (!allowed) {
      return Response.json({ ok: false, text: "Too many messages. Wait a minute and try again." }, { status: 429 });
    }
    await ensureAccount(settings.supabase, user.id);
    const profile = await createSupabaseAccountDirectory(settings.supabase).loadOwner(user.id);
    if (!profile) return Response.json({ ok: false, text: "Your profile is not ready yet." }, { status: 500 });
    const turn = text.success
      ? { text: text.data.text, clientId: text.data.clientId }
      : decision.success
        ? { decision: decision.data.decision, actionId: decision.data.actionId, clientId: decision.data.clientId }
        : null;
    if (!turn) return Response.json({ ok: false, text: "Send a text message." }, { status: 400 });
    const result = await handleProfileTurn(profile, turn, createStudioDeps(settings));
    if (result.pending) {
      return Response.json({ ok: false, text: result.text, messages: (result.messages ?? []).map(present) }, { status: 409 });
    }
    return Response.json({
      ok: true,
      text: result.text,
      actionId: result.actionId ?? null,
      messages: (result.messages ?? []).map(present),
    });
  } catch (error) {
    logError("web_chat", error);
    return Response.json({ ok: false, text: userFacingError(error) }, { status: 500 });
  }
}
