import { createHash } from "node:crypto";
import type { SupabaseSettings } from "@/lib/config";
import { loadAccountingState, type AccountingResult } from "@/lib/finance/accounting/persisted-store";
import { accountingData, stableJson } from "@/lib/finance/accounting/reducer";
import { validateAccountData } from "@/lib/finance/accounting/accounts";
import { applySettlementAction, validateSettlements } from "@/lib/finance/accounting/settlements";
import { emptyAccountingState, type AccountingState, type CashMovement, type SettlementLink } from "@/lib/finance/accounting/types";
import { formatAmount } from "@/lib/finance/money";
import { query, withBankIngestTransaction } from "@/lib/supabase/connection";
import { createSupabaseBankStore, type BankMessage } from "./store";

const hash = (value: unknown) => createHash("sha256").update(stableJson(value)).digest("hex");
export type ReturnOriginal = { id: string; fingerprint: string; amountMinor: number; remainingMinor: number; date: string; description: string; currency: string };
export type ReturnCandidate = { bankMessageId: string; amountMinor: number; date: string; description: string; fingerprint: string };
export type PaymentResolutionContext = {
  ownerId: string; bankMessageId: string; source: BankMessage | null; evidenceFingerprint: string;
  availability: "ready" | "unavailable"; noMoneyAllowed: boolean; returnAllowed: boolean;
  originals: ReturnOriginal[]; returns: ReturnCandidate[]; resolved: "not_completed" | "returned" | null;
  resolutionNotice?:string|null;
};
export type PaymentResolutionResult = { status: "saved" | "duplicate" | "stale" | "protected" | "unavailable"; changed: boolean };
export type PaymentResolutionDeps = {
  inspect(ownerId: string, bankMessageId: string): Promise<PaymentResolutionContext>;
  noMoney(ownerId: string, bankMessageId: string, input: { requestId: string; evidenceFingerprint: string; reason: "failed" | "not_completed" }): Promise<PaymentResolutionResult>;
  returned(ownerId: string, bankMessageId: string, input: { requestId: string; evidenceFingerprint: string; originalId: string; returnBankMessageId?: string; principalMinor: number }): Promise<PaymentResolutionResult>;
  reopen(ownerId: string, bankMessageId: string, input: { requestId: string; evidenceFingerprint: string }): Promise<PaymentResolutionResult>;
};

function inUse(state: AccountingState, movementId: string): boolean {
  return state.transfers.some(row => row.outgoing.movementId === movementId || row.incoming.movementId === movementId) ||
    state.settlements.some(row => row.original.movementId === movementId || row.returns.some(item => item.movementId === movementId));
}
function pendingSource(state: AccountingState, source: BankMessage | null): CashMovement | null {
  if (!source || source.ownerId !== state.ownerId || source.status !== "needs_label" || source.transactionId || !["payment", "unknown"].includes(source.kind)) return null;
  const movement = state.movements.find(row => row.id === `bank:${source.id}` && row.ownerId === state.ownerId && row.sourceId === source.id);
  return movement && !movement.sourceMissing && movement.status === "review" && movement.sourceStatus === "review" &&
    movement.categoryOrigin !== "manual" && !movement.legacyClassification && !inUse(state, movement.id) ? movement : null;
}
function originalsFor(state: AccountingState, source: BankMessage, target: CashMovement): ReturnOriginal[] {
  const validation = validateSettlements(state);
  return state.movements.filter(row => row.ownerId === state.ownerId && (source.direction === "out" ? row.id === target.id : row.id !== target.id) && !row.sourceMissing &&
    row.status === "confirmed" && row.direction === "out" && row.currency === target.currency && row.amountMinor > 0 &&
    !row.legacyClassification && !["Fees", "Taxes"].includes(row.category) && row.date <= target.date &&
    (row.occurredAt === null || target.occurredAt === null || Date.parse(row.occurredAt) <= Date.parse(target.occurredAt)) &&
    !state.transfers.some(link => link.outgoing.movementId === row.id || link.incoming.movementId === row.id) &&
    !state.settlements.some(link => link.kind !== "refund" && (link.original.movementId === row.id || link.returns.some(item => item.movementId === row.id))) &&
    !validation.issues.some(issue => issue.link.original.movementId === row.id))
    .map(row => ({ id: row.id, fingerprint: row.sourceFingerprint, amountMinor: row.amountMinor,
      remainingMinor: row.amountMinor - validation.valid.filter(link => link.original.id === row.id).reduce((sum, link) => sum + link.returnedMinor, 0),
      date: row.date, description: row.description, currency: row.currency }))
    .filter(row => row.remainingMinor > 0).sort((a,b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id)).slice(0, 40);
}

function contextOf(loaded: AccountingResult, ownerId: string, bankMessageId: string): PaymentResolutionContext {
  const source = loaded.bankMessages?.find(row => row.ownerId === ownerId && row.id === bankMessageId) ?? null;
  const movement = pendingSource(loaded.state, source);
  const focusedMovement=loaded.state.movements.find(row=>row.id===`bank:${bankMessageId}`&&row.ownerId===ownerId);
  const originals = source && focusedMovement ? originalsFor(loaded.state, source, focusedMovement) : [];
  const returns:ReturnCandidate[]=source ? (loaded.bankMessages??[]).filter(row=>row.ownerId===ownerId&&row.direction==="in"&&row.currency===source.currency&&
    (source.direction==="in"?row.id===source.id:Date.parse(row.occurredAt)>=Date.parse(source.occurredAt))&&pendingSource(loaded.state,row))
    .map(row=>({bankMessageId:row.id,amountMinor:loaded.state.movements.find(item=>item.id===`bank:${row.id}`)!.amountMinor,date:row.occurredAt.slice(0,10),description:row.counterparty,fingerprint:hash(row)}))
    .sort((a,b)=>b.date.localeCompare(a.date)||a.bankMessageId.localeCompare(b.bankMessageId)).slice(0,40) : [];
  return { ownerId, bankMessageId, source, availability: loaded.availability === "ready" ? "ready" : "unavailable",
    noMoneyAllowed: Boolean(movement), returnAllowed: Boolean(returns.length&&originals.length), originals, returns,
    resolved: source?.status === "not_completed" || source?.status === "returned" ? source.status : null,
    evidenceFingerprint: hash([ownerId, bankMessageId, loaded.state.revision, loaded.sourceVersion, source, originals,returns]) };
}
async function schemaReady(settings: SupabaseSettings): Promise<boolean> {
  const rows = await query<{ ready: boolean }>(settings, "select to_regclass('public.bank_payment_resolutions') is not null as ready");
  return rows[0]?.ready === true;
}
async function inspect(settings: SupabaseSettings, ownerId: string, bankMessageId: string): Promise<{ context: PaymentResolutionContext; loaded: AccountingResult } | null> {
  if (!await schemaReady(settings)) return null;
  const loaded = await loadAccountingState(settings, ownerId, undefined, undefined, false);
  const context=contextOf(loaded,ownerId,bankMessageId);
  if(context.resolved)context.resolutionNotice=await loadPaymentResolutionNotice(settings,ownerId,bankMessageId);
  return { context, loaded };
}
const unavailable = (ownerId: string, bankMessageId: string): PaymentResolutionContext => ({ ownerId, bankMessageId, source: null,
  availability: "unavailable", noMoneyAllowed: false, returnAllowed: false, originals: [], returns: [], resolved: null, evidenceFingerprint: "" });

async function writeState(settings: SupabaseSettings, ownerId: string, loaded: AccountingResult, nextData: AccountingState, before: AccountingState, requestId: string, action: string, fingerprint: string): Promise<void> {
  const revision = loaded.state.revision + 1, at = new Date().toISOString();
  const next: AccountingState = { ...nextData, revision, audit: [...nextData.audit,
    { id: `revision:${revision}`, requestId, action, actionFingerprint: fingerprint, at, revision, before: accountingData(before) }].slice(-50) };
  validateAccountData(next);
  const rows = await query<{ result: { status: string } }>(settings, "select public.alfred_write_accounting_state($1::uuid,$2::bigint,$3,$4,$5,$6::jsonb) as result",
    [ownerId, loaded.state.revision, requestId, fingerprint, loaded.sourceVersion, JSON.stringify(next)]);
  if (!["saved", "duplicate"].includes(rows[0]?.result.status)) throw new Error("Payment evidence changed before the resolution was saved.");
}
async function insertResolution(settings: SupabaseSettings, source: BankMessage, fresh: AccountingResult, input: {
  requestId: string; kind: "not_completed" | "returned"; reason: "failed" | "not_completed" | "returned";
  beforeFingerprint: string; original?: ReturnOriginal; principalMinor?: number; settlementId?: string;
}): Promise<void> {
  const after = fresh.bankMessages?.find(row => row.ownerId === source.ownerId && row.id === source.id);
  const movement = fresh.state.movements.find(row => row.id === `bank:${source.id}` && row.ownerId === source.ownerId);
  if (!after || !movement) throw new Error("The resolved source was not retained.");
  const relatedIds=new Set([movement.id,...(input.original?[input.original.id]:[]),...(input.original?fresh.state.settlements.filter(link=>link.original.movementId===input.original!.id).flatMap(link=>link.returns.map(row=>row.movementId)):[])]);
  const facts=await liveFacts(settings,source.ownerId,fresh.state.movements.filter(row=>relatedIds.has(row.id)));
  await query(settings, `insert into public.bank_payment_resolutions(owner_id,bank_message_id,kind,reason,request_id,source_fingerprint,resolved_source_fingerprint,bank_evidence_fingerprint,live_facts_fingerprint,source_snapshot,original_movement_id,original_source_fingerprint,principal_minor,settlement_id,accounting_revision)
    values($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13::bigint,$14,$15::bigint)`,
    [source.ownerId,source.id,input.kind,input.reason,input.requestId,input.beforeFingerprint,movement.sourceFingerprint,hash(after),facts,JSON.stringify(source),input.original?.id??null,input.original?.fingerprint??null,input.principalMinor??null,input.settlementId??null,fresh.state.revision+1]);
}
async function liveFacts(settings:SupabaseSettings,ownerId:string,movements:CashMovement[],expectedRevision?:string):Promise<string>{
  const bankIds=movements.filter(row=>row.sourceKind==="bank").map(row=>row.sourceId);
  const transactionIds=[...new Set(movements.flatMap(row=>[row.legacyTransactionId,row.feeTransactionId,...(row.sourceKind==="transaction"?[row.sourceId]:[])]).filter((value):value is string=>Boolean(value)))];
  const importedIds=movements.filter(row=>row.importProvenance).map(row=>row.id);
  const rows=await query<{fingerprint:string}>(settings,`select md5(jsonb_build_object(
    'bank',(select coalesce(jsonb_agg(to_jsonb(b)-'asked_at'-'announced_at' order by b.id),'[]'::jsonb) from public.bank_messages b where b.owner_id=$1::uuid and b.id=any($2::uuid[])),
    'transactions',(select coalesce(jsonb_agg(to_jsonb(t) order by t.transaction_id),'[]'::jsonb) from public.transactions t where t.owner_id=$1::uuid and t.transaction_id::text=any($3::text[])),
    'imported',(select coalesce(jsonb_agg(to_jsonb(i) order by i.movement_id),'[]'::jsonb) from public.imported_finance_sources i where i.owner_id=$1::uuid and i.movement_id=any($4::text[])))::text) as fingerprint
    where $5::bigint is null or exists(select 1 from public.accounting_states s where s.owner_id=$1::uuid and s.revision=$5::bigint)`,[ownerId,bankIds,transactionIds,importedIds,expectedRevision??null]);
  if(!rows[0]?.fingerprint){if(expectedRevision!==undefined)return "";throw new Error("Payment source facts could not be checked.");}
  return rows[0].fingerprint;
}
async function replay(settings: SupabaseSettings, ownerId: string, bankMessageId: string, input:{kind:string;reason:string;requestId:string;originalId?:string;principalMinor?:number}): Promise<PaymentResolutionResult | null> {
  const rows = await query<{ kind: string;reason:string;request_id:string;original_movement_id:string|null;original_source_fingerprint:string|null;resolved_source_fingerprint:string;settlement_id:string|null;accounting_revision:string;live_facts_fingerprint:string;principal_minor:string|null;bank_evidence_fingerprint: string }>(settings, "select kind,reason,request_id,original_movement_id,original_source_fingerprint,resolved_source_fingerprint,settlement_id,accounting_revision::text,live_facts_fingerprint,principal_minor::text,bank_evidence_fingerprint from public.bank_payment_resolutions where owner_id=$1::uuid and bank_message_id=$2::uuid and reopened_at is null", [ownerId,bankMessageId]);
  if (!rows[0]) return null;
  const source = await createSupabaseBankStore(settings).getMessage(ownerId,bankMessageId);
  const row=rows[0];
  const matches=row.kind===input.kind&&row.reason===input.reason&&row.request_id===input.requestId&&row.original_movement_id===(input.originalId??null)&&row.principal_minor===(input.principalMinor===undefined?null:String(input.principalMinor));
  if(!matches||!source||row.bank_evidence_fingerprint!==hash(source))return {status:"stale",changed:false};
  const loaded=await loadAccountingState(settings,ownerId,undefined,undefined,false);
  const movement=loaded.state.movements.find(item=>item.id===`bank:${bankMessageId}`);
  if(loaded.availability!=="ready"||String(loaded.state.revision)!==row.accounting_revision||!movement||movement.sourceFingerprint!==row.resolved_source_fingerprint)return {status:"stale",changed:false};
  const settlement=loaded.state.settlements.find(item=>item.id===row.settlement_id);
  if(row.kind==="not_completed"&&movement.status!=="excluded")return {status:"stale",changed:false};
  if(row.kind==="returned"&&!validateSettlements(loaded.state).valid.some(item=>item.link.id===row.settlement_id&&item.original.id===row.original_movement_id&&item.original.sourceFingerprint===row.original_source_fingerprint&&item.link.returns.some(back=>back.movementId===movement.id&&back.principalMinor===input.principalMinor)))return {status:"stale",changed:false};
  const ids=new Set([movement.id,...(settlement?[settlement.original.movementId,...settlement.returns.map(item=>item.movementId)]:[])]);
  if(await liveFacts(settings,ownerId,loaded.state.movements.filter(item=>ids.has(item.id)))!==row.live_facts_fingerprint)return {status:"stale",changed:false};
  return {status:"duplicate",changed:false};
}

export function createPaymentResolutionDeps(settings: SupabaseSettings): PaymentResolutionDeps {
  return {
    async inspect(ownerId, bankMessageId) { return (await inspect(settings,ownerId,bankMessageId))?.context ?? unavailable(ownerId,bankMessageId); },
    async noMoney(ownerId,bankMessageId,input) {
      if (!/^[\w:.-]{1,160}$/.test(input.requestId) || !input.evidenceFingerprint || !["failed","not_completed"].includes(input.reason)) return { status: "stale", changed: false };
      return withBankIngestTransaction(settings,ownerId,async () => {
        if (!await schemaReady(settings)) return { status: "unavailable", changed: false };
        await query(settings,"select owner_id from public.accounting_states where owner_id=$1::uuid for update",[ownerId]);
        await query(settings,"select id from public.bank_messages where owner_id=$1::uuid and id=$2::uuid for update",[ownerId,bankMessageId]);
        const prior=await replay(settings,ownerId,bankMessageId,{kind:"not_completed",reason:input.reason,requestId:`payment_no_money_${hash(input.requestId)}`}); if(prior)return prior;
        const observed=await inspect(settings,ownerId,bankMessageId);
        if(!observed||observed.context.availability!=="ready")return {status:"unavailable",changed:false};
        const {context,loaded}=observed,source=context.source;
        if(context.evidenceFingerprint!==input.evidenceFingerprint)return {status:"stale",changed:false};
        if(!source||!context.noMoneyAllowed)return {status:"protected",changed:false};
        const original=loaded.state.movements.find(row=>row.id===`bank:${bankMessageId}`)!;
        await createSupabaseBankStore(settings).updateMessage(ownerId,bankMessageId,{status:"not_completed"});
        const fresh=await loadAccountingState(settings,ownerId,undefined,undefined,false);
        if(fresh.availability!=="ready")throw new Error("Payment storage became unavailable.");
        const requestId=`payment_no_money_${hash(input.requestId)}`;
        await writeState(settings,ownerId,fresh,fresh.state,loaded.state,requestId,"resolve_payment_no_money",stableJson({type:"resolve_payment_no_money",bankMessageId,reason:input.reason,evidenceFingerprint:input.evidenceFingerprint}));
        await insertResolution(settings,source,fresh,{requestId,kind:"not_completed",reason:input.reason,beforeFingerprint:original.sourceFingerprint});
        return {status:"saved",changed:true};
      });
    },
    async returned(ownerId,bankMessageId,input) {
      if(!/^[\w:.-]{1,160}$/.test(input.requestId)||!input.evidenceFingerprint||!Number.isSafeInteger(input.principalMinor)||input.principalMinor<=0)return {status:"stale",changed:false};
      return withBankIngestTransaction(settings,ownerId,async()=>{
        if(!await schemaReady(settings))return {status:"unavailable",changed:false};
        await query(settings,"select owner_id from public.accounting_states where owner_id=$1::uuid for update",[ownerId]);
        const returnBankMessageId=input.returnBankMessageId??bankMessageId;
        const originalBankId=/^bank:([a-f0-9-]{36})$/i.exec(input.originalId)?.[1];
        await query(settings,"select id from public.bank_messages where owner_id=$1::uuid and id=any($2::uuid[]) order by id for update",[ownerId,[...new Set([bankMessageId,returnBankMessageId,...(originalBankId?[originalBankId]:[])])]]);
        const prior=await replay(settings,ownerId,returnBankMessageId,{kind:"returned",reason:"returned",requestId:`payment_return_${hash(input.requestId)}`,originalId:input.originalId,principalMinor:input.principalMinor});if(prior)return prior;
        const observed=await inspect(settings,ownerId,bankMessageId);
        if(!observed||observed.context.availability!=="ready")return {status:"unavailable",changed:false};
        const {context,loaded}=observed,source=loaded.bankMessages?.find(row=>row.id===returnBankMessageId&&row.ownerId===ownerId)??null,original=context.originals.find(row=>row.id===input.originalId);
        if(context.evidenceFingerprint!==input.evidenceFingerprint)return {status:"stale",changed:false};
        const target=pendingSource(loaded.state,source);
        if(!source||!target||!context.returns.some(row=>row.bankMessageId===returnBankMessageId)||!context.returnAllowed||!original||input.principalMinor!==target.amountMinor||input.principalMinor>original.remainingMinor)return {status:"protected",changed:false};
        const existing=loaded.state.settlements.find(row=>row.kind==="refund"&&row.original.movementId===original.id);
        const settlementId=existing?.id??`payment_return_${hash([ownerId,original.id])}`;
        await createSupabaseBankStore(settings).updateMessage(ownerId,returnBankMessageId,{status:"returned"});
        const fresh=await loadAccountingState(settings,ownerId,undefined,undefined,false);
        if(fresh.availability!=="ready")throw new Error("Payment storage became unavailable.");
        const incoming=fresh.state.movements.find(row=>row.id===target.id)!;
        const next=applySettlementAction(fresh.state,{type:"save_settlement",expectedRevision:fresh.state.revision,requestId:input.requestId,settlement:{id:settlementId,kind:"refund",original:{movementId:original.id,sourceFingerprint:original.fingerprint},returns:[...(existing?.returns??[]),{movementId:incoming.id,sourceFingerprint:incoming.sourceFingerprint,principalMinor:input.principalMinor}]}},new Date().toISOString());
        const requestId=`payment_return_${hash(input.requestId)}`;
        await writeState(settings,ownerId,fresh,next,loaded.state,requestId,"resolve_payment_return",stableJson({type:"resolve_payment_return",bankMessageId:returnBankMessageId,focusBankMessageId:bankMessageId,originalId:original.id,principalMinor:input.principalMinor,evidenceFingerprint:input.evidenceFingerprint}));
        await insertResolution(settings,source,fresh,{requestId,kind:"returned",reason:"returned",beforeFingerprint:target.sourceFingerprint,original,principalMinor:input.principalMinor,settlementId});
        return {status:"saved",changed:true};
      });
    },
    async reopen(ownerId,bankMessageId,input) {
      if(!/^[\w:.-]{1,160}$/.test(input.requestId)||!input.evidenceFingerprint)return {status:"stale",changed:false};
      return withBankIngestTransaction(settings,ownerId,async()=>{
        if(!await schemaReady(settings))return {status:"unavailable",changed:false};
        await query(settings,"select owner_id from public.accounting_states where owner_id=$1::uuid for update",[ownerId]);
        await query(settings,"select id from public.bank_messages where owner_id=$1::uuid and id=$2::uuid for update",[ownerId,bankMessageId]);
        const observed=await inspect(settings,ownerId,bankMessageId);
        if(!observed||observed.context.availability!=="ready")return {status:"unavailable",changed:false};
        const {context,loaded}=observed,source=context.source;
        if(context.evidenceFingerprint!==input.evidenceFingerprint)return {status:"stale",changed:false};
        const records=await query<{id:string;kind:string;settlement_id:string|null;original_movement_id:string|null;original_source_fingerprint:string|null;resolved_source_fingerprint:string;bank_evidence_fingerprint:string;live_facts_fingerprint:string;accounting_revision:string}>(settings,"select id::text,kind,settlement_id,original_movement_id,original_source_fingerprint,resolved_source_fingerprint,bank_evidence_fingerprint,live_facts_fingerprint,accounting_revision::text from public.bank_payment_resolutions where owner_id=$1::uuid and bank_message_id=$2::uuid and reopened_at is null for update",[ownerId,bankMessageId]);
        const record=records[0],movement=loaded.state.movements.find(row=>row.id===`bank:${bankMessageId}`);
        if(!source||!record||source.status!==record.kind||!movement||movement.sourceFingerprint!==record.resolved_source_fingerprint||hash(source)!==record.bank_evidence_fingerprint)return {status:"protected",changed:false};
        const settlement=record.kind==="returned"?loaded.state.settlements.find(row=>row.id===record.settlement_id):null;
        if(record.kind==="not_completed"&&(movement.status!=="excluded"||inUse(loaded.state,movement.id)))return {status:"protected",changed:false};
        if(record.kind==="returned"&&(!settlement||!validateSettlements(loaded.state).valid.some(item=>item.link.id===settlement.id&&item.original.id===record.original_movement_id&&item.original.sourceFingerprint===record.original_source_fingerprint&&item.link.returns.some(back=>back.movementId===movement.id))))return {status:"protected",changed:false};
        const relatedIds=new Set([movement.id,...(settlement?[settlement.original.movementId,...settlement.returns.map(row=>row.movementId)]:[])]);
        if(await liveFacts(settings,ownerId,loaded.state.movements.filter(row=>relatedIds.has(row.id)))!==record.live_facts_fingerprint)return {status:"stale",changed:false};
        const later=await query<{action:string;action_fingerprint:string}>(settings,"select action,action_fingerprint from public.accounting_events where owner_id=$1::uuid and revision>$2::bigint",[ownerId,record.accounting_revision]);
        if(later.some(event=>["undo","import","undo_import"].includes(event.action)||[...relatedIds].some(id=>event.action_fingerprint.includes(JSON.stringify(id)))||Boolean(record.settlement_id&&event.action_fingerprint.includes(JSON.stringify(record.settlement_id)))))return {status:"stale",changed:false};
        await createSupabaseBankStore(settings).updateMessage(ownerId,bankMessageId,{status:"needs_label"});
        const fresh=await loadAccountingState(settings,ownerId,undefined,undefined,false);
        if(fresh.availability!=="ready")throw new Error("Payment storage became unavailable.");
        const requestId=`payment_reopen_${hash(input.requestId)}`;
        const next=settlement?{...fresh.state,settlements:fresh.state.settlements.flatMap(link=>link.id!==settlement.id?[link]:link.returns.filter(row=>row.movementId!==movement.id).length?[{...link,returns:link.returns.filter(row=>row.movementId!==movement.id)}]:[])}:fresh.state;
        await writeState(settings,ownerId,fresh,next,loaded.state,requestId,"reopen_payment_resolution",stableJson({type:"reopen_payment_resolution",bankMessageId,evidenceFingerprint:input.evidenceFingerprint}));
        await query(settings,"update public.bank_payment_resolutions set reopened_at=now() where owner_id=$1::uuid and id=$2::uuid and reopened_at is null",[ownerId,record.id]);
        return {status:"saved",changed:true};
      });
    },
  };
}

/** Read-only exact-source confirmation for a notification entry; no archives,
 * model calls, accounting hydration or source initialization. */
export async function loadPaymentResolutionNotice(settings: SupabaseSettings,ownerId:string,bankMessageId:string):Promise<string|null>{
  const rows=await query<{kind:string;bank_message_id:string;bank_evidence_fingerprint:string;resolved_source_fingerprint:string;original_movement_id:string|null;original_source_fingerprint:string|null;live_facts_fingerprint:string;accounting_revision:string;revision:string;movements:CashMovement[];settlement:SettlementLink|null}>(settings,`select r.kind,r.bank_message_id::text,r.bank_evidence_fingerprint,r.resolved_source_fingerprint,r.original_movement_id,r.original_source_fingerprint,r.live_facts_fingerprint,r.accounting_revision::text,s.revision::text,
    (select coalesce(jsonb_agg(m),'[]'::jsonb) from jsonb_array_elements(coalesce(s.state->'movements','[]'::jsonb)) m
      where m->>'id'='bank:'||r.bank_message_id::text or m->>'id'=r.original_movement_id or exists(select 1 from jsonb_array_elements(coalesce(link.item->'returns','[]'::jsonb)) back where back->>'movementId'=m->>'id')) as movements,
    link.item as settlement from public.bank_payment_resolutions r left join public.accounting_states s on s.owner_id=r.owner_id
    left join lateral(select item from jsonb_array_elements(coalesce(s.state->'settlements','[]'::jsonb)) item where item->>'id'=r.settlement_id) link on true
    where r.owner_id=$1::uuid and (r.bank_message_id=$2::uuid or r.original_movement_id='bank:'||$2::uuid::text) and r.reopened_at is null
    order by r.accounting_revision desc limit 1`,[ownerId,bankMessageId]);
  const row=rows[0];if(!row)return null;
  const needsChecking="This payment's saved resolution needs checking because its source, classification or link changed. Nothing was changed by opening it.";
  const source=await createSupabaseBankStore(settings).getMessage(ownerId,row.bank_message_id);
  const movement=row.movements.find(item=>item.id===`bank:${row.bank_message_id}`&&item.ownerId===ownerId);
  if(!source||hash(source)!==row.bank_evidence_fingerprint||row.revision!==row.accounting_revision||!movement||movement.sourceFingerprint!==row.resolved_source_fingerprint||await liveFacts(settings,ownerId,row.movements,row.revision)!==row.live_facts_fingerprint)return needsChecking;
  if(row.kind==="not_completed"&&(source.status!=="not_completed"||movement.status!=="excluded"))return needsChecking;
  if(row.kind==="returned"){
    const original=row.movements.find(item=>item.id===row.original_movement_id&&item.ownerId===ownerId);
    if(source.status!=="returned"||!original||original.sourceFingerprint!==row.original_source_fingerprint||!row.settlement)return needsChecking;
    const mini={...emptyAccountingState(ownerId),movements:row.movements,settlements:[row.settlement]};
    const validation=validateSettlements(mini);
    if(validation.issues.length||validation.valid.length!==1||!row.settlement.returns.some(item=>item.movementId===movement.id&&item.sourceFingerprint===row.resolved_source_fingerprint))return needsChecking;
  }
  return row.kind==="not_completed" ? `You confirmed that the ${source.direction==="out"?"outgoing":"incoming"} alert for ${formatAmount(source.amount,source.currency)} did not represent completed money movement. It is excluded from income and spending; the original alert and any recorded fee are retained.`
    : row.bank_message_id===bankMessageId?`This ${formatAmount(source.amount,source.currency)} incoming alert is linked as returned principal against the original payment, rather than new income. The original cash evidence and recorded fees are retained.`
      : `Returned principal is linked against this original payment. Only the returned amount reduces spending; the original cash evidence and recorded fees are retained.`;
}
