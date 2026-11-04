import type { SupabaseSettings } from "../../config";
import { createSupabaseBankStore, listBankTransferWindow, type BankMessage, type BankTransferWindow } from "../../bank/store";
import { listRawTransactions } from "../../supabase/finance-store";
import { query } from "../../supabase/connection";
import { loadAccountRules } from "../../account-rules/store";
import { applyAccountRules } from "../../account-rules/matcher";
import { loadImportedTransferProviders, type ImportedTransferProviders } from "../../bank/imported-account-providers";
import type { TransactionRecord } from "../types";
import { actionFingerprint, applyAccountingAction } from "./reducer";
import { hydrateAccountingSources, sourceMovements } from "./sources";
import { AccountingError, emptyAccountingState, type AccountingAction, type AccountingState, type CashMovement } from "./types";

export type AccountingResult={state:AccountingState;availability:"ready"|"migration-required";sourceVersion:string|null;rawTransactions:TransactionRecord[];bankMessages?:BankMessage[];transferWindow?:BankTransferWindow;transferProviders?:ImportedTransferProviders};
async function sourceVersion(settings:SupabaseSettings,ownerId:string) {
  const rows=await query<{version:string}>(settings,"select public.alfred_accounting_source_version($1::uuid) as version",[ownerId]);
  return rows[0].version;
}

/** Does not initialize or migrate tables. Legacy ledgers remain usable before the additive migration. */
export async function loadAccountingState(settings:SupabaseSettings,ownerId:string,providedRaw?:TransactionRecord[],transferPivotIds?:string[],includeImportedProviderFacts=true):Promise<AccountingResult> {
  const ready=await query<{ready:boolean;portability_ready:boolean;receipts_ready:boolean;provider_summaries_ready:boolean}>(settings,"select to_regclass('public.accounting_states') is not null and to_regprocedure('public.alfred_write_accounting_state(uuid,bigint,text,text,text,jsonb)') is not null as ready, to_regclass('public.imported_finance_sources') is not null as portability_ready, to_regclass('public.finance_import_receipts') is not null as receipts_ready, to_regprocedure('public.alfred_import_provider_facts(uuid,jsonb)') is not null as provider_summaries_ready");
  const availability=ready[0]?.ready ? "ready" : "migration-required";
  const versionBefore=availability==="ready" ? await sourceVersion(settings,ownerId) : null;
  const [saved,raw,messages,imported,rules,transferWindow]=await Promise.all([
    availability==="ready" ? query<{state:AccountingState}>(settings,"select state from public.accounting_states where owner_id=$1::uuid",[ownerId]) : Promise.resolve([]),
    // For a source-coherent accounting read, fetch fresh rows inside the two version observations.
    availability==="ready" || !providedRaw ? listRawTransactions(settings,ownerId) : Promise.resolve(providedRaw),
    createSupabaseBankStore(settings).listMessages(ownerId),
    ready[0]?.portability_ready ? query<{movement:CashMovement}>(settings,"select movement from public.imported_finance_sources where owner_id=$1::uuid order by movement_id",[ownerId]) : Promise.resolve([]),
    loadAccountRules(settings,ownerId),
    transferPivotIds?.length ? listBankTransferWindow(settings,ownerId,transferPivotIds) : Promise.resolve(undefined),
  ]);
  const base=saved[0]?.state ?? emptyAccountingState(ownerId);
  if (base.ownerId!==ownerId) throw new AccountingError("Financial state belongs to another owner.","ownership");
  const transferProviders=transferPivotIds?.length && includeImportedProviderFacts && ready[0]?.receipts_ready ? await loadImportedTransferProviders(settings,ownerId,base.accounts,{summaryReady:ready[0]?.provider_summaries_ready===true}) : undefined;
  const versionAfter=availability==="ready" ? await sourceVersion(settings,ownerId) : null;
  if (versionBefore!==versionAfter) throw new AccountingError("Source records changed while loading. Refresh and try again.","stale");
  const fresh=[...sourceMovements(ownerId,raw,messages),...imported.map((row) => row.movement)];
  // Bind explicit account identities before hydration so authoritative balance snapshots
  // are generated normally. Reapply categories after hydration so manual overrides win.
  const bound=applyAccountRules({...base,movements:fresh},rules.state);
  const hydrated=hydrateAccountingSources(base,bound.movements);
  return {state:applyAccountRules(hydrated,rules.state),availability,sourceVersion:versionAfter,rawTransactions:raw,bankMessages:messages,...(transferWindow ? {transferWindow} : {}),...(transferProviders ? {transferProviders} : {})};
}

export async function saveAccountingAction(settings:SupabaseSettings,ownerId:string,action:AccountingAction):Promise<AccountingResult> {
  const current=await loadAccountingState(settings,ownerId);
  if (current.availability!=="ready") return current;
  // A durable event log, beyond the bounded in-memory undo history, enforces permanent request IDs.
  const prior=await query<{action_fingerprint:string}>(settings,"select action_fingerprint from public.accounting_events where owner_id=$1::uuid and request_id=$2",[ownerId,action.requestId]);
  const fingerprint=actionFingerprint(action);
  if (prior[0]) {
    if (prior[0].action_fingerprint!==fingerprint) throw new AccountingError("This request ID was used for a different action.","conflict");
    return current;
  }
  const next=applyAccountingAction(current.state,action);
  const rows=await query<{result:{status:"saved"|"duplicate"|"stale"|"conflict"|"source_changed";state?:AccountingState}}>(settings,
    "select public.alfred_write_accounting_state($1::uuid,$2::bigint,$3,$4,$5,$6::jsonb) as result",
    [ownerId,action.expectedRevision,action.requestId,fingerprint,current.sourceVersion,JSON.stringify(next)]);
  const result=rows[0]?.result;
  if (result?.status==="conflict") throw new AccountingError("This request ID was used for a different action.","conflict");
  if (result?.status==="stale" || result?.status==="source_changed") throw new AccountingError("Financial records or source evidence changed. Refresh before saving.","stale");
  if (!result?.state) throw new AccountingError("The database did not confirm the financial change.","conflict");
  return {state:result.state,availability:"ready",sourceVersion:current.sourceVersion,rawTransactions:current.rawTransactions,bankMessages:current.bankMessages};
}
