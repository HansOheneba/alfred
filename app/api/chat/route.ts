import { connection } from "next/server";

import { chatChoiceSchema, chatDecisionSchema, chatTextSchema } from "@/lib/accounts/chat-request";
import { createSupabaseAccountDirectory } from "@/lib/accounts/supabase-directory";
import { createSupabaseMessageLog } from "@/lib/accounts/supabase-messages";
import type { ChatMessageRecord } from "@/lib/accounts/messages";
import { openAccount } from "@/lib/accounts/settings-store";
import { NOT_INVITED } from "@/lib/auth/invites";
import { LIMITS } from "@/lib/config";
import { getStudioSettings } from "@/lib/env";
import { logError } from "@/lib/log";
import { DbRateLimiter } from "@/lib/security/db-rate-limit";
import { createStudioDeps, handleProfileTurn, openChoices } from "@/lib/studio/handle";
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
    chart: message.chart ?? null,
    ledgerChanged: message.ledgerChanged,
    paymentNotice:message.paymentNotice,
    newTopic:message.newTopic,
  };
}

export async function GET(): Promise<Response> {
  await connection();
  const user = await getAuthUser();
  const headers = { "cache-control": "private, no-store" };
  if (!user) return Response.json({ ok: false, text: "Sign in to talk to Alfred." }, { status: 401, headers });
  try {
    const settings = getStudioSettings();
    if ((await openAccount(settings.supabase, user)) === "not_invited") {
      return Response.json({ ok: false, text: NOT_INVITED }, { status: 403, headers });
    }
    const history = await createSupabaseMessageLog(settings.supabase).listRecent(user.id, 80);
    const profile = await createSupabaseAccountDirectory(settings.supabase).loadOwner(user.id);
    // Buttons are a convenience: the history still loads if they can't be worked out.
    const choices = profile
      ? await openChoices(profile, createStudioDeps(settings), history.at(-1)).catch((error) => (logError("web_chat_choices", error), []))
      : [];
    return Response.json({ ok: true, ownerId: user.id, messages: history.map(present), choices }, { headers });
  } catch (error) {
    logError("web_chat_history", error);
    return Response.json({ ok: false, text: userFacingError(error) }, { status: 500, headers });
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
  const choice = chatChoiceSchema.safeParse(json);
  if (!text.success && !decision.success && !choice.success) {
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
    if ((await openAccount(settings.supabase, user)) === "not_invited") {
      return Response.json({ ok: false, text: NOT_INVITED }, { status: 403 });
    }
    const profile = await createSupabaseAccountDirectory(settings.supabase).loadOwner(user.id);
    if (!profile) return Response.json({ ok: false, text: "Your profile is not ready yet." }, { status: 500 });
    const turn = text.success
      ? { text: text.data.text, clientId: text.data.clientId, replyToPayment:text.data.replyToPayment, newTopic:text.data.newTopic }
      : decision.success
        ? { decision: decision.data.decision, actionId: decision.data.actionId, clientId: decision.data.clientId }
        : choice.success
          ? { choice: choice.data.choice, clientId: choice.data.clientId, replyToPayment: choice.data.replyToPayment }
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
      choices: result.choices ?? [],
      ledgerChanged: result.ledgerChanged ?? true,
    });
  } catch (error) {
    logError("web_chat", error);
    return Response.json({ ok: false, text: userFacingError(error) }, { status: 500 });
  }
}
