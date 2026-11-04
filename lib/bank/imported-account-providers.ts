import type { SupabaseSettings } from "@/lib/config";
import type { FinancialAccount } from "@/lib/finance/accounting/types";
import { query } from "@/lib/supabase/connection";

export type ImportedTransferProvider = "hubtel" | "momo";
export type ImportedTransferProviders = ReadonlyMap<string, ImportedTransferProvider>;
type Candidate = { accountId: string; namespace: string; sourceId: string; provider: ImportedTransferProvider };
const PROVIDERS: Record<string, ImportedTransferProvider> = { "hubtel-wallet": "hubtel", "mtn-momo": "momo" };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Labels are intentionally unused. These are candidates for corroboration, not identity facts. */
export function importedTransferCandidates(accounts: FinancialAccount[]): Candidate[] {
  const candidates: Candidate[] = [];
  for (const account of accounts) {
    if (account.provider !== "Imported Money Tracker" || account.currency !== "GHS" || account.includeInCash !== true) continue;
    const origin = (account as FinancialAccount & { importProvenance?: unknown }).importProvenance;
    if (!object(origin) || typeof origin.namespace !== "string" || !origin.namespace || origin.namespace.length > 300 || /[\u0000-\u001f]/.test(origin.namespace) || typeof origin.sourceId !== "string" || !Object.hasOwn(PROVIDERS, origin.sourceId)) continue;
    candidates.push({ accountId: account.id, namespace: origin.namespace, sourceId: origin.sourceId, provider: PROVIDERS[origin.sourceId] });
  }
  return candidates.length <= 100 ? candidates : [];
}

const array = (path: string) => `case when jsonb_typeof(${path})='array' then ${path} else '[]'::jsonb end`;
/** Owner-scoped facts only. Neither archive JSON nor original financial rows leave PostgreSQL.
 * A matching receipt is share-locked during an ingest/chat transaction, so undo cannot revoke
 * this proof between the pair's final validation and its accounting write. */
export const IMPORTED_TRANSFER_PROVIDERS_SQL = `select distinct_proof.account_id, distinct_proof.provider from (
 select wanted.account_id,wanted.provider,receipt.id
 from public.finance_import_receipts receipt
 cross join jsonb_to_recordset($2::jsonb) as wanted(account_id text,namespace text,source_id text,provider text)
 where receipt.owner_id=$1::uuid and receipt.undone_at is null
 and exists(select 1 from jsonb_array_elements(${array("receipt.after_state->'accounts'")}) saved
   where saved->>'id'=wanted.account_id and saved->>'provider'='Imported Money Tracker'
     and saved->>'currency'='GHS' and saved->'includeInCash'='true'::jsonb
     and saved#>>'{importProvenance,namespace}'=wanted.namespace and saved#>>'{importProvenance,sourceId}'=wanted.source_id)
 and exists(
   select 1 from (
     select receipt.archive as document
     union all
     select coalesce(entry->'archive',entry) from jsonb_array_elements(${array("receipt.archive#>'{datasets,preservedArchives}'")}) entry
     union all
     select coalesce(entry->'archive',entry) from jsonb_array_elements(${array("receipt.archive#>'{datasets,alfred.native,retainedArchives}'")}) entry
     union all
     select coalesce(entry->'archive',entry) from jsonb_array_elements(${array("receipt.archive#>'{datasets,moneyTracker.native,retainedArchives}'")}) entry
   ) retained
   where retained.document#>>'{manifest,sourceApp}'='money-tracker'
     and retained.document#>>'{manifest,namespace}'=wanted.namespace
     and retained.document#>>'{manifest,currency}'='GHS'
     and retained.document#>>'{datasets,moneyTracker.native,snapshot,currency}'='GHS'
     and exists(select 1 from jsonb_array_elements(${array("retained.document#>'{datasets,accounts}'")}) core
       where coalesce(core#>>'{importProvenance,namespace}',retained.document#>>'{manifest,namespace}')=wanted.namespace
         and coalesce(core#>>'{importProvenance,sourceId}',core->>'id')=wanted.source_id
         and core->>'provider'='Imported Money Tracker' and core->>'currency'='GHS' and core->'includeInCash'='true'::jsonb)
     and exists(select 1 from jsonb_array_elements(${array("retained.document#>'{datasets,moneyTracker.native,snapshot,accounts}'")}) native
       where native->>'account'=wanted.source_id and native->'cash'='true'::jsonb)
 )
 for share of receipt skip locked
) distinct_proof`;

export async function loadImportedTransferProviders(settings: SupabaseSettings, ownerId: string, accounts: FinancialAccount[]): Promise<ImportedTransferProviders> {
  const candidates = importedTransferCandidates(accounts);
  if (!candidates.length) return new Map();
  const requested = candidates.map((row) => ({ account_id: row.accountId, namespace: row.namespace, source_id: row.sourceId, provider: row.provider }));
  const rows = await query<{ account_id: string; provider: string }>(settings, IMPORTED_TRANSFER_PROVIDERS_SQL, [ownerId, JSON.stringify(requested)]);
  const facts = new Map<string, ImportedTransferProvider>();
  for (const candidate of candidates) {
    const matching = rows.filter((row) => row.account_id === candidate.accountId);
    if (matching.length && matching.every((row) => row.provider === candidate.provider)) facts.set(candidate.accountId, candidate.provider);
  }
  return facts;
}
