import {createHash} from "node:crypto";
import {z} from "zod";
import {canonicalStringify} from "../../portability/archive.mjs";
import {emptyAccountRuleState,normalizeRuleText,type AccountRule,type AccountBinding,type AccountRuleState} from "@/lib/account-rules/types";
import type {AlfredNativeExport,ExportCoverage} from "./export";
import type {NativeRestoreSource} from "./native-restoration";
export type NativeRuleContext={ownerId:string;previewId:string;accountIdMap:Map<string,string>;destinationNamespace:string;accountProvenanceMap?:Map<string,string>};
export type NativeAccountRulePlan={expectedRevision:number;state:AccountRuleState;requestId:string;fingerprint:string};
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
const uuid=z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
const stamp=z.iso.datetime({offset:true}).refine(value=>Number.isFinite(Date.parse(value)));
const revision=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const ruleSchema=z.object({id:uuid,accountId:z.string().min(1).max(512),matchMode:z.enum(["exact","all"]),merchantExact:z.string().min(1).max(2000).nullable(),direction:z.enum(["in","out","any"]),category:z.string().trim().min(1).max(120),active:z.boolean(),priority:z.number().int().min(-1000).max(1000),effectiveFrom:stamp,createdAt:stamp,revision});
const bindingSchema=z.object({id:uuid,accountId:z.string().min(1).max(512),provider:z.string().trim().min(1).max(120),accountSuffix:z.string().regex(/^\d{3,4}$/),currency:z.string().regex(/^[A-Z]{3}$/),active:z.boolean(),createdAt:stamp,revision});
const identity=(namespace:string,sourceId:string,destination:string)=>{if(namespace===destination)return sourceId;const hash=createHash("sha256").update(`${destination}:account-rule:${namespace}:${sourceId}`).digest("hex");return`${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;};
const comparable=(row:AccountRule|AccountBinding)=>{const {revision:_revision,importProvenance:_origin,...semantic}=row;void _revision;void _origin;return canonicalStringify(semantic);};

export function planNativeAccountRules(current:AlfredNativeExport,sources:NativeRestoreSource[],context?:NativeRuleContext) {
 const currentDocument=current.tables.accountRuleStates?.[0]?.state;
 const prior=object(currentDocument)?structuredClone(currentDocument) as unknown as AccountRuleState:emptyAccountRuleState(context?.ownerId??"unassigned");
 const conflicts:string[]=[];const warnings:string[]=[];const coverage:ExportCoverage[]=[];
 const pending={account_rules:0,account_bindings:0};
 const counts={account_rules:0,account_bindings:0},additions={account_rules:0,account_bindings:0},duplicates={account_rules:0,account_bindings:0};
 if(context)prior.ownerId=context.ownerId;
 const next:AccountRuleState={...prior,rules:[...prior.rules],bindings:[...prior.bindings]};
 for(const source of sources) {
  const native=source.native as unknown as Record<string,unknown>;
  const tables=object(native.tables)?native.tables:{};
  const saved=Array.isArray(tables.accountRuleStates)?tables.accountRuleStates[0]:undefined;
  const input=object(native.accountRules)?native.accountRules:object(saved)&&object(saved.state)?saved.state:null;
  if(!input)continue;
  if(!Array.isArray(input.rules)||!Array.isArray(input.bindings)||!Number.isSafeInteger(input.revision)||Number(input.revision)<0) {conflicts.push("Account rules have an invalid native state.");continue;}
  for(const kind of ["rules","bindings"] as const)for(const raw of input[kind] as unknown[]) {
   const counter=kind==="rules"?"account_rules":"account_bindings";counts[counter]++;
   if(!context){pending[counter]++;continue;}
   const parsed=(kind==="rules"?ruleSchema:bindingSchema).safeParse(raw);if(!parsed.success||!object(raw)){conflicts.push(`Account ${kind}: an invalid record cannot be activated.`);continue;}
   const reference=source.accountReferences?.find(item=>item.id===parsed.data.accountId);
   const accountId=source.accountReferences ? reference?context.accountProvenanceMap?.get(`${reference.namespace}\0${reference.sourceId}`):undefined : context.accountIdMap.get(parsed.data.accountId);if(!accountId){pending[counter]++;continue;}
   const supplied=object(raw.importProvenance)?raw.importProvenance:{};
   const namespace=typeof supplied.namespace==="string"?supplied.namespace:source.namespace;const sourceId=typeof supplied.sourceId==="string"?supplied.sourceId:parsed.data.id;
   if(!namespace||namespace.length>300||!sourceId||sourceId.length>512){conflicts.push(`Account ${kind}: invalid source provenance.`);continue;}
   const row={...parsed.data,id:identity(namespace,sourceId,context.destinationNamespace),accountId,revision:prior.revision+1,importProvenance:{namespace,sourceId}};
   if(!uuid.safeParse(row.id).success){conflicts.push(`Account ${kind}: invalid mapped identity.`);continue;}
   if(kind==="rules") {
    const rule=row as AccountRule;rule.merchantExact=rule.matchMode==="all"?null:rule.merchantExact===null?null:normalizeRuleText(rule.merchantExact);
    if(rule.matchMode==="exact"&&!rule.merchantExact||rule.matchMode==="all"&&raw.merchantExact!==null){conflicts.push("Account rule merchant scope is invalid; no all-account rule is inferred.");continue;}
    const existing=next.rules.find(item=>item.id===rule.id);
    if(existing){if(comparable(existing)===comparable(rule))duplicates[counter]++;else conflicts.push("An imported account rule differs from an existing rule. No rule will be overwritten.");continue;}
    if(next.rules.some(item=>item.accountId===rule.accountId&&item.matchMode===rule.matchMode&&normalizeRuleText(item.merchantExact??"")===normalizeRuleText(rule.merchantExact??"")&&item.direction===rule.direction)){conflicts.push("Another destination rule already uses this exact account and merchant scope.");continue;}
    next.rules.push(rule);additions[counter]++;
   } else {
    const binding=row as AccountBinding;binding.provider=normalizeRuleText(binding.provider);
    const existing=next.bindings.find(item=>item.id===binding.id);
    if(existing){if(comparable(existing)===comparable(binding))duplicates[counter]++;else conflicts.push("An imported account binding differs from an existing binding. It will not be overwritten.");continue;}
    if(next.bindings.some(item=>normalizeRuleText(item.provider)===binding.provider&&item.accountSuffix===binding.accountSuffix&&item.currency===binding.currency)){conflicts.push("Another binding already claims this provider, account suffix and currency. No provider-wide account is inferred.");continue;}
    next.bindings.push(binding);additions[counter]++;
   }
  }
 }
 if(next.rules.length>1000||next.bindings.length>100)conflicts.push("Imported account rules or explicit bindings exceed the supported limits.");
 if(pending.account_rules+pending.account_bindings) {coverage.push({dataset:"alfred.native.accountRules.awaitingAccountMapping",status:"preserved",count:pending.account_rules+pending.account_bindings,reason:"Valid rules or bindings without an exact imported account reference remain saved and awaiting account mapping. No provider label or account name is guessed."});warnings.push(`${pending.account_rules+pending.account_bindings} account rule or binding record(s) remain saved until an exact account mapping is available.`);}
 if(counts.account_rules>pending.account_rules)coverage.push({dataset:"alfred.native.accountRules",status:"supported",count:counts.account_rules-pending.account_rules,reason:"Account-specific rules are appended to the same durable store used by the app and bot. Stable account IDs, exact merchant scope, direction, ordering, source start dates and manual overrides are preserved."});
 if(counts.account_bindings>pending.account_bindings)coverage.push({dataset:"alfred.native.accountBindings",status:"supported",count:counts.account_bindings-pending.account_bindings,reason:"Only explicit provider, account suffix and currency bindings are restored. Provider labels alone never assign a financial account."});
 if(counts.account_rules)warnings.push("Account rules apply only to identified accounts. Future SMS account recognition needs an explicit provider, suffix and currency binding; no connection or broad provider match is guessed.");
 let plan:NativeAccountRulePlan|undefined;
 if(additions.account_rules+additions.account_bindings&&context){next.revision=prior.revision+1;const requestId=`import:${context.previewId}`;plan={expectedRevision:prior.revision,state:next,requestId,fingerprint:createHash("sha256").update(canonicalStringify(next)).digest("hex")};}
 return{plan,counts,additions,duplicates,conflicts,warnings,coverage};
}
