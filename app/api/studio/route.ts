import { z } from "zod";

import { LIMITS } from "@/lib/config";
import { getStudioSettings, isStudioEnabled } from "@/lib/env";
import { logError } from "@/lib/log";
import { createStudioDeps, handleStudioTurn, type StudioTurn } from "@/lib/studio/handle";
import { userFacingError } from "@/lib/telegram/messages";

export const maxDuration = 60;

const textTurn = z.object({
  userId: z.number().int(),
  text: z.string().trim().min(1).max(LIMITS.maxUserTextChars),
});

const decisionTurn = z.object({
  userId: z.number().int(),
  decision: z.enum(["confirm", "cancel"]),
  actionId: z.string().regex(/^[A-Za-z0-9_-]{8,32}$/),
});

export async function POST(request: Request): Promise<Response> {
  if (!isStudioEnabled()) {
    return Response.json({ ok: false }, { status: 404 });
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > LIMITS.maxBodyBytes) {
    return Response.json({ ok: false }, { status: 413 });
  }

  let raw = "";
  try {
    raw = await request.text();
  } catch (error) {
    logError("studio_body", error);
    return Response.json({ ok: false }, { status: 400 });
  }
  if (raw.length > LIMITS.maxBodyBytes) {
    return Response.json({ ok: false }, { status: 413 });
  }

  let json: unknown;
  try {
    json = JSON.parse(raw) as unknown;
  } catch {
    return Response.json({ ok: false }, { status: 400 });
  }

  const decision = decisionTurn.safeParse(json);
  const text = textTurn.safeParse(json);
  const turn: StudioTurn | null = text.success
    ? { userId: text.data.userId, text: text.data.text }
    : decision.success
      ? { userId: decision.data.userId, decision: decision.data.decision, actionId: decision.data.actionId }
      : null;
  if (!turn) {
    return Response.json({ ok: false }, { status: 400 });
  }

  try {
    const result = await handleStudioTurn(turn, createStudioDeps(getStudioSettings()));
    return Response.json({ ok: true, text: result.text, actionId: result.actionId ?? null });
  } catch (error) {
    logError("studio", error);
    return Response.json({ ok: false, text: userFacingError(error) }, { status: 500 });
  }
}
