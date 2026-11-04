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
import { includePaymentChatEntry, loadPaymentChatEntry } from "@/app/chat/payment-entry";
import { chatReadDeadline } from "@/app/chat/read-deadline";
import { paymentLinkId } from "@/app/chat/payment-link";

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

export async function GET(request?: Request): Promise<Response> {
  await connection();
  const headers = { "cache-control": "private, no-store" };
  let user;
  try { user = await chatReadDeadline(getAuthUser(), 8000); }
  catch { return Response.json({ ok: false, text: "Alfred couldn't check your sign-in. Please try again." }, { status: 503, headers }); }
  if (!user) return Response.json({ ok: false, text: "Sign in to talk to Alfred." }, { status: 401, headers });
  try {
    const settings = getStudioSettings();
    if ((await chatReadDeadline(openAccount(settings.supabase, user), 8000)) === "not_invited") {
      return Response.json({ ok: false, text: NOT_INVITED }, { status: 403, headers });
    }
    const requestedPayment = request ? new URL(request.url).searchParams.getAll("payment") : [];
    const part = request ? new URL(request.url).searchParams.get("part") : null;
    if (part && !["payment", "history", "choices"].includes(part)) return Response.json({ ok: false, text: "That conversation request isn't supported." }, { status: 400, headers });
    const paymentId = requestedPayment.length === 1 ? paymentLinkId(requestedPayment[0]) : null;
    if (part === "payment") {
      const paymentEntry = paymentId
        ? await chatReadDeadline(loadPaymentChatEntry(settings.supabase, user.id, paymentId), 8000)
        : { state: "unavailable" as const };
      return Response.json({ ok: true, ownerId: user.id, messages: paymentEntry.state === "ready" ? [present(paymentEntry.message)] : [], paymentEntry, part }, { headers });
    }
    if (part === "history") {
      const history = await chatReadDeadline(createSupabaseMessageLog(settings.supabase).listRecent(user.id, 80), 8000);
      return Response.json({ ok: true, ownerId: user.id, messages: history.map(present), part }, { headers });
    }
    if (part === "choices") {
      // No 80-message history or accounting hydration is needed to offer the
      // selected source's current buttons. A late read cannot file anything.
      const [entry, recent, profile] = await chatReadDeadline(Promise.all([
        requestedPayment.length && paymentId ? loadPaymentChatEntry(settings.supabase, user.id, paymentId, { loadTransfer: async () => null }) : Promise.resolve(null),
        requestedPayment.length ? Promise.resolve([] as ChatMessageRecord[]) : createSupabaseMessageLog(settings.supabase).listRecent(user.id, 1),
        createSupabaseAccountDirectory(settings.supabase).loadOwner(user.id),
      ]), 8000);
      const selected = requestedPayment.length ? entry?.state === "ready" ? entry.message : undefined : recent.at(-1);
      let choicesUnavailable = false;
      const choices = profile && selected
        ? await chatReadDeadline(openChoices(profile, createStudioDeps(settings), selected), 2500).catch(() => { choicesUnavailable = true; return []; })
        : [];
      return Response.json({ ok: true, ownerId: user.id, messages: [], choices, choicesUnavailable, part, ...(requestedPayment.length ? { choiceTarget: paymentId, sourceVersion: entry?.state === "ready" ? entry.sourceVersion : null } : {}) }, { headers });
    }
    const [recent, paymentEntry] = await Promise.all([
      chatReadDeadline(createSupabaseMessageLog(settings.supabase).listRecent(user.id, 80), 8000),
      requestedPayment.length ? chatReadDeadline(loadPaymentChatEntry(settings.supabase, user.id, requestedPayment.length === 1 ? requestedPayment[0] : requestedPayment), 8000)
        .catch((error) => { logError("web_chat_payment_entry", error); return { state: "unavailable" } as const; }) : Promise.resolve(null),
    ]);
    const history = includePaymentChatEntry(recent, paymentEntry);
    const profile = await chatReadDeadline(createSupabaseAccountDirectory(settings.supabase).loadOwner(user.id), 8000);
    // Buttons are a convenience: the history still loads if they can't be worked out.
    const choices = profile
      ? await chatReadDeadline(openChoices(profile, createStudioDeps(settings), paymentEntry?.state === "ready" ? paymentEntry.message : requestedPayment.length ? undefined : history.at(-1)), 2500).catch((error) => (logError("web_chat_choices", error), []))
      : [];
    return Response.json({ ok: true, ownerId: user.id, messages: history.map(present), choices, ...(requestedPayment.length ? { paymentEntry } : {}) }, { headers });
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

  if (json && typeof json === "object" && !Array.isArray(json) && Object.hasOwn(json, "expectedOwnerId")) {
    const input = json as Record<string, unknown>, expectedOwnerId = paymentLinkId(input.expectedOwnerId);
    if (!expectedOwnerId) return Response.json({ ok: false, text: "Reload this page to check your session." }, { status: 400 });
    if (expectedOwnerId !== user.id.toLowerCase()) return Response.json({ ok: false, sessionChanged: true, text: "Your session changed. Reload this page to continue." }, { status: 409 });
    // The owner assertion is only a fence, never an authority. Existing strict
    // action schemas still validate the actual user instruction below.
    const instruction = { ...input };
    delete instruction.expectedOwnerId;
    json = instruction;
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
