import { LIMITS } from "@/lib/config";
import { getSettings } from "@/lib/env";
import { logError } from "@/lib/log";
import { createHandlerDeps, handleTelegramUpdate } from "@/lib/telegram/handle-update";
import { telegramUpdateSchema } from "@/lib/telegram/schemas";
import { verifyWebhookSecret } from "@/lib/telegram/verify";

export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  const headerSecret = request.headers.get("x-telegram-bot-api-secret-token");
  let settings;
  try {
    settings = getSettings();
  } catch (error) {
    logError("config", error);
    return Response.json({ ok: false }, { status: 500 });
  }

  if (!verifyWebhookSecret(headerSecret, settings.webhookSecret)) {
    return Response.json({ ok: false }, { status: 401 });
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > LIMITS.maxBodyBytes) {
    return Response.json({ ok: false }, { status: 413 });
  }

  let raw = "";
  try {
    raw = await request.text();
  } catch (error) {
    logError("webhook_body", error);
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

  const parsed = telegramUpdateSchema.safeParse(json);
  if (!parsed.success) {
    return Response.json({ ok: false }, { status: 400 });
  }

  try {
    const result = await handleTelegramUpdate(parsed.data, createHandlerDeps(settings));
    return Response.json({ ok: result.httpStatus < 500 }, { status: result.httpStatus });
  } catch (error) {
    logError("webhook", error);
    return Response.json({ ok: false }, { status: 500 });
  }
}
