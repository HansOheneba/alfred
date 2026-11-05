import type { SupabaseSettings } from "../../config";
import { AccountingError } from "./types";
import type { AccountingResult } from "./persisted-store";

type Stamp = { revision: number; sourceVersion: string };
type Limits = { ttlMs: number; maxEntries: number; maxBytes: number; maxEntryBytes: number };
const LIMITS: Limits = { ttlMs: 60_000, maxEntries: 8, maxBytes: 32 * 1024 * 1024, maxEntryBytes: 8 * 1024 * 1024 };
export const DISPLAY_STAMP_SQL = `select
  coalesce((select revision from public.accounting_states where owner_id=$1::uuid),0)::text as revision,
  public.alfred_accounting_source_version($1::uuid) as source_version`;

/** Display-only reuse. TTL bounds memory; a fresh database stamp controls every hit. */
export function createAccountingDisplayCache(limits: Limits = LIMITS) {
  type Entry = { result: AccountingResult; stamp: Stamp; bytes: number; expiresAt: number };
  const entries = new Map<string, Entry>();
  let bytes = 0;
  const remove = (key: string) => {
    const entry = entries.get(key);
    if (entry) { bytes -= entry.bytes; entries.delete(key); }
  };
  return {
    clear() { entries.clear(); bytes = 0; },
    async read(settings: SupabaseSettings, ownerId: string, load: () => Promise<AccountingResult>): Promise<AccountingResult> {
      for (const [key, entry] of entries) if (entry.expiresAt <= Date.now()) remove(key);
      const key = JSON.stringify(["accounting-display-v1", settings.host, settings.projectRef, settings.user, settings.database, ownerId]);
      const cached = entries.get(key);
      if (cached) {
        try {
          const { query } = await import("../../supabase/connection");
          // Both tokens are observed in one statement snapshot. Revision alone
          // misses source/rule/import edits; a TTL alone cannot prove freshness.
          const [row] = await query<{ revision: string; source_version: string }>(settings, DISPLAY_STAMP_SQL, [ownerId]);
          if (row && Number(row.revision) === cached.stamp.revision && row.source_version === cached.stamp.sourceVersion) {
            if (entries.get(key) === cached) { entries.delete(key); entries.set(key, cached); }
            return structuredClone(cached.result);
          }
        } catch (error) {
          if (entries.get(key) === cached) remove(key);
          throw error; // An unavailable database must never produce stale cash or totals.
        }
        if (entries.get(key) === cached) remove(key);
      }
      // The existing full coherent source read remains the cold/mismatched path.
      // Mutations, Undo and exports never use this cache. No in-flight promise is
      // retained: a stalled old read must not trap later requests behind it.
      const result = await load();
      if (result.state.ownerId !== ownerId) throw new AccountingError("Financial state belongs to another owner.", "ownership");
      if (result.availability !== "ready" || result.sourceVersion === null) return result;
      const size = Buffer.byteLength(JSON.stringify(result));
      if (limits.maxEntries > 0 && !entries.has(key) && size <= limits.maxEntryBytes && size <= limits.maxBytes) {
        while (entries.size >= limits.maxEntries || bytes + size > limits.maxBytes) {
          const oldest = entries.keys().next().value;
          if (oldest === undefined) break;
          remove(oldest);
        }
        entries.set(key, { result: structuredClone(result), stamp: { revision: result.state.revision, sourceVersion: result.sourceVersion }, bytes: size, expiresAt: Date.now() + limits.ttlMs });
        bytes += size;
      }
      return result;
    },
  };
}

const displayCache = createAccountingDisplayCache();
export const readAccountingDisplayCached = displayCache.read;
export const resetAccountingDisplayCache = displayCache.clear;
