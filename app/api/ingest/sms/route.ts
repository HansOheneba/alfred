import { z } from "zod";

import { ingestAndAnnounce, ownerForToken } from "@/lib/bank/service";
import { LIMITS } from "@/lib/config";
import { getDatabaseSettings } from "@/lib/env";
import { logError, logInfo } from "@/lib/log";
import { DbRateLimiter } from "@/lib/security/db-rate-limit";

export const maxDuration = 30;

const body = z.object({
  text: z.string().trim().min(1).max(4000),
  sender: z.string().trim().max(80).optional().nullable(),
});

/**
 * Records why a forwarded message was refused, without the message itself:
 * content type, byte length and, for JSON bodies, the key names only.
 */
function logRejected(request: Request, reason: string, raw?: string, json?: unknown): void {
  const fields: Record<string, string | number | boolean> = {
    reason,
    contentType: request.headers.get("content-type") ?? "",
    declaredLength: request.headers.get("content-length") ?? "",
    userAgent: request.headers.get("user-agent") ?? "",
  };
  if (raw !== undefined) {
    fields.bodyBytes = new TextEncoder().encode(raw).length;
    fields.blankBody = raw.trim().length === 0;
  }
  if (json && typeof json === "object" && !Array.isArray(json)) {
    fields.jsonKeys = Object.keys(json).join(",");
  }
  logInfo("sms_ingest_rejected", fields);
}

/**
 * Receives bank and mobile money texts forwarded by an iPhone Shortcut.
 * Authenticated by the person's own forwarding secret, not a session.
 */
export async function POST(request: Request): Promise<Response> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "").trim() || request.headers.get("x-alfred-key")?.trim() || "";
  if (!token) {
    logRejected(request, "missing_key");
    return Response.json({ ok: false, text: "Missing forwarding key." }, { status: 401 });
  }

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > LIMITS.maxBodyBytes) {
    logRejected(request, "too_large");
    return Response.json({ ok: false }, { status: 413 });
  }

  let input: z.infer<typeof body>;
  try {
    const raw = await request.text();
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw) as unknown;
    } catch {
      parsedJson = undefined;
    }
    const parsed = body.safeParse(parsedJson === undefined ? { text: raw } : parsedJson);
    if (!parsed.success) {
      logRejected(request, "no_text", raw, parsedJson);
      return Response.json({ ok: false, text: "Send the message text." }, { status: 400 });
    }
    input = parsed.data;
  } catch {
    logRejected(request, "unreadable_body");
    return Response.json({ ok: false, text: "That request could not be read." }, { status: 400 });
  }

  try {
    const settings = getDatabaseSettings();
    const profile = await ownerForToken(settings, token);
    if (!profile) {
      logRejected(request, "invalid_key");
      return Response.json({ ok: false, text: "That forwarding key isn't valid. Copy a fresh one from Alfred's Settings." }, { status: 401 });
    }
    const limiter = new DbRateLimiter(settings, 60, 60_000);
    if (!(await limiter.allow(`ingest:${profile.profileId}`, Date.now()))) {
      return Response.json({ ok: false, text: "Too many messages at once." }, { status: 429 });
    }
    const result = await ingestAndAnnounce(settings, profile, input.text, { channel: "shortcut", sender: input.sender });
    return Response.json({
      ok: true,
      found: result.found,
      duplicates: result.duplicates,
      needsLabel: result.outcomes.filter((item) => item.outcome === "needs_label").length,
    });
  } catch (error) {
    logError("sms_ingest", error);
    return Response.json({ ok: false, text: "Alfred couldn't read that message." }, { status: 500 });
  }
}
