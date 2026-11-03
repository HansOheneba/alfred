import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { SupabaseSettings } from "@/lib/config";
import { logInfo } from "@/lib/log";
import { DbRateLimiter } from "@/lib/security/db-rate-limit";

const WINDOW_MS = 60_000;
const REQUEST_LIMIT = 1_200;
const CLIENT_LIMIT = 120;
const KEY_LIMIT = 60;

/** Fixed hash slots bound database growth even when callers rotate fake keys or
 * forwarding headers. Collisions can only reject earlier, never relax a limit.
 * An IP header is an advisory abuse signal, never an authenticated identity. */
function clientSlot(request: Request): string {
  const forwarded = request.headers.get("x-vercel-forwarded-for") ?? request.headers.get("x-forwarded-for") ?? "";
  if (forwarded.length > 256) return "unknown";
  const candidate = forwarded.split(",", 1)[0].trim();
  if (!isIP(candidate)) return "unknown";
  return createHash("sha256").update(candidate.toLowerCase()).digest("hex").slice(0, 2);
}

/** Account checks and health posts share the budgets, preventing endpoint
 * rotation from doubling a key's allowance. No raw key or IP enters storage.
 * Maximum new buckets: one global, 257 client slots, and 4096 key slots. */
export async function collectorRequestAllowed(
  settings: SupabaseSettings,
  request: Request,
  token: string | null,
  now = Date.now(),
): Promise<boolean> {
  if (!await new DbRateLimiter(settings, REQUEST_LIMIT, WINDOW_MS).allow("collector:requests", now)) return false;
  if (!await new DbRateLimiter(settings, CLIENT_LIMIT, WINDOW_MS).allow(`collector:client:${clientSlot(request)}`, now)) return false;
  if (!token || !/^alf_[A-Za-z0-9_-]{20,64}$/i.test(token)) return true;
  const keySlot = createHash("sha256").update(token).digest("hex").slice(0, 3);
  return new DbRateLimiter(settings, KEY_LIMIT, WINDOW_MS).allow(`collector:key:${keySlot}`, now);
}

type CollectorRejection = "invalid_request" | "invalid_origin" | "missing_or_malformed_key" | "invalid_key" | "owner_unconfirmed" | "owner_changed" | "invalid_report" | "rate_limited" | "too_soon" | "device_limit" | "unavailable";
export function logCollectorRejection(endpoint: "account" | "health", reason: CollectorRejection): void {
  // Deliberately accept no request, identity, credential or exception fields.
  logInfo("collector_request_rejected", { endpoint, reason });
}
