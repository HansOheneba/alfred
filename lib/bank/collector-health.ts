import { z } from "zod";
import { hashIngestToken } from "@/lib/bank/store";
import type { SupabaseSettings } from "@/lib/config";
import { query } from "@/lib/supabase/connection";

const uuid = z.uuid().transform(value => value.toLowerCase());
const count = z.number().int().min(0).max(1_000_000);
const timestamp = z.string().max(40).refine(value => {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,3}))?Z$/.exec(value);
  return !!match && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z`;
}, "Invalid collector timestamp.").nullable();
export const collectorHealthSchema = z.object({
  version: z.literal(1),
  deviceId: uuid,
  state: z.enum(["ready", "needs_review", "capture_error"]),
  counts: z.object({ sourceQuarantine: count, unreadable: count, incomplete: count, heldForReview: count, pending: count }).strict(),
  lastSuccessfulCaptureAt: timestamp,
  lastAcceptedAt: timestamp,
}).strict().superRefine((value, context) => {
  if (value.counts.unreadable + value.counts.incomplete > value.counts.sourceQuarantine || value.counts.heldForReview > value.counts.pending) {
    context.addIssue({ code: "custom", message: "Inconsistent collector counts." });
  }
  if (value.state === "ready" && Object.values(value.counts).some(value => value > 0)) context.addIssue({ code: "custom", message: "Collector issues must stay visible." });
  if (value.state === "ready" && value.lastSuccessfulCaptureAt === null) context.addIssue({ code: "custom", message: "A capture must complete before reporting ready." });
});
export type CollectorHealthReport = z.infer<typeof collectorHealthSchema>;
export type CollectorHealthDevice = Omit<CollectorHealthReport, "version"> & { lastSeenAt: string };
export type CollectorHealthWrite = "stored" | "too_soon" | "device_limit";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolves the key without making a false SMS delivery/last-used check-in. */
export async function collectorHealthOwner(settings: SupabaseSettings, token: string): Promise<string | null> {
  if (!/^alf_[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const rows = await query<{ owner_id: string }>(settings, "select owner_id::text from public.ingest_tokens where token_hash=$1", [hashIngestToken(token)]);
  return rows.length === 1 && UUID.test(rows[0].owner_id) ? rows[0].owner_id.toLowerCase() : null;
}

export function parseCollectorHealth(value: unknown, now = Date.now()): CollectorHealthReport {
  const report = collectorHealthSchema.parse(value);
  for (const value of [report.lastSuccessfulCaptureAt, report.lastAcceptedAt]) {
    if (value && Date.parse(value) > now + 5 * 60_000) throw Error("Collector time is ahead of the server.");
  }
  return report;
}

export async function recordCollectorHealth(settings: SupabaseSettings, ownerId: string, report: CollectorHealthReport): Promise<CollectorHealthWrite> {
  const result = await query<{ result: CollectorHealthWrite }>(settings,
    "select public.alfred_record_collector_health($1::uuid,$2::uuid,$3,$4::integer,$5::integer,$6::integer,$7::integer,$8::integer,$9::timestamptz,$10::timestamptz) as result",
    [ownerId, report.deviceId, report.state, report.counts.sourceQuarantine, report.counts.unreadable, report.counts.incomplete, report.counts.heldForReview, report.counts.pending, report.lastSuccessfulCaptureAt, report.lastAcceptedAt]);
  if (!result[0] || !["stored", "too_soon", "device_limit"].includes(result[0].result)) throw Error("Collector status storage is unavailable.");
  return result[0].result;
}

type HealthRow = { device_id: string; state: CollectorHealthReport["state"]; source_quarantine_count: number; unreadable_count: number; incomplete_count: number; held_for_review_count: number; pending_count: number; last_seen_at: Date | string; last_successful_capture_at: Date | string | null; last_accepted_at: Date | string | null };
function date(value: Date | string | null): string | null { return value === null ? null : new Date(value).toISOString(); }
export async function loadCollectorHealth(settings: SupabaseSettings, ownerId: string): Promise<CollectorHealthDevice[]> {
  const rows = await query<HealthRow>(settings, `select device_id::text,state,source_quarantine_count,unreadable_count,incomplete_count,held_for_review_count,pending_count,last_seen_at,last_successful_capture_at,last_accepted_at
    from public.collector_health where owner_id=$1::uuid order by created_at,device_id limit 5`, [ownerId]);
  return rows.map(row => {
    const report = parseCollectorHealth({ version: 1, deviceId: row.device_id, state: row.state, counts: { sourceQuarantine: row.source_quarantine_count, unreadable: row.unreadable_count, incomplete: row.incomplete_count, heldForReview: row.held_for_review_count, pending: row.pending_count }, lastSuccessfulCaptureAt: date(row.last_successful_capture_at), lastAcceptedAt: date(row.last_accepted_at) });
    return { deviceId: report.deviceId, state: report.state, counts: report.counts, lastSeenAt: date(row.last_seen_at)!, lastSuccessfulCaptureAt: report.lastSuccessfulCaptureAt, lastAcceptedAt: report.lastAcceptedAt };
  });
}

/** Deliberately separate from SMS ingestion: only a small, strict status object. */
export async function readCollectorHealthBody(request: Request): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) throw Error("Invalid collector status request.");
  if (Number(request.headers.get("content-length") ?? 0) > 4096) throw Error("Collector status request is too large.");
  const reader = request.body?.getReader();
  if (!reader) throw Error("Collector status request is required.");
  const pieces: Uint8Array[] = []; let size = 0; let chunks = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(Error("Collector status request timed out.")); void reader.cancel().catch(() => {}); }, 5_000); });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      chunks += 1;
      if (chunks > 4096) { void reader.cancel().catch(() => {}); throw Error("Collector status request has too many chunks."); }
      size += value.byteLength;
      if (size > 4096) { void reader.cancel().catch(() => {}); throw Error("Collector status request is too large."); }
      pieces.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const piece of pieces) { bytes.set(piece, offset); offset += piece.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally { clearTimeout(timer); reader.releaseLock(); }
}
