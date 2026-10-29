import { ingestAndAnnounce, ownerForToken } from "@/lib/bank/service";
import { LIMITS } from "@/lib/config";
import { getDatabaseSettings } from "@/lib/env";
import { logError, logInfo } from "@/lib/log";
import { DbRateLimiter } from "@/lib/security/db-rate-limit";
import { query } from "@/lib/supabase/connection";

export const maxDuration = 30;

const MAX_TEXT = 4000;
const TEXT_KEYS = ["text", "content", "message", "body", "msg", "sms"];
const SENDER_KEYS = ["sender", "from", "address"];

type Forwarded = { text: string; sender: string | null; source: "shortcut" | "mac"; receivedAt?: Date; jsonKeys?: string };

/** Finds a field by name, ignoring case, one level into nested objects too (Shortcuts sometimes wraps the message). */
function pick(record: Record<string, unknown>, keys: string[]): string {
  for (const [key, value] of Object.entries(record)) {
    if (keys.includes(key.toLowerCase()) && typeof value === "string" && value.trim()) return value;
  }
  for (const value of Object.values(record)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested = pick(value as Record<string, unknown>, keys);
      if (nested) return nested;
    }
  }
  return "";
}

function receivedAt(value: unknown, now: number): Date | undefined {
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  const time = date.getTime();
  // A relayed text can be a few weeks old after the Mac was off; never in the future.
  return Number.isFinite(time) && time <= now + 5 * 60_000 && time >= now - 45 * 86_400_000 ? date : undefined;
}

/**
 * Reads the message out of whatever the sender managed to send: JSON with
 * any reasonable key, a form, or the raw text itself.
 */
function readForwarded(raw: string, contentType: string): Forwarded {
  const trimmed = raw.trim();
  let record: Record<string, unknown> | null = null;
  if (trimmed.startsWith("{")) {
    try {
      const json = JSON.parse(trimmed) as unknown;
      if (json && typeof json === "object" && !Array.isArray(json)) record = json as Record<string, unknown>;
    } catch {
      record = null;
    }
  } else if (contentType.includes("application/x-www-form-urlencoded")) {
    record = Object.fromEntries(new URLSearchParams(trimmed));
  }
  if (!record) return { text: trimmed.slice(0, MAX_TEXT), sender: null, source: "shortcut" };
  return {
    text: pick(record, TEXT_KEYS).trim().slice(0, MAX_TEXT),
    sender: pick(record, SENDER_KEYS).trim().slice(0, 80) || null,
    source: record.source === "mac" ? "mac" : "shortcut",
    receivedAt: receivedAt(record.receivedAt, Date.now()),
    jsonKeys: Object.keys(record).join(","),
  };
}

/**
 * Records why a forwarded message was refused, without the message itself:
 * content type, byte length and, for JSON bodies, the key names only.
 */
function logRejected(request: Request, reason: string, extra: Record<string, string | number | boolean> = {}): void {
  logInfo("sms_ingest_rejected", {
    reason,
    contentType: request.headers.get("content-type") ?? "",
    declaredLength: request.headers.get("content-length") ?? "",
    userAgent: request.headers.get("user-agent") ?? "",
    ...extra,
  });
}

/**
 * Receives bank and mobile money texts forwarded by an iPhone Shortcut or the
 * Mac relay. Authenticated by the person's own forwarding secret, not a session.
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

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    logRejected(request, "unreadable_body");
    return Response.json({ ok: false, text: "That request could not be read." }, { status: 400 });
  }
  const input = readForwarded(raw, request.headers.get("content-type") ?? "");

  try {
    const settings = getDatabaseSettings();
    const profile = await ownerForToken(settings, token);
    if (!profile) {
      logRejected(request, "invalid_key");
      return Response.json({ ok: false, text: "That forwarding key isn't valid. Copy a fresh one from Alfred's Settings." }, { status: 401 });
    }
    if (!input.text) {
      // The automation ran but iOS gave it nothing. Remember when, so Settings can say so.
      logRejected(request, "no_text", { bodyBytes: new TextEncoder().encode(raw).length, blankBody: raw.trim().length === 0, ...(input.jsonKeys ? { jsonKeys: input.jsonKeys } : {}) });
      await query(settings, "update public.ingest_tokens set last_empty_at = now() where owner_id = $1::uuid", [profile.profileId]);
      return Response.json({ ok: false, text: "The message arrived empty." }, { status: 400 });
    }
    const limiter = new DbRateLimiter(settings, 60, 60_000);
    if (!(await limiter.allow(`ingest:${profile.profileId}`, Date.now()))) {
      return Response.json({ ok: false, text: "Too many messages at once." }, { status: 429 });
    }
    const result = await ingestAndAnnounce(settings, profile, input.text, { channel: input.source, sender: input.sender, receivedAt: input.receivedAt });
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
