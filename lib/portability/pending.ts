import { createArchive, readArchive, canonicalStringify, type Archive, type Coverage, type Datasets } from "../../portability/archive.mjs";
import type { SupabaseSettings } from "@/lib/config";
import { AccountingError } from "@/lib/finance/accounting/types";
import { query } from "@/lib/supabase/connection";
import { scrubNativeOwnership } from "./export";
import { CORE_DOMAINS } from "./model";
import { NATIVE_TABLES } from "./native-restoration";
import { prepareFinanceImport, requirePortability } from "./service";

type Row = Record<string, unknown>;
export type PendingDomain = { dataset:string;path:string[];status:"awaiting_support"|"review_required"|"source_evidence";reason:string;count:number|null };
export type PendingItem = { receiptId:string;archiveId:string;sourceApp:string;namespace:string;exportedAt:string;importedAt:string;undone:boolean;activeCounts:{accounting:Record<string,number>;native:Record<string,number>};savedDatasetCounts:Record<string,number>;pendingDomains:PendingDomain[];activationAvailable:boolean };
export type PendingReceiptRow = {id:string;archive_id:string;archive:unknown;summary:Row;imported_at:string|Date;undone_at:string|Date|null;activation_of:string|null;created_ids:{accounting:Record<string,string[]>;native:Record<string,string[]>}};
type CurrentIds={accounting:Record<string,string[]>;native:Record<string,string[]>};
const object=(value:unknown):value is Row=>!!value&&typeof value==="object"&&!Array.isArray(value);
const iso=(value:string|Date)=>new Date(value).toISOString();
const recordCount=(value:unknown):number|null=>Array.isArray(value)?value.length:object(value)?Object.keys(value).length:value===undefined||value===null?0:null;
const atPath=(datasets:unknown,path:string[])=>path.reduce<unknown>((value,key)=>object(value)?value[key]:Array.isArray(value)&&/^\d+$/.test(key)?value[Number(key)]:undefined,datasets);
const coreIdsSql=(state:string,domain:string)=>`select item->>'id' as id from jsonb_array_elements(coalesce(${state}->'${domain}','[]'::jsonb)) item`;
const customCreatedIdsSql=(kind:"rules"|"bindings")=>`(select coalesce(jsonb_agg(id),'[]'::jsonb) from (select item->>'id' as id from jsonb_array_elements(coalesce(r.native_plan#>'{accountRules,state,${kind}}','[]'::jsonb)) item except select item->>'id' as id from jsonb_array_elements(coalesce(r.native_before#>'{accountRules,state,${kind}}','[]'::jsonb)) item) added)`;
const CREATED_IDS_SQL=`jsonb_build_object('accounting',jsonb_build_object(${CORE_DOMAINS.map((domain)=>`'${domain}',(select coalesce(jsonb_agg(id),'[]'::jsonb) from (${coreIdsSql("r.after_state",domain)} except ${coreIdsSql("r.before_state",domain)}) created)`).join(",")}),
 'native',jsonb_build_object(${Object.entries(NATIVE_TABLES).map(([table,definition])=>`'${table}',(select coalesce(jsonb_agg(item->>'${definition.key}'),'[]'::jsonb) from jsonb_array_elements(coalesce(r.native_plan->'tables'->'${table}','[]'::jsonb)) item)`).join(",")},'account_rules',${customCreatedIdsSql("rules")},'account_bindings',${customCreatedIdsSql("bindings")}))`;
export const PENDING_RECEIPT_SELECT_SQL=`select r.id,r.archive_id,r.archive,r.summary,r.imported_at,r.undone_at,r.activation_of,${CREATED_IDS_SQL} as created_ids from public.finance_import_receipts r`;
const RECEIPT_SELECT=PENDING_RECEIPT_SELECT_SQL;
export const CURRENT_FEATURE_IDS_SQL=`select jsonb_build_object('accounting',jsonb_build_object(${CORE_DOMAINS.map((domain)=>`'${domain}',(select coalesce(jsonb_agg(id),'[]'::jsonb) from (${coreIdsSql("(select state from public.accounting_states where owner_id=$1::uuid)",domain)}) current_rows)`).join(",")}),
 'native',jsonb_build_object(${Object.entries(NATIVE_TABLES).map(([table,definition])=>`'${table}',(select coalesce(jsonb_agg(${definition.key}::text),'[]'::jsonb) from public.${table} where owner_id=$1::uuid)`).join(",")},'account_rules',(select coalesce(jsonb_agg(item->>'id'),'[]'::jsonb) from public.account_rule_states s cross join lateral jsonb_array_elements(s.state->'rules') item where s.owner_id=$1::uuid),'account_bindings',(select coalesce(jsonb_agg(item->>'id'),'[]'::jsonb) from public.account_rule_states s cross join lateral jsonb_array_elements(s.state->'bindings') item where s.owner_id=$1::uuid))) as ids`;

export function validatePendingReceiptId(id:string) {
  if(!/^[A-Za-z0-9_.:-]{1,160}$/.test(id)) throw new AccountingError("A valid saved-data receipt is required.");
  return id;
}
/** Revalidate stored content and its original identity before reuse. Never invent another archive ID. */
export async function validateStoredArchive(row:Pick<PendingReceiptRow,"archive"|"archive_id">):Promise<Archive> {
  if(!object(row.archive)||!object(row.archive.manifest)||!object(row.archive.datasets)) throw new AccountingError("The saved source archive is incomplete. Its data has not been activated.","conflict");
  const stored=row.archive as unknown as Archive;
  const rebuilt=await readArchive(await createArchive({sourceApp:stored.manifest.sourceApp,namespace:stored.manifest.namespace,timezone:stored.manifest.timezone,currency:stored.manifest.currency,exportedAt:stored.manifest.exportedAt,coverage:stored.manifest.coverage,datasets:stored.datasets}));
  if(stored.archiveId!==row.archive_id||rebuilt.archiveId!==row.archive_id||canonicalStringify(stored.manifest)!==canonicalStringify(rebuilt.manifest)) throw new AccountingError("The saved source archive failed its integrity check. Its data has not been activated.","conflict");
  return rebuilt;
}
/** Listing reads many receipts; the full rebuild-and-hash check runs before any detail view,
 * download or activation, so the list only confirms the stored shape and recorded identity. */
function listedArchive(row:Pick<PendingReceiptRow,"archive"|"archive_id">):Archive {
  if(!object(row.archive)||!object(row.archive.manifest)||!object(row.archive.datasets)||row.archive.archiveId!==row.archive_id) throw new AccountingError("The saved source archive is incomplete. Its data has not been activated.","conflict");
  return row.archive as unknown as Archive;
}
function datasetPath(datasets:Record<string,unknown>,dataset:string):string[]|null {
  const root=Object.keys(datasets).sort((a,b)=>b.length-a.length).find((key)=>dataset===key||dataset.startsWith(`${key}.`));
  if(!root)return null;
  const suffix=dataset.slice(root.length).replace(/^\./,"").split(".").filter(Boolean);
  if(root==="alfred.native"&&suffix.length&&suffix[0]!=="tables"&&suffix[0]!=="settings"&&suffix[0]!=="retainedArchives") suffix.unshift("tables");
  return [root,...suffix];
}
function effectiveCoverage(rows:PendingReceiptRow[]):Coverage[] {
  const byName=new Map<string,Coverage>();
  for(const row of [...rows].sort((a,b)=>iso(a.imported_at).localeCompare(iso(b.imported_at)))) {
    if(row.undone_at)continue;
    const native=object(row.summary.native)?row.summary.native:{};
    for(const coverage of Array.isArray(native.coverage)?native.coverage:[]) if(object(coverage)&&typeof coverage.dataset==="string")byName.set(coverage.dataset,coverage as unknown as Coverage);
  }
  return [...byName.values()];
}
function directPendingDomains(archive:Archive,receipts:PendingReceiptRow[]):PendingDomain[] {
  const datasets=archive.datasets;const coverage=effectiveCoverage(receipts);const supported=new Set(coverage.filter(item=>item.status==="supported").map(item=>item.dataset));
  const domains=new Map<string,PendingDomain>();
  const add=(dataset:string,path:string[],status:PendingDomain["status"],reason:string)=>{
    const value=atPath(datasets,path);const count=recordCount(value);if(count===0)return;
    domains.set(dataset,{dataset,path,status,reason,count});
  };
  const planning=atPath(datasets,["moneyTracker.native","planning"]);
  if(object(planning)) {
    for(const key of ["thirdPartyGroups","thirdPartyAudit"]) if(!supported.has(`moneyTracker.native.planning.${key}`)) add(`moneyTracker.native.planning.${key}`,["moneyTracker.native","planning",key],"awaiting_support","Third-party allocation records and their original relationships are saved. Alfred currently has no equivalent allocation feature; no personal spending or allocation is invented.");
    if(object(planning.plans)&&Object.values(planning.plans).some((plan)=>object(plan)&&Object.keys(plan).some(key=>key!=="categoryLimits"))) add("moneyTracker.native.planning.incomeIntentions",["moneyTracker.native","planning","plans"],"awaiting_support","Complete plans, income intentions, overall limits and repeat metadata remain saved. Explicit category limits may already populate Budgets; other planning meanings need an appropriate feature and deterministic adapter.");
    if(!supported.has("moneyTracker.native.planning.rules")||coverage.some(item=>item.dataset==="moneyTracker.native.planning.rules.awaitingAccountMapping"&&item.status==="preserved")) add("moneyTracker.native.planning.rules",["moneyTracker.native","planning","rules"],"awaiting_support","Original account and merchant rule conditions are saved. They are activated only when their exact meaning and account references can be represented safely.");
    add("moneyTracker.native.planning.preferences",["moneyTracker.native","planning","preferences"],"review_required","Source prompt, digest and notification preferences are saved. Reviewing saved finance data never enables a connection or sends notifications.");
  }
  for(const item of coverage.filter(item=>item.status==="preserved")) {
    let path=datasetPath(datasets,item.dataset);
    if(item.dataset==="alfred.native.accountRules.awaitingAccountMapping")path=["alfred.native","tables","accountRuleStates"];
    else if(item.dataset.includes("awaitingAccountMapping"))path=["moneyTracker.native","planning","rules"];
    else if(item.dataset.includes("unrepresentableCategoryLimits"))path=["moneyTracker.native","planning","plans"];
    else if(item.dataset==="moneyTracker.native.bills.unrepresentable")path=["moneyTracker.native","bills","bills"];
    else if(item.dataset.startsWith("moneyTracker.portfolios")&&(/unrepresentable|undated/.test(item.dataset)))path=["moneyTracker.portfolios","portfolios"];
    else if(/alfred.native.aboutMe.account[-Eex]/.test(item.dataset))path=["alfred.native","tables","aboutMe"];
    else if(item.dataset==="moneyTracker.native.notificationPreferences")path=["moneyTracker.native","bills"];
    if(!path||atPath(datasets,path)===undefined)continue;
    const status:PendingDomain["status"]=/thirdParty|incomeIntentions|unrepresentable/.test(item.dataset)?"awaiting_support":/settings|notification|account.exclusion|awaitingAccountMapping|undated/i.test(item.dataset)?"review_required":"source_evidence";
    add(item.dataset,path,status,item.reason);
    const domain=domains.get(item.dataset);if(domain&&item.count!==undefined)domain.count=item.count;
  }
  const native=datasets["alfred.native"];
  if(object(native)&&object(native.tables)) {
    const pendingRuleMapping=coverage.some(item=>item.dataset==="alfred.native.accountRules.awaitingAccountMapping"&&item.status==="preserved");
    add("alfred.native.accountRules",["alfred.native","tables","accountRuleStates"],!supported.has("alfred.native.accountRules")||pendingRuleMapping?"review_required":"source_evidence",!supported.has("alfred.native.accountRules")||pendingRuleMapping?"Saved account rules require exact imported account identities before activation. No provider-wide or name-based account match is guessed.":"Original rule aggregate, bindings and provenance remain saved; supported rules have already been reviewed for activation.");
    // Older receipts deliberately retained native records before native adapters were available.
    if(!receipts.some(row=>!row.undone_at&&object(row.summary.native))) for(const definition of Object.values(NATIVE_TABLES)) add(`alfred.native.${definition.source}`,["alfred.native","tables",definition.source],"review_required","These native feature records were saved by an earlier import. Review the stored archive with the current deterministic adapters; activation occurs only after a fresh preview and confirmation.");
    for(const key of ["bankMessages","transactions","accountingEvents","accountingStates","labelUndo","importReceipts","importedSources"]) add(`alfred.native.${key}`,["alfred.native","tables",key],"source_evidence","Original source or audit records remain saved with their references. Historical ingestion, notifications and old undo operations are not replayed.");
    add("alfred.native.settings",["alfred.native","settings"],"review_required","Safe default profile fields may already be applied. Original source account controls and reminder enables remain saved and are not enabled by reviewing this archive.");
  }
  for(const [key]of Object.entries(datasets)) if(!CORE_DOMAINS.includes(key as typeof CORE_DOMAINS[number])&&key!=="alfred.native"&&key!=="moneyTracker.native"&&key!=="alfred.browserPreferences")add(key,[key],"source_evidence","Complete source records are saved with their original identities and relationships. Feature-specific activation is limited to the deterministic adapters shown in a fresh preview.");
  return [...domains.values()];
}
/** Inspect only the same documented retained locations used by restoration; no generic JSON crawl. */
export function pendingDomainsForArchive(archive:Archive,receipts:PendingReceiptRow[]):PendingDomain[] {
 const result=directPendingDomains(archive,receipts);
 const queue:{datasets:Record<string,unknown>;path:string[];depth:number}[]=[{datasets:archive.datasets,path:[],depth:0}];let visited=0;
 while(queue.length&&visited++<32) {
  const current=queue.shift()!;if(current.depth>=8)continue;
  const inspect=(entry:unknown,path:string[])=>{
   if(!object(entry))return;const nested=object(entry.archive)?entry.archive:entry;
   const nestedPath=object(entry.archive)?[...path,"archive"]:path;
   const manifest=object(nested.manifest)?nested.manifest:object(nested.sourceManifest)?nested.sourceManifest:null;
   if(!manifest||typeof manifest.namespace!=="string"||!object(nested.datasets))return;
   const base=[...nestedPath,"datasets"];
   const domains=directPendingDomains({manifest,datasets:nested.datasets} as unknown as Archive,receipts);
   for(const domain of domains)result.push({...domain,dataset:`${domain.dataset} · ${manifest.namespace}`,path:[...base,...domain.path],reason:`${domain.reason} Saved within retained source ${manifest.namespace}.`});
   queue.push({datasets:nested.datasets,path:base,depth:current.depth+1});
  };
  if(Array.isArray(current.datasets.preservedArchives))current.datasets.preservedArchives.forEach((entry,index)=>inspect(entry,[...current.path,"preservedArchives",String(index)]));
  for(const key of ["alfred.native","moneyTracker.native"]) {
   const native=current.datasets[key];if(object(native)&&Array.isArray(native.retainedArchives))native.retainedArchives.forEach((entry,index)=>inspect(entry,[...current.path,key,"retainedArchives",String(index)]));
  }
 }
 return result;
}

function activeCounts(rows:PendingReceiptRow[],current:CurrentIds) {
  const result:PendingItem["activeCounts"]={accounting:{},native:{}};
  for(const kind of ["accounting","native"] as const)for(const [domain,ids]of Object.entries(current[kind]??{})) {
    const existing=new Set(ids);const claimed=new Set(rows.filter(row=>!row.undone_at).flatMap(row=>row.created_ids?.[kind]?.[domain]??[]));
    result[kind][domain]=[...claimed].filter(id=>existing.has(id)).length;
  }
  return result;
}
export function pendingItemFromReceipt(row:PendingReceiptRow,archive:Archive,children:PendingReceiptRow[],current:CurrentIds):PendingItem {
  const receipts=[row,...children];
  const savedDatasetCounts=Object.fromEntries(Object.entries(archive.datasets).map(([key,value])=>[key,object(value)&&object(value.tables)?Object.values(value.tables).reduce<number>((sum,rows)=>sum+(Array.isArray(rows)?rows.length:0),0):recordCount(value)??0]));
  return {receiptId:row.id,archiveId:row.archive_id,sourceApp:archive.manifest.sourceApp,namespace:archive.manifest.namespace,exportedAt:archive.manifest.exportedAt,importedAt:iso(row.imported_at),undone:row.undone_at!==null,activeCounts:activeCounts(receipts,current),savedDatasetCounts,pendingDomains:pendingDomainsForArchive(archive,receipts),activationAvailable:row.undone_at===null&&row.activation_of===null};
}
async function currentIds(settings:SupabaseSettings,ownerId:string):Promise<CurrentIds> {
  const rows=await query<{ids:CurrentIds}>(settings,CURRENT_FEATURE_IDS_SQL,[ownerId]);return rows[0]?.ids??{accounting:{},native:{}};
}
async function childReceipts(settings:SupabaseSettings,ownerId:string,sourceIds:string[]):Promise<PendingReceiptRow[]> {
  if(!sourceIds.length)return[];
  return query<PendingReceiptRow>(settings,`${RECEIPT_SELECT} where r.owner_id=$1::uuid and r.activation_of=any($2::text[]) order by r.imported_at,r.id`,[ownerId,sourceIds]);
}
export async function loadPendingReceipt(settings:SupabaseSettings,ownerId:string,receiptId:string) {
  validatePendingReceiptId(receiptId);
  await requirePortability(settings);
  const rows=await query<PendingReceiptRow>(settings,`${RECEIPT_SELECT} where r.owner_id=$1::uuid and r.id=$2 and r.activation_of is null`,[ownerId,receiptId]);
  if(!rows[0])throw new AccountingError("That saved source does not belong to this signed-in profile.","not_found");
  return rows[0];
}
export async function listPendingFinanceData(settings:SupabaseSettings,ownerId:string,cursor?:string) {
  await requirePortability(settings);
  let before:{at:string;id:string}|null=null;
  if(cursor){try{const decoded=JSON.parse(Buffer.from(cursor,"base64url").toString("utf8"));if(!object(decoded)||typeof decoded.at!=="string"||!Number.isFinite(Date.parse(decoded.at))||typeof decoded.id!=="string")throw new Error();validatePendingReceiptId(decoded.id);before={at:decoded.at,id:decoded.id};}catch{throw new AccountingError("The saved-data page cursor is invalid.");}}
  const rows=await query<PendingReceiptRow>(settings,`${RECEIPT_SELECT} where r.owner_id=$1::uuid and r.activation_of is null ${before?"and (r.imported_at,r.id)<($2::timestamptz,$3)":""} order by r.imported_at desc,r.id desc limit 10`,before?[ownerId,before.at,before.id]:[ownerId]);
  const [children,current]=await Promise.all([childReceipts(settings,ownerId,rows.map(row=>row.id)),currentIds(settings,ownerId)]);
  const items=[];
  for(const row of rows)items.push(pendingItemFromReceipt(row,listedArchive(row),children.filter(child=>child.activation_of===row.id),current));
  const last=rows.at(-1);return {items,nextCursor:rows.length===10&&last?Buffer.from(JSON.stringify({at:iso(last.imported_at),id:last.id})).toString("base64url"):null};
}
export async function pendingFinanceDataDetails(settings:SupabaseSettings,ownerId:string,receiptId:string) {
  const row=await loadPendingReceipt(settings,ownerId,receiptId);const archive=await validateStoredArchive(row);
  const [children,current]=await Promise.all([childReceipts(settings,ownerId,[row.id]),currentIds(settings,ownerId)]);
  return {item:pendingItemFromReceipt(row,archive,children,current),manifest:archive.manifest,datasets:scrubNativeOwnership(archive.datasets),redactions:["Structured credentials, tokens, sessions, push keys, owner IDs and machine paths are excluded from this view and the downloadable copy. Original financial values, record identities and relationships remain saved."]};
}
export async function downloadPendingFinanceData(settings:SupabaseSettings,ownerId:string,receiptId:string) {
  const row=await loadPendingReceipt(settings,ownerId,receiptId);const archive=await validateStoredArchive(row);
  const bytes=await createArchive({sourceApp:archive.manifest.sourceApp,namespace:archive.manifest.namespace,timezone:archive.manifest.timezone,currency:archive.manifest.currency,exportedAt:archive.manifest.exportedAt,datasets:scrubNativeOwnership(archive.datasets) as Datasets,coverage:[...archive.manifest.coverage,{dataset:"stored-source-provenance",status:"preserved",reason:`Safe downloadable copy of source archive ${archive.archiveId}, saved on receipt ${row.id}. Structured credentials and source ownership fields are excluded; checksums cover this copy.`}]});
  return {bytes,archiveId:archive.archiveId,receiptId:row.id};
}
export async function previewPendingFinanceActivation(settings:SupabaseSettings,ownerId:string,receiptId:string,now=new Date()) {
  const row=await loadPendingReceipt(settings,ownerId,receiptId);const archive=await validateStoredArchive(row);
  if(row.undone_at!==null)return {status:"blocked" as const,text:"This import was undone. Its source data remains available to inspect and download; activation requires an active source import.",conflicts:["The source import was undone."],pendingDomains:pendingDomainsForArchive(archive,[row])};
  const preview=await prepareFinanceImport(settings,ownerId,archive,now,row.id);
  if(preview.activationStatus==="ready")return {status:"ready" as const,preview};
  return {status:preview.activationStatus,text:preview.activationStatus==="nothing_new"?"The current adapters have no newly supported records to activate. Your saved data remains available; future feature support is not promised automatically.":"Saved data needs review before activation. Existing records will not be overwritten.",conflicts:preview.conflicts,pendingDomains:pendingDomainsForArchive(archive,[row])};
}
