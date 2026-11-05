import { z } from "zod";
import type { SupabaseSettings } from "@/lib/config";
import { query } from "@/lib/supabase/connection";
import { DatabaseError } from "@/lib/errors";
import { ACCOUNTING_DISPLAY_DEFINITION, ACCOUNTING_DISPLAY_VERSION, type AccountingDisplayManifest } from "./display-model";

export class DurableDisplayUpdating extends Error {
  readonly status = 202;
  constructor() { super("Alfred is updating your financial view. Please try again shortly."); this.name = "DurableDisplayUpdating"; }
}
export function durableDisplayEnabled(): boolean { return process.env.ALFRED_DURABLE_DISPLAY === "true"; }
export async function durableDisplaySchemaReady(settings: SupabaseSettings): Promise<boolean> {
  if (!durableDisplayEnabled()) return false;
  const [row] = await query<{ ready: boolean }>(settings, "select to_regclass('alfred_display.rows') is not null and to_regprocedure('alfred_display.manifest(uuid,text)') is not null and to_regprocedure('alfred_display.enqueue(uuid,text)') is not null as ready");
  return row?.ready === true;
}

/** Every resource query embeds this gate so facts and freshness use one database statement snapshot. */
export const DURABLE_FRESH_CTE = "fresh as materialized (select alfred_display.manifest($1::uuid,$2::text) as publication)";
export type DurableBundle<T> = { token: string; manifest: AccountingDisplayManifest; data: T };
const envelope = z.object({ token: z.string().regex(/^\d+$/), manifest: z.object({ kind: z.literal("accounting-display"), projectorVersion: z.literal(ACCOUNTING_DISPLAY_VERSION), ownerId: z.string(), revision: z.number().int().nonnegative().safe(), sourceVersion: z.string().nullable() }).passthrough(), data: z.unknown() });
function safeNumbers(value:unknown):void {
  if(typeof value==='number'&&!Number.isSafeInteger(value))throw new Error('The financial display exceeds safe integer precision.');
  if(Array.isArray(value))for(const child of value)safeNumbers(child);
  else if(value&&typeof value==='object')for(const child of Object.values(value))safeNumbers(child);
}

/** A dirty/missing generation is never interpreted as an empty ledger or a zero balance. */
export async function readDurableBundle<T>(settings: SupabaseSettings, ownerId: string, sql: string, values: unknown[] = []): Promise<DurableBundle<T>> {
  const parameters=[ownerId,ACCOUNTING_DISPLAY_DEFINITION,...values];
  let [row] = await query<{ bundle: unknown }>(settings, sql, parameters);
  if (!row?.bundle) {
    await query(settings, "select alfred_display.enqueue($1::uuid,$2::text)", [ownerId, ACCOUNTING_DISPLAY_DEFINITION]);
    const { ensureFreshDisplay }=await import('./display-worker');
    await ensureFreshDisplay(settings,ownerId);
    [row]=await query<{bundle:unknown}>(settings,sql,parameters);
    if(!row?.bundle)throw new DurableDisplayUpdating();
  }
  const result = envelope.safeParse(row.bundle);
  if (!result.success || result.data.manifest.ownerId !== ownerId) throw new Error("The financial display could not be verified.");
  safeNumbers(result.data);
  return result.data as DurableBundle<T>;
}

/** No readiness preflight on a fresh read. Only an actually absent additive schema enables legacy fallback. */
export async function tryReadDurableBundle<T>(settings: SupabaseSettings, ownerId: string, sql: string, values: unknown[] = []): Promise<DurableBundle<T> | null> {
  if (!durableDisplayEnabled()) return null;
  try { return await readDurableBundle<T>(settings, ownerId, sql, values); }
  catch (error) {
    if (error instanceof DatabaseError && ["3F000", "42883", "42P01"].includes(error.sqlState ?? "") && !await durableDisplaySchemaReady(settings)) return null;
    throw error;
  }
}
