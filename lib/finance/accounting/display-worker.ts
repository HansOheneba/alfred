import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SupabaseSettings } from "@/lib/config";
import { query } from "@/lib/supabase/connection";
import { loadAccountingProjectionSource, type AccountingResult } from "./persisted-store";
import { buildAccountingDisplayModel } from "./display-builder";
import { ACCOUNTING_DISPLAY_DEFINITION, ACCOUNTING_DISPLAY_LIMITS, type AccountingDisplayModel, type DurableModelRow } from "./display-model";

export const DISPLAY_LEASE_SECONDS = 120;
export const DISPLAY_WORKER_BUDGET_MS = 50_000;
export function displayWorkerEnabled(): boolean { return process.env.ALFRED_DURABLE_WORKER_ENABLED === "true"; }

type Execute = <T extends Record<string, unknown>>(settings: SupabaseSettings, sql: string, values?: unknown[]) => Promise<T[]>;
export type DisplayWorkerDependencies = {
  execute: Execute;
  load: typeof loadAccountingProjectionSource;
  build: (result: AccountingResult) => AccountingDisplayModel;
  leaseToken: () => string;
  now: () => number;
};
const defaults: DisplayWorkerDependencies = { execute: query, load: loadAccountingProjectionSource, build: buildAccountingDisplayModel, leaseToken: randomUUID, now: Date.now };
const claimSchema = z.object({ ownerId: z.uuid(), definition: z.literal(ACCOUNTING_DISPLAY_DEFINITION), leaseToken: z.uuid() });
const baselineSchema = z.object({ token: z.string().regex(/^\d+$/), publishRevision: z.string().regex(/^\d+$/), epoch: z.string().regex(/^\d+$/), events: z.array(z.string().regex(/^\d+$/)) });
export type DisplayWorkerReport = { claimed: number; published: number; stale: number; failed: number; idle: boolean };
const statusSchema = z.object({ ready: z.boolean(), dirtyOwners: z.number().int().nonnegative().safe(), queuedOwners: z.number().int().nonnegative().safe(), leasedOwners: z.number().int().nonnegative().safe(), failedOwners: z.number().int().nonnegative().safe(), modelOwners: z.number().int().nonnegative().safe(), oldestDirtyAt: z.string().nullable(), lastWorkerAt: z.string().nullable(), lastPublishedAt: z.string().nullable(), lastFailedAt: z.string().nullable() });
export async function readDisplayWorkerStatus(settings: SupabaseSettings) {
  const [row] = await query<{ result: unknown }>(settings, "select alfred_display.status() as result");
  return statusSchema.parse(row?.result);
}

/** Storage rows are display facts only. No reducer or financial writer consumes them. */
export function displayRowsForPublication(rows: DurableModelRow[]) {
  return rows.map(row => ({ id: row.id, kind: row.kind, ordinal: row.ordinal, account_id: row.accountId ?? null,
    date: row.date ?? null, currency: row.currency ?? null, category: row.category ?? null, direction: row.direction ?? null,
    status: row.status ?? null, amount_minor: row.amountMinor ?? null, search_text: row.searchText,
    rank_date_asc: row.rankDateAsc ?? null, rank_date_desc: row.rankDateDesc ?? null,
    rank_amount_asc: row.rankAmountAsc ?? null, rank_amount_desc: row.rankAmountDesc ?? null,
    needs_attention: row.needsAttention ?? false, group_key: row.groupKey ?? null, relation_id: row.relationId ?? null, payload: row.payload }));
}

/** No detached work: a durable lease survives process death, and the database fences every publication. */
export async function runDisplayWorker(settings: SupabaseSettings, options: { maxOwners?: number; budgetMs?: number; ownerId?: string } = {}, overrides: Partial<DisplayWorkerDependencies> = {}): Promise<DisplayWorkerReport> {
  const deps = { ...defaults, ...overrides }, maxOwners = options.maxOwners ?? 1, budgetMs = options.budgetMs ?? DISPLAY_WORKER_BUDGET_MS;
  if (!Number.isInteger(maxOwners) || maxOwners < 1 || maxOwners > 10 || !Number.isFinite(budgetMs) || budgetMs <= 0 || budgetMs > DISPLAY_WORKER_BUDGET_MS) throw new Error("Invalid display worker limits.");
  if (options.ownerId !== undefined && !z.uuid().safeParse(options.ownerId).success) throw new Error("Invalid display owner.");
  const [ready] = await deps.execute<{ ready: boolean }>(settings, "select alfred_display.readiness() as ready");
  if (ready?.ready !== true) throw new Error("The durable display schema is not ready.");
  const report: DisplayWorkerReport = { claimed: 0, published: 0, stale: 0, failed: 0, idle: false };
  const started = deps.now();
  for (let index = 0; index < maxOwners && deps.now() - started < budgetMs; index += 1) {
    const requestedToken = deps.leaseToken();
    const [claimed] = options.ownerId
      ? await deps.execute<{ result: unknown }>(settings, "select alfred_display.claim_owner($1::uuid,$2::text,$3::uuid,$4::integer) as result", [options.ownerId, ACCOUNTING_DISPLAY_DEFINITION, requestedToken, DISPLAY_LEASE_SECONDS])
      : await deps.execute<{ result: unknown }>(settings, "select alfred_display.claim($1::text,$2::uuid,$3::integer) as result", [ACCOUNTING_DISPLAY_DEFINITION, requestedToken, DISPLAY_LEASE_SECONDS]);
    if (!claimed?.result) { report.idle = report.claimed === 0; break; }
    const job = claimSchema.parse(claimed.result);
    if (job.leaseToken !== requestedToken || (options.ownerId !== undefined && job.ownerId !== options.ownerId)) throw new Error("The display worker lease could not be verified.");
    report.claimed += 1;
    const fail = async (code: "changed" | "build_failed" | "publication_failed") => {
      // Error text can contain financial details; only bounded generic codes are stored.
      try { await deps.execute(settings, "select alfred_display.fail($1::uuid,$2::uuid,$3::text) as result", [job.ownerId, job.leaseToken, code]); } catch { /* The lease expires if the database cannot record this attempt. */ }
    };
    let phase: "build_failed" | "publication_failed" = "build_failed";
    try {
      const [captured] = await deps.execute<{ result: unknown }>(settings, "select alfred_display.capture($1::uuid,$2::text,$3::uuid) as result", [job.ownerId, job.definition, job.leaseToken]);
      if (!captured?.result) { report.stale += 1; await fail("changed"); continue; }
      const baseline = baselineSchema.parse(captured.result);
      // This await must finish after capture. Parallel capture/loading can consume
      // invalidation evidence for source versions the canonical builder never read.
      const source = await deps.load(settings, job.ownerId);
      if (source.availability !== "ready" || source.sourceVersion === null || source.state.ownerId !== job.ownerId) throw new Error("The canonical source could not be verified.");
      const model = deps.build(source);
      if (model.definition !== job.definition || model.manifest.ownerId !== job.ownerId || model.manifest.revision !== source.state.revision || model.manifest.sourceVersion !== source.sourceVersion) throw new Error("The display publication did not match its canonical source.");
      if (deps.now() - started >= budgetMs) { report.stale += 1; await fail("changed"); continue; }
      const rows = displayRowsForPublication(model.rows), manifest = JSON.stringify(model.manifest), payload = JSON.stringify(rows);
      // Wire names change the byte count; validate the actual SQL payload too.
      if (Buffer.byteLength(manifest) + Buffer.byteLength(payload) > ACCOUNTING_DISPLAY_LIMITS.maxBytes) throw new Error("The complete display publication exceeds its size limit.");
      phase = "publication_failed";
      const [published] = await deps.execute<{ result: { status?: string } | null }>(settings,
        "select alfred_display.publish($1::uuid,$2::text,$3::uuid,$4::jsonb,$5::jsonb,$6::jsonb) as result",
        [job.ownerId, job.definition, job.leaseToken, JSON.stringify(baseline), manifest, payload]);
      if (published?.result?.status === "saved") report.published += 1;
      else if (["stale", "lease_lost", "changed"].includes(published?.result?.status ?? "")) { report.stale += 1; await fail("changed"); }
      else throw new Error("The database did not confirm display publication.");
    } catch {
      report.failed += 1;
      // A failed/ambiguous display publication is not retried here. The token and
      // lease guards make later scheduler recovery safe without financial replay.
      await fail(phase);
    }
  }
  return report;
}

type FreshDependencies = { run: typeof runDisplayWorker; execute: Execute; now: () => number; pause: () => Promise<void> };
/** A miss can rebuild once under a durable owner lease. A busy lease is awaited briefly; no stale model is returned. */
export async function ensureFreshDisplay(settings: SupabaseSettings, ownerId: string, overrides: Partial<FreshDependencies> = {}): Promise<boolean> {
  if (!z.uuid().safeParse(ownerId).success) throw new Error("Invalid display owner.");
  const deps: FreshDependencies = { run: runDisplayWorker, execute: query, now: Date.now, pause: () => new Promise(resolve => setTimeout(resolve, 250)), ...overrides };
  const started = deps.now();
  const result = await deps.run(settings, { ownerId, maxOwners: 1, budgetMs: 15_000 });
  if (result.published > 0) return true;
  if (result.failed > 0) return false;
  // Another worker may already hold this owner's lease. Every poll checks only
  // the cheap event/manifest gate, never complete sources or cached old totals.
  for (let attempt = 0; attempt < 20 && deps.now() - started < 5_000; attempt += 1) {
    const [row] = await deps.execute<{ result: unknown }>(settings, "select alfred_display.manifest($1::uuid,$2::text) as result", [ownerId, ACCOUNTING_DISPLAY_DEFINITION]);
    if (row?.result) return true;
    await deps.pause();
  }
  return false;
}
