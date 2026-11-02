import { createHash, randomUUID } from "node:crypto";
import { createArchive, hashValue, readArchive, MAX_ARCHIVE_BYTES as ARCHIVE_LIMIT, type Datasets } from "../../portability/archive.mjs";
import type { SupabaseSettings } from "@/lib/config";
import { loadAccountingState } from "@/lib/finance/accounting/persisted-store";
import { AccountingError } from "@/lib/finance/accounting/types";
import { query } from "@/lib/supabase/connection";
import { PORTABILITY_READY_SQL } from "@/lib/supabase/finance-capabilities";
import { buildAlfredExport } from "./export";
import { parseBrowserPreferences } from "./browser-preferences";
import { moneyNativeSupplement } from "./money-native";
import {collectNativeRestoreSources} from "./native-sources";
import { nativeLoanOverlapConflicts } from "./loan-overlap";
import { planNativeRestoration, type NativeRestoreSource, type NativeSummary } from "./native-restoration";
import { CORE_DOMAINS, planImport, importedAccountIdMap, importedAccountProvenanceMap, type ImportArchive, type ImportCounts } from "./model";
import { accountingCoreFromNative } from "./native-core";

export const MAX_ARCHIVE_BYTES = ARCHIVE_LIMIT;
export const PREVIEW_TTL_MS = 30 * 60 * 1000;
export type ImportReceipt = { id: string; archiveId: string; importedAt: string; counts: ImportCounts; unsupported: string[]; undoAvailable: boolean; undoneAt?: string; native?: NativeSummary; investmentNotificationsPaused?: boolean; activationOf?:string|null; activationKey?:string|null; originalArchiveId?:string; isActivation?:boolean };
export class PortabilityUnavailable extends Error {}

export async function requirePortability(settings: SupabaseSettings) {
  const rows = await query<{ ready: boolean }>(settings, PORTABILITY_READY_SQL);
  if (!rows[0]?.ready) throw new PortabilityUnavailable("Data import requires the reviewed portability database migration. No financial records were changed.");
}

export async function exportFinanceArchive(settings: SupabaseSettings, ownerId: string, browserPreferences?: Record<string,unknown>) {
  await requirePortability(settings);
  if(browserPreferences) browserPreferences=parseBrowserPreferences(browserPreferences);
  const exported = await buildAlfredExport(settings, ownerId);
  const native = exported.datasets["alfred.native"];
  const selection = accountingCoreFromNative(native, ownerId, exported.namespace);
  const core = selection.datasets;
  const coverage = [...CORE_DOMAINS.map((dataset) => ({ dataset, status: "supported" as const, count: (core[dataset] as unknown[]).length, reason: "Imported into the accounting core with historical source evidence, stable IDs and links." })), ...selection.coverage, ...exported.coverage];
  return createArchive({ sourceApp: "alfred", namespace: exported.namespace, timezone: exported.timezone, currency: exported.currency, datasets: { ...core, ...exported.datasets, ...(browserPreferences ? {"alfred.browserPreferences":browserPreferences} : {}) } as Datasets, coverage: [...coverage,...(browserPreferences ? [{dataset:"alfred.browserPreferences",status:"supported" as const,reason:"Safe browser preferences are restored by the app only when destination browser values remain at defaults."}] : [{dataset:"alfred.browserPreferences",status:"unavailable" as const,reason:"This export request did not supply readable appearance and privacy values. Browser preferences are not included; finance records and safe profile settings remain covered."}])] });
}

export async function previewFinanceImport(settings: SupabaseSettings, ownerId: string, bytes: Uint8Array, now = new Date()) {
  // Validate the full archive before querying or persisting destination data.
  const archive = await readArchive(bytes) as ImportArchive;
  return prepareFinanceImport(settings,ownerId,archive,now);
}

export const PORTABILITY_ADAPTER_VERSION="finance-native-2026-11-02-v2";
/** Also used to review a retained original archive. No source ID is changed to evade idempotency. */
export async function prepareFinanceImport(settings:SupabaseSettings,ownerId:string,archive:ImportArchive,now=new Date(),activationOf?:string) {
  if(archive.datasets["alfred.browserPreferences"]!==undefined) {try{parseBrowserPreferences(archive.datasets["alfred.browserPreferences"]);}catch{throw new AccountingError("The archive has invalid browser preference settings.");}}
  await requirePortability(settings);
  const current = await loadAccountingState(settings, ownerId);
  if (current.availability !== "ready") throw new PortabilityUnavailable("The accounting migration is required before importing. No financial records were changed.");
  const id = randomUUID(); const at = now.toISOString(); const expiresAt = new Date(now.getTime() + PREVIEW_TTL_MS).toISOString();
  const destinationNamespace = `alfred:${createHash("sha256").update(`alfred:${ownerId}`).digest("hex")}`;
  const plan = planImport(current.state, archive, id, at, destinationNamespace);
  const versionBefore = await query<{version:string}>(settings,"select public.alfred_portability_native_version($1::uuid) as version",[ownerId]);
  const destination = await buildAlfredExport(settings,ownerId);
  const versionAfter = await query<{version:string}>(settings,"select public.alfred_portability_native_version($1::uuid) as version",[ownerId]);
  if(!versionBefore[0]?.version || versionBefore[0].version!==versionAfter[0]?.version) throw new AccountingError("Native financial records changed while preparing the preview. Upload the archive again.","stale");
  const sources:NativeRestoreSource[]=collectNativeRestoreSources(archive);
  const moneySource=moneyNativeSupplement(archive);
  if(moneySource) sources.push(moneySource);
  const native=planNativeRestoration(destination.datasets["alfred.native"],sources,destinationNamespace,at,{ownerId,previewId:id,destinationNamespace,accountIdMap:importedAccountIdMap(archive.datasets,archive.manifest.namespace,destinationNamespace),accountProvenanceMap:importedAccountProvenanceMap(archive.datasets,archive.manifest.namespace,destinationNamespace)});
  const conflicts=[...plan.conflicts,...native.summary.conflicts,...nativeLoanOverlapConflicts(archive,sources)];
  const unsupported=[...plan.unsupported.filter((item)=>!item.startsWith("alfred.native:")&&!item.startsWith("alfred.browserPreferences:")&&!(moneySource&&(item.startsWith("moneyTracker.native:")||item.startsWith("moneyTracker.portfolios:")))),...native.summary.coverage.filter((item)=>item.status==="preserved").map((item)=>`${item.dataset}: ${item.reason}`)];
  const canConfirm=conflicts.length===0;
  const newRecords=Object.values(plan.additions).reduce((sum,value)=>sum+value,0)+Object.values(native.summary.additions).reduce((sum,value)=>sum+value,0)+Object.keys(native.plan.profileChanges).length+Object.keys(native.plan.reminderChanges).length;
  const activationStatus=activationOf ? !canConfirm ? "blocked" as const : newRecords===0 ? "nothing_new" as const : "ready" as const : "ready" as const;
  const currentIds=Object.fromEntries(CORE_DOMAINS.map((domain)=>[domain,new Set(current.state[domain].map((row)=>row.id))]));
  const accountingAdditions=Object.fromEntries(CORE_DOMAINS.map((domain)=>[domain,plan.next[domain].filter((row)=>!currentIds[domain].has(row.id))]));
  const activationKey=activationOf ? await hashValue({sourceReceiptId:activationOf,adapterVersion:PORTABILITY_ADAPTER_VERSION,accountingAdditions,nativePlan:JSON.parse(JSON.stringify({...native.plan,accountRules:native.plan.accountRules?{state:native.plan.accountRules.state}:undefined}))}) : null;
  const summary={...plan.summary,conflicts,unsupported,canConfirm,native:native.summary,...(activationOf?{activationOf,adapterVersion:PORTABILITY_ADAPTER_VERSION}:{})};
  if(activationStatus==="ready") try { await query(settings, `insert into public.finance_import_previews(owner_id,id,archive_id,source_version,expected_revision,base_hash,before_state,next_state,sources,archive,summary,expires_at,native_version,native_plan,activation_of,activation_key)
    values($1::uuid,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14::jsonb,$15,$16)`,
    [ownerId,id,archive.archiveId,current.sourceVersion,current.state.revision,await hashValue(current.state),JSON.stringify(current.state),JSON.stringify(plan.next),JSON.stringify(plan.sources),JSON.stringify(archive),JSON.stringify(summary),expiresAt,versionAfter[0].version,JSON.stringify(native.plan),activationOf ?? null,activationKey]); } catch(error) {
    if(error instanceof Error && error.message.includes("Too many pending import previews")) throw new AccountingError("You already have five pending import previews. Confirm an existing preview or wait for one to expire before uploading another archive.","conflict");
    throw error;
  }
  return { id, archiveId: archive.archiveId, activationOf:activationOf ?? null,activationStatus,adapterVersion:PORTABILITY_ADAPTER_VERSION,newRecords, sourceApp: archive.manifest.sourceApp, exportedAt: archive.manifest.exportedAt, counts: plan.counts, additions: plan.additions, duplicates: plan.duplicates, conflicts, unsupported, native:native.summary, coverage: [
      ...CORE_DOMAINS.map((dataset) => ({ dataset, status: "supported", count: plan.counts[dataset], reason: "Destination accounting core records are staged for atomic import." })),
      ...archive.manifest.coverage.filter((item) => !(item as {dataset?:string})?.dataset?.startsWith("alfred.native.") && !native.summary.coverage.some((coverage)=>coverage.dataset===(item as {dataset?:string})?.dataset)).filter((item) => !(item && typeof item === "object" && CORE_DOMAINS.includes((item as {dataset:string}).dataset as typeof CORE_DOMAINS[number]))).map((item) => {
        const entry = item as {dataset:string;status:string;reason:string;count?:number};
        return entry.dataset==="alfred.browserPreferences" ? {...entry,status:"supported",reason:"Safe presentation preferences are restored separately on this device after finance confirmation, subject to default-value checks."} : ["excluded", "unavailable"].includes(entry.status) ? entry : { ...entry, status: "preserved", reason: "Complete source evidence is preserved in Alfred receipts and exports. Equivalent destination features and source-specific gaps are listed separately in this coverage report." };
      }),
      ...native.summary.coverage,
      ...(archive.datasets["alfred.browserPreferences"]!==undefined&&!archive.manifest.coverage.some((item)=>(item as {dataset?:string})?.dataset==="alfred.browserPreferences")?[{dataset:"alfred.browserPreferences",status:"supported",reason:"Safe presentation preferences are restored separately on this device after finance confirmation, subject to default-value checks."}]:[]),
      ...Object.keys(archive.datasets).filter((dataset) => dataset!=="alfred.native" && dataset!=="alfred.browserPreferences").filter((dataset) => !CORE_DOMAINS.includes(dataset as typeof CORE_DOMAINS[number]) && !archive.manifest.coverage.some((item) => (item as {dataset?:string})?.dataset === dataset)).map((dataset) => ({ dataset, status: "preserved", reason: "Preserved as source evidence; no native destination records or settings are created." })),
    ], canConfirm, expiresAt,
    warnings: ["Historical imports do not configure future SMS collection or enable reminders.", "Existing records and non-default destination settings are never overwritten.", ...native.warnings] };
}

function rpcFailure(status: string): never {
  if (status === "expired") throw new AccountingError("This preview expired. Upload the archive again.", "stale");
  if(status==="missing_source") throw new AccountingError("That saved source receipt does not belong to this signed-in profile.","not_found");
  if(status==="source_undone") throw new AccountingError("This source import was undone. Its saved data can still be reviewed or downloaded; it cannot activate records while undone.","conflict");
  if(status==="activation_active") throw new AccountingError("Undo the active records activated from this source before undoing the source import.","conflict");
  if (status === "missing") throw new AccountingError("That preview or receipt does not belong to this signed-in profile.", "not_found");
  if (status === "stale" || status === "source_changed" || status === "native_changed") throw new AccountingError("Financial records changed after this preview or import. Refresh and preview again; undo will never discard later edits.", "stale");
  throw new AccountingError("The import conflicts with destination records. Nothing was overwritten.", "conflict");
}
export async function confirmFinanceImport(settings: SupabaseSettings, ownerId: string, previewId: string) {
  await requirePortability(settings);
  const rows = await query<{ result: { status: string; receipt?: ImportReceipt } }>(settings, "select public.alfred_confirm_finance_import($1::uuid,$2) as result", [ownerId,previewId]);
  const result = rows[0]?.result;
  if (!result?.receipt || !["saved","duplicate"].includes(result.status)) rpcFailure(result?.status ?? "conflict");
  return result!.receipt!;
}
export async function undoFinanceImport(settings: SupabaseSettings, ownerId: string, receiptId: string) {
  await requirePortability(settings);
  const rows = await query<{ result: { status: string; receipt?: ImportReceipt } }>(settings, "select public.alfred_undo_finance_import($1::uuid,$2) as result", [ownerId,receiptId]);
  const result = rows[0]?.result;
  if (!result?.receipt || !["saved","duplicate"].includes(result.status)) rpcFailure(result?.status ?? "conflict");
  return result!.receipt!;
}
export async function listFinanceImportReceipts(settings: SupabaseSettings, ownerId: string) {
  await requirePortability(settings);
  const rows = await query<{ receipt: ImportReceipt }>(settings, "select public.alfred_finance_import_receipt(r) as receipt from public.finance_import_receipts r where owner_id=$1::uuid order by imported_at desc limit 20", [ownerId]);
  return rows.map((row) => row.receipt);
}

export async function resumeImportInvestmentNotifications(settings:SupabaseSettings,ownerId:string,receiptId:string) {
  await requirePortability(settings);
  const rows=await query<{result:{status:string;resumed?:number}}>(settings,"select public.alfred_resume_import_investment_notifications($1::uuid,$2) as result",[ownerId,receiptId]);
  const result=rows[0]?.result;
  if(result?.status!=="saved") rpcFailure(result?.status==="undone" ? "conflict" : result?.status ?? "conflict");
  return {resumed:result!.resumed ?? 0};
}
