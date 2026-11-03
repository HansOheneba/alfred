import { after } from "next/server";

import { announceWhenQuiet, ingestBankMessages, ownerForToken } from "@/lib/bank/service";
import { deliverBankAutomation } from "@/lib/bank/automation";
import { collectorExpectedOwner, createCollectorReceiptStore, readCollectorSubmission, storedCollectorReceipt, type CollectorEnvelope } from "@/lib/bank/collector-receipts";
import { LIMITS } from "@/lib/config";
import { getDatabaseSettings } from "@/lib/env";
import { logError, logInfo } from "@/lib/log";
import { DbRateLimiter } from "@/lib/security/db-rate-limit";
import { query } from "@/lib/supabase/connection";

export const maxDuration = 30;

const MAX_TEXT = 4000;
const MAX_JSON_DEPTH = 8;
const MAX_JSON_FIELDS = 512;
const TEXT_KEYS = ["text", "content", "message", "body", "msg", "sms"];
const SENDER_KEYS = ["sender", "from", "address"];
const LOGGED_KEYS = new Set([...TEXT_KEYS, ...SENDER_KEYS, "source", "receivedat"]);

type Forwarded = { text: string; sender: string | null; source: "shortcut" | "mac"; receivedAt?: Date; jsonKeys?: string };

class ForwardedBodyError extends Error {
  constructor(readonly reason: "too_large" | "complex_body" | "unreadable_body", readonly status: number) {
    super("That request could not be read.");
  }
}

/** The header is only an early rejection hint. Bound the actual bytes before
 * decoding/parsing, and cancel a rejected stream without retaining its content. */
async function readBoundedText(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const pieces: string[] = [];
  let bytes = 0;
  let chunks = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      chunks += 1;
      if (bytes > LIMITS.maxBodyBytes) throw new ForwardedBodyError("too_large", 413);
      // Positive chunks are bounded by bytes; this also bounds empty chunks.
      if (chunks > LIMITS.maxBodyBytes + 1) throw new ForwardedBodyError("complex_body", 400);
      pieces.push(decoder.decode(value, { stream: true }));
    }
    pieces.push(decoder.decode());
    return pieces.join("");
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error instanceof ForwardedBodyError ? error : new ForwardedBodyError("unreadable_body", 400);
  } finally {
    reader.releaseLock();
  }
}

/** Reject pathological wrappers before looking up fields. JSON.parse itself
 * only receives the bounded body; the subsequent traversal has its own budget. */
function requireSimpleJSON(record: Record<string, unknown>): void {
  const pending: { value: object; depth: number }[] = [{ value: record, depth: 0 }];
  let fields = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (depth > MAX_JSON_DEPTH) throw new ForwardedBodyError("complex_body", 400);
    const entries = Object.entries(value);
    fields += entries.length;
    if (fields > MAX_JSON_FIELDS) throw new ForwardedBodyError("complex_body", 400);
    for (const [, child] of entries) {
      if (child && typeof child === "object") pending.push({ value: child, depth: depth + 1 });
    }
  }
}

/** Finds a field by name inside bounded Shortcut wrappers, ignoring case. */
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
  requireSimpleJSON(record);
  return {
    text: pick(record, TEXT_KEYS).trim().slice(0, MAX_TEXT),
    sender: pick(record, SENDER_KEYS).trim().slice(0, 80) || null,
    source: record.source === "mac" ? "mac" : "shortcut",
    receivedAt: receivedAt(record.receivedAt, Date.now()),
    jsonKeys: Object.keys(record).map((key) => key.toLowerCase()).filter((key) => LOGGED_KEYS.has(key)).join(","),
  };
}

/**
 * Records why a forwarded message was refused, without the message itself:
 * known content type, numeric declared length and recognized JSON key names.
 * Arbitrary headers/field names may themselves contain private text.
 */
function logRejected(request: Request, reason: string, extra: Record<string, string | number | boolean> = {}): void {
  logInfo("sms_ingest_rejected", {
    reason,
    contentType: /^(?:application\/(?:json|x-www-form-urlencoded)|text\/plain)(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("content-type") ?? "") ? request.headers.get("content-type")! : "other",
    declaredLength: /^\d{1,10}$/.test(request.headers.get("content-length") ?? "") ? request.headers.get("content-length")! : "",
    ...extra,
  });
}

/**
 * Receives bank and mobile money texts forwarded by an iPhone Shortcut or the
 * Mac relay. Authenticated by the person's own forwarding secret, not a session.
 */
export async function POST(request: Request): Promise<Response> {
  const startedAt = Date.now();
  const header = request.headers.get("authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "").trim() || request.headers.get("x-alfred-key")?.trim() || "";
  if (!token) {
    logRejected(request, "missing_key");
    return Response.json({ ok: false, text: "Missing forwarding key." }, { status: 401 });
  }

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > LIMITS.maxBodyBytes) {
    await request.body?.cancel().catch(() => {});
    logRejected(request, "too_large");
    return Response.json({ ok: false }, { status: 413 });
  }

  let raw: string;
  let input: Forwarded;
  let collector: CollectorEnvelope | null;
  let expectedCollectorOwner: string | null = null;
  try {
    raw = await readBoundedText(request);
    const submission = readCollectorSubmission(raw);
    collector = submission?.envelope ?? null;
    if (submission) {
      // Protocol 2 never runs the legacy alias picker. Apply the same shape
      // bound, then ingest only the exact top-level fields that were hashed.
      requireSimpleJSON(JSON.parse(raw));
      const time = receivedAt(submission.receivedAt, Date.now());
      if (!time) throw new ForwardedBodyError("unreadable_body", 400);
      expectedCollectorOwner = collectorExpectedOwner(request.headers.get("x-alfred-collector-owner"));
      input = { text: submission.text, sender: submission.sender, receivedAt: time, source: "mac" };
    } else input = readForwarded(raw, request.headers.get("content-type") ?? "");
  } catch (error) {
    const failure = error instanceof ForwardedBodyError ? error : new ForwardedBodyError("unreadable_body", 400);
    logRejected(request, failure.reason);
    return Response.json({ ok: false, text: failure.message }, { status: failure.status });
  }

  try {
    const settings = getDatabaseSettings();
    const profile = await ownerForToken(settings, token);
    if (!profile) {
      logRejected(request, "invalid_key");
      return Response.json({ ok: false, text: "That forwarding key isn't valid. Copy a fresh one from Alfred's Settings." }, { status: 401 });
    }
    if (collector && profile.profileId.toLowerCase() !== expectedCollectorOwner) {
      return Response.json({ ok: false, text: "The connected Alfred account changed. Keep this alert pending and reconnect the intended account." }, { status: 409 });
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
    const receipts = collector ? createCollectorReceiptStore(settings) : null;
    const claim = collector && receipts ? await receipts.claim(profile.profileId, collector) : null;
    if (collector && claim?.status === "stored") {
      after(() => deliverBankAutomation(settings, profile, startedAt + 25_000));
      return Response.json({ ok: true, found: 0, duplicates: 0, needsLabel: 0,
        collectorReceipt: storedCollectorReceipt(profile.profileId, collector, claim.receiptId, true) });
    }
    if (claim?.status === "busy" || claim?.status === "conflict") {
      return Response.json({ ok: false, text: claim.status === "busy" ? "That alert is still being processed. Keep it pending." : "That alert's identity changed. Keep it for review." }, { status: 409 });
    }
    let completed = false;
    try {
    const result = await ingestBankMessages(settings, profile, input.text, { channel: input.source, sender: input.sender, receivedAt: input.receivedAt });
    // Includes duplicate retries: delivery recovery is separate from the ledger
    // and must not require a linked Telegram chat or a fresh insertion.
    after(() => deliverBankAutomation(settings, profile, startedAt + 25_000));
    // Texts often arrive in bursts; the summary goes out once they stop.
    if (result.outcomes.length > 0) after(() => announceWhenQuiet(settings, profile).catch((error) => logError("sms_announce", error)));
    let collectorReceipt;
    if (collector && receipts && claim?.status === "acquired") {
      // Every parsed movement needs owned durable evidence. Parser-only counts
      // and intentionally ignored/unrecognized text are not deletion authority.
      const messageIds = result.durableMessageIds ?? [];
      if (result.found < 1 || messageIds.length !== result.found) {
        return Response.json({ ok: true, found: result.found, duplicates: result.duplicates, needsLabel: result.outcomes.filter(item => item.outcome === "needs_label").length,
          collectorReceipt: { version: 2, ...collector, ownerId: profile.profileId, disposition: "pending_review" } }, { status: 202 });
      }
      const receiptId = await receipts.complete(profile.profileId, collector, claim.claimToken, messageIds);
      if (!receiptId) throw new Error("Collector durable receipt could not be confirmed.");
      collectorReceipt = storedCollectorReceipt(profile.profileId, collector, receiptId);
      completed = true;
    }
    return Response.json({
      ok: true,
      found: result.found,
      duplicates: result.duplicates,
      needsLabel: result.outcomes.filter((item) => item.outcome === "needs_label").length,
      ...(collectorReceipt ? { collectorReceipt } : {}),
    });
    } finally {
      if (!completed && collector && receipts && claim?.status === "acquired") {
        await receipts.release(profile.profileId, collector, claim.claimToken).catch(() => {});
      }
    }
  } catch (error) {
    logError("sms_ingest", error);
    return Response.json({ ok: false, text: "Alfred couldn't read that message." }, { status: 500 });
  }
}
