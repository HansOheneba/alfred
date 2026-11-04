import type { SupabaseSettings } from "@/lib/config";
import type { FinancialAccount } from "@/lib/finance/accounting/types";
import { query } from "@/lib/supabase/connection";

export type ImportedTransferProvider = "hubtel" | "momo";
export type ImportedTransferProviders = ReadonlyMap<string, ImportedTransferProvider>;
export type ImportedProviderLookup = { providers: ImportedTransferProviders; status: "none"|"summary"|"legacy-fallback"|"backfill-required"|"incomplete"|"corrupt"|"unavailable"; needsBackfill: boolean };
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
    // Retain an overflow sentinel so callers cannot mistake incomplete identity
    // coverage for the absence of imported provider candidates.
    if(candidates.length>100)return candidates;
  }
  return candidates;
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
 and receipt.archive->>'archiveId'=receipt.archive_id and receipt.after_state->>'ownerId'=$1::text
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

export async function loadImportedTransferProviderResult(settings: SupabaseSettings, ownerId: string, accounts: FinancialAccount[],options:{summaryReady?:boolean}={}):Promise<ImportedProviderLookup> {
  const candidates = importedTransferCandidates(accounts);
  const empty = (status:ImportedProviderLookup["status"],needsBackfill=false):ImportedProviderLookup=>({providers:new Map(),status,needsBackfill});
  if (!candidates.length) return empty("none");
  if(candidates.length>100)return empty("incomplete");
  const requested = candidates.map((row) => ({ account_id: row.accountId, namespace: row.namespace, source_id: row.sourceId, provider: row.provider }));
  const ready = options.summaryReady ?? (await query<{ready:boolean}>(settings,"select to_regprocedure('public.alfred_import_provider_facts(uuid,jsonb)') is not null as ready"))[0]?.ready === true;
  let rows:{account_id:string;provider:string}[], status:ImportedProviderLookup["status"]="legacy-fallback",needsBackfill=true;
  if (ready) {
    const response=await query<{result:{facts?:unknown;status?:string;needsBackfill?:boolean;legacyLimited?:boolean}}>(settings,"select public.alfred_import_provider_facts($1::uuid,$2::jsonb) as result",[ownerId,JSON.stringify(requested)]);
    const result=response[0]?.result;
    if (!result || !Array.isArray(result.facts) || result.facts.length>300) return empty("unavailable");
    if(!["summary","legacy-fallback","backfill-required","incomplete","corrupt","invalid"].includes(result.status??""))return empty("unavailable");
    if(result.status==="corrupt"||result.status==="invalid")return empty("corrupt");
    status=result.status==="backfill-required"?"backfill-required":result.status==="incomplete"?"incomplete":result.status==="legacy-fallback"?"legacy-fallback":"summary";
    needsBackfill=result.needsBackfill===true||result.legacyLimited===true;
    rows=result.facts.filter((row):row is {account_id:string;provider:string}=>object(row)&&typeof row.account_id==="string"&&typeof row.provider==="string");
    if(rows.length!==result.facts.length)return empty("corrupt");
  } else {
    // Old schema compatibility is deliberately bounded. Never silently treat a
    // partial owner archive scan as complete identity evidence.
    const count=await query<{count:number}>(settings,"select count(*)::int as count from (select 1 from public.finance_import_receipts where owner_id=$1::uuid and undone_at is null limit 3) bounded",[ownerId]);
    if((count[0]?.count??3)>2)return empty("backfill-required",true);
    rows=await query<{account_id:string;provider:string}>(settings,IMPORTED_TRANSFER_PROVIDERS_SQL,[ownerId,JSON.stringify(requested)]);
  }
  const facts = new Map<string, ImportedTransferProvider>();
  for (const candidate of candidates) {
    const matching = rows.filter((row) => row.account_id === candidate.accountId);
    if (matching.length && matching.every((row) => row.provider === candidate.provider)) facts.set(candidate.accountId, candidate.provider);
  }
  // A missing/busy/legacy proof must not disappear from a uniqueness check and
  // make another imported account appear to be the owner's only provider account.
  if(facts.size!==new Set(candidates.map(row=>row.accountId)).size)return empty(status==="backfill-required"?status:"incomplete",needsBackfill);
  return {providers:facts,status,needsBackfill};
}

export async function loadImportedTransferProviders(settings: SupabaseSettings, ownerId: string, accounts: FinancialAccount[],options:{summaryReady?:boolean}={}): Promise<ImportedTransferProviders> {
  return (await loadImportedTransferProviderResult(settings,ownerId,accounts,options)).providers;
}
