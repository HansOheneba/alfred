import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalStringify } from "../../portability/archive.mjs";
import { planNativeAccountRules, type NativeRuleContext, type NativeAccountRulePlan } from "./native-account-rules";
import type { AlfredNativeExport, ExportCoverage } from "./export";

export type NativeRestoreInput = { schema: 1; tables: Record<string, Record<string, unknown>[]>; retainedArchives?: unknown[]; accountRules?: {revision:number;rules:unknown[];bindings:unknown[]}; settings?: { profile?: Record<string, unknown> | null; reminderPreferences?: Record<string, unknown> | null } };
export type NativeRestoreSource = { namespace: string; native: NativeRestoreInput; coverage?: ExportCoverage[]; warnings?: string[];accountReferences?:import("./native-sources").NativeAccountReference[] };
export const NATIVE_TABLES = {
  budgets: { source: "budgets", key: "budget_id" }, savings_goals: { source: "savingsGoals", key: "goal_id" },
  bills: { source: "bills", key: "id" }, investments: { source: "investments", key: "id" },
  investment_holdings: { source: "investmentHoldings", key: "id" }, investment_values: { source: "investmentValues", key: "id" },
  investment_contributions: { source: "investmentContributions", key: "id" }, loans: { source: "loans", key: "id" },
  people: { source: "people", key: "person_key" }, payee_rules: { source: "payeeRules", key: "payee_key" },
  about_me: { source: "aboutMe", key: "id" }, messages: { source: "messages", key: "id" },
} as const;
export type NativeTable = keyof typeof NATIVE_TABLES;
export type NativeCounts = Record<NativeTable, number> & {account_rules:number;account_bindings:number};
export type NativeOrigin = { table: NativeTable; recordKey: string; namespace: string; sourceKey: string };
export type NativePlan = { tables: Record<NativeTable, Record<string, unknown>[]>; origins: NativeOrigin[]; profileChanges: Record<string, unknown>; reminderChanges: Record<string, unknown>; accountRules?: NativeAccountRulePlan };
export type NativeSummary = { counts: NativeCounts; additions: NativeCounts; duplicateCounts: NativeCounts; duplicates: number; conflicts: string[]; coverage: ExportCoverage[]; settings: { applied: string[]; preserved: string[]; conflicts: string[] } };

const text = (max: number, minimum = 1) => z.string().refine((value) => {const chars=Array.from(value);return chars.length>=minimum && chars.length<=max && !value.includes("\u0000") && !chars.some((char)=>{const point=char.codePointAt(0)!;return point>=0xD800&&point<=0xDFFF;});});
const currency = z.string().regex(/^[A-Z]{3}$/);
const validDay = (value:string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !value.startsWith("0000-") && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0,10)===value;
const day = z.string().refine(validDay);
function validInstant(value:string) {
  const parts=/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if(!parts || !validDay(parts[1]) || Number(parts[2])>23 || Number(parts[3])>59 || Number(parts[4])>59) return false;
  if(parts[5]!=="Z" && (Number(parts[5].slice(1,3))>23 || Number(parts[5].slice(4,6))>59)) return false;
  const parsed=Date.parse(value);if(!Number.isFinite(parsed))return false;
  return /^[0-9]{4}-/.test(new Date(parsed).toISOString()) && !new Date(parsed).toISOString().startsWith("0000-");
}
export function canonicalNativeTimestamp(value: string) {
  const fraction = /\.(\d+)(?:Z|[+-]\d\d:\d\d)$/.exec(value)?.[1] ?? "";
  return `${new Date(value).toISOString().slice(0,19)}.${fraction.padEnd(6,"0").slice(0,6)}Z`;
}
const instant = z.string().refine(validInstant).transform(canonicalNativeTimestamp);
function decimal(precision: number, scale: number, options: { positive?: boolean; nonzero?: boolean; signed?: boolean; max?: string } = {}) {
  return z.string().regex(new RegExp(`^${options.signed ? "-?" : ""}\\d{1,${precision-scale}}(?:\\.\\d{1,${scale}})?$`)).refine((value) => {
    let n:bigint;try{n=BigInt(value.replace("-", "").replace(".", "").replace(/^0+/, "") || "0");}catch{return false;}
    return (!options.positive && !options.nonzero || n !== BigInt(0)) && (!options.max || Number(value) <= Number(options.max));
  }).transform((value) => {
    const negative = value.startsWith("-"); const [whole, fraction = ""] = value.replace("-", "").split(".");
    return `${negative && BigInt(`${whole}${fraction}`) !== BigInt(0) ? "-" : ""}${BigInt(whole)}.${fraction.padEnd(scale,"0")}`;
  });
}
const uuid = z.string().regex(/^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/);
const schemas: Record<NativeTable, z.ZodType<Record<string, unknown>>> = {
  budgets: z.object({ budget_id: text(200), period: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/), category: text(120), amount: decimal(12,2,{max:"9999999.99"}), currency, created_at: instant, updated_at: instant }),
  savings_goals: z.object({ goal_id: text(200), name: text(200), target_amount: decimal(12,2,{max:"9999999.99"}), current_amount: decimal(12,2,{max:"9999999.99"}), currency, target_date: z.union([z.literal(""), day]), status: z.enum(["active","completed","deleted"]), created_at: instant, updated_at: instant }),
  bills: z.object({ id: uuid, name: text(80), next_date: day, amount: decimal(16,2,{positive:true}).nullable(), currency, cadence: z.enum(["once","weekly","monthly","yearly"]), active: z.boolean(), reminded_for: day.nullable(), created_at: instant, updated_at: instant }),
  investments: z.object({ id: uuid, name: text(80), kind: z.enum(["us_stocks","gse_stocks","tbill","fixed_deposit","bond","mutual_fund","pension","crypto","other"]), provider: text(80,0), currency, invested_before: decimal(16,2), principal: decimal(16,2,{positive:true}).nullable(), rate: decimal(7,4,{max:"200"}).nullable(), started_on: day.nullable(), matures_on: day.nullable(), reminded_at: instant.nullable(), payee_key: text(120).nullable(), status: z.enum(["active","closed"]), import_notifications_paused: z.boolean().optional().default(false), import_cost_basis_unknown: z.boolean().optional().default(false), created_at: instant, updated_at: instant }),
  investment_holdings: z.object({ id: uuid, investment_id: uuid, symbol: z.string().regex(/^[A-Z0-9.:-]{1,16}$/), quantity: decimal(20,6), cost: decimal(16,2).nullable(), updated_at: instant }),
  investment_values: z.object({ id: uuid, investment_id: uuid, value: decimal(16,2), as_of: instant, source: z.enum(["reported","screenshot"]), created_at: instant }),
  investment_contributions: z.object({ id: uuid, investment_id: uuid, amount: decimal(16,2,{nonzero:true,signed:true}), currency, occurred_on: day, bank_message_id: uuid.nullable(), note: text(200,0), created_at: instant }),
  loans: z.object({ id: uuid, person: text(120), person_key: text(120), kind: z.enum(["lent","repaid","borrowed","paid_back"]), amount: decimal(12,2,{positive:true}), currency, occurred_at: instant, note: text(200,0), bank_message_id: uuid.nullable(), created_at: instant }),
  people: z.object({ person_key: text(120), name: text(120), note: text(300), updated_at: instant }),
  payee_rules: z.object({ payee_key: text(120), category: text(120), description: text(400,0), kind: z.enum(["category","chip_in","investment"]), updated_at: instant }),
  about_me: z.object({ id: uuid, note: text(300), account: z.string().regex(/^\d{3,4}$/).nullable(), created_at: instant }),
  messages: z.object({ id: uuid, channel: z.enum(["web","telegram"]), role: z.enum(["user","assistant"]), body: text(4000), created_at: instant, client_id: z.string().min(8).max(80).nullable(), intent: text(40).nullable(), meta: z.unknown().nullable() }),
};
const emptyCounts = () => Object.fromEntries([...Object.keys(NATIVE_TABLES),"account_rules","account_bindings"].map((table) => [table,0])) as NativeCounts;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function stableUuid(value: string) { const raw = hash(value).slice(0,32); return `${raw.slice(0,8)}-${raw.slice(8,12)}-5${raw.slice(13,16)}-a${raw.slice(17,20)}-${raw.slice(20)}`; }
const comparable = (row: Record<string, unknown>) => canonicalStringify(row);
const PROFILE_DEFAULTS = { preferred_name: "", currency: "GHS", timezone: "Africa/Accra", communication_preference: "concise", financial_goals: "" } as const;
const PROFILE_SCHEMA = { preferred_name: text(80,0), currency, timezone: text(80).refine((value) => {try { new Intl.DateTimeFormat("en",{timeZone:value});return true;}catch{return false;}}), communication_preference: z.enum(["concise","detailed"]), financial_goals: text(2000,0) };
const REMINDER_DEFAULTS = { morning_minute:480,commute_minute:510,evening_minute:1200 };

/** Restores only existing native features. No executable actions or raw cash-source rows are replayed. */
export function planNativeRestoration(current: AlfredNativeExport, sources: NativeRestoreSource[], destinationNamespace: string, now: string,ruleContext?:NativeRuleContext) {
  void now;
  const plan: NativePlan = { tables:Object.fromEntries(Object.keys(NATIVE_TABLES).map((table)=>[table,[]])) as unknown as NativePlan["tables"],origins:[],profileChanges:{},reminderChanges:{} };
  const summary: NativeSummary = { counts:emptyCounts(),additions:emptyCounts(),duplicateCounts:emptyCounts(),duplicates:0,conflicts:[],coverage:[],settings:{applied:[],preserved:[],conflicts:[]} };
  const warnings: string[] = [];
  const existing = Object.fromEntries(Object.entries(NATIVE_TABLES).map(([table, definition]) => [table,new Map((current.tables[definition.source] ?? []).map((row) => [String(row[definition.key]),row]))])) as Record<NativeTable,Map<string,Record<string,unknown>>>;
  const uniqueKey = (table:NativeTable,row:Record<string,unknown>) => table==="budgets" ? canonicalStringify([row.period,row.category,row.currency]) : table==="investments" && row.status==="active" ? String(row.name).toLowerCase() : table==="investment_holdings" ? canonicalStringify([row.investment_id,row.symbol]) : null;
  const uniqueKeys=Object.fromEntries(Object.keys(NATIVE_TABLES).map((table)=>[table,new Set([...existing[table as NativeTable].values()].map(row=>uniqueKey(table as NativeTable,row)).filter((key)=>key!==null))])) as Record<NativeTable,Set<string>>;
  const staged = Object.fromEntries(Object.keys(NATIVE_TABLES).map((table)=>[table,new Map<string,Record<string,unknown>>()])) as Record<NativeTable,Map<string,Record<string,unknown>>>;
  for (const source of sources) {
    if (!source.native || source.native.schema !== 1 || !source.native.tables || typeof source.native.tables !== "object" || Object.values(source.native.tables).some((rows)=>!Array.isArray(rows))) {summary.conflicts.push("The Alfred native dataset has an unsupported or invalid schema.");continue;}
    warnings.push(...source.warnings ?? []);
    summary.coverage.push(...source.coverage ?? []);
    const identity = (table:NativeTable,row:Record<string,unknown>) => {
      const definition=NATIVE_TABLES[table]; const sourceKey=String(row[definition.key]);
      const origin=row.importProvenance as {namespace?:unknown;sourceId?:unknown}|undefined;
      const namespace=origin?.namespace ?? source.namespace; const originalKey=origin?.sourceId ?? sourceKey;
      if(typeof namespace!=="string" || !namespace || namespace.length>300 || typeof originalKey!=="string" || !originalKey || originalKey.length>512) throw new Error("Invalid native provenance.");
      const natural = table === "people" || table === "payee_rules";
      const target=natural ? sourceKey : namespace===destinationNamespace ? originalKey : table==="budgets" || table==="savings_goals" ? `import:${hash(`${destinationNamespace}:${table}:${namespace}:${originalKey}`).slice(0,40)}` : stableUuid(`${destinationNamespace}:${table}:${namespace}:${originalKey}`);
      return {target,origin:{table,recordKey:target,namespace,sourceKey:originalKey} as NativeOrigin};
    };
    const investmentIds = new Map<string,string>();
    for(const row of source.native.tables.investments ?? []) {try{investmentIds.set(String(row.id),identity("investments",row).target);}catch{/* The row loop reports invalid provenance without throwing outside validation. */}}
    for(const [table,definition] of Object.entries(NATIVE_TABLES) as [NativeTable,typeof NATIVE_TABLES[NativeTable]][]) {
      const records=source.native.tables[definition.source] ?? [];
      if(!Array.isArray(records)) {summary.conflicts.push(`${definition.source}: expected an array of native records.`);continue;}
      let preserved=0;
      for(const raw of records) {
        summary.counts[table]++;
        const parsed=schemas[table].safeParse(raw);
        if(!parsed.success) {summary.conflicts.push(`${definition.source}: an invalid native record cannot be restored (${parsed.error.issues[0]?.path.join(".") || "schema"}).`);continue;}
        const row=parsed.data;
        if(table==="about_me" && row.account!==null) {preserved++;continue;}
        let origin:NativeOrigin;
        try {const identified=identity(table,raw);row[definition.key]=identified.target;origin=identified.origin;}catch{summary.conflicts.push(`${definition.source}: invalid native provenance.`);continue;}
        if(table.startsWith("investment_") && row.investment_id!==undefined) {const parent=investmentIds.get(String(row.investment_id));if(!parent){summary.conflicts.push(`${definition.source}: missing investment parent.`);continue;}row.investment_id=parent;}
        if(table==="bills") {row.active=false;row.reminded_for=null;}
        if(table==="investments") {row.import_notifications_paused=true;row.reminded_at=null;}
        if(table==="investment_contributions" || table==="loans") row.bank_message_id=null;
        if(table==="messages") row.client_id=null;
        if(!schemas[table].safeParse(row).success) {summary.conflicts.push(`${definition.source}: mapped identity or references are invalid.`);continue;}
        const key=String(row[definition.key]); const previous=staged[table].get(key) ?? existing[table].get(key);
        if(previous) {
          const normalized=schemas[table].safeParse(previous);
          if(normalized.success && comparable(normalized.data)===comparable(row)) {summary.duplicates++;summary.duplicateCounts[table]++;}
          else summary.conflicts.push(`${definition.source}: record ${key} differs from an existing destination record. Nothing will be overwritten.`);
          continue;
        }
        // Natural unique constraints must be previewed even when stable IDs differ.
        const naturalKey=uniqueKey(table,row);
        const collision=naturalKey!==null && uniqueKeys[table].has(naturalKey);
        if(collision) {summary.conflicts.push(`${definition.source}: a different destination record already uses this feature's unique name or category.`);continue;}
        staged[table].set(key,row);if(naturalKey!==null) uniqueKeys[table].add(naturalKey);plan.tables[table].push(row);plan.origins.push(origin);summary.additions[table]++;
      }
      if(records.length) summary.coverage.push({dataset:`alfred.native.${definition.source}`,status:"supported",count:records.length-preserved,reason:table==="bills"?"Restored into Bills paused. Existing Resume controls explicitly enable future bill reminders.":table==="investments"?"Restored with financial status intact and investment notifications paused until explicitly resumed.":table==="investment_contributions"||table==="loans"?"Restored into the existing feature. Historical bank links remain in the source archive; active bank-message foreign keys are not replayed.":table==="messages"?"Owned historical messages restored to the destination conversation. Client delivery IDs are not replayed.":"Restored into the existing native feature with stable identities and no overwrite."});
      if(preserved) summary.coverage.push({dataset:"alfred.native.aboutMe.account-exclusions",status:"preserved",count:preserved,reason:"Account exclusion notes affect future SMS filtering and are retained as evidence without changing collection rules."});
    }
    const incomingProfile=source.native.settings?.profile;
    if(incomingProfile) {
      for(const [field,defaultValue] of Object.entries(PROFILE_DEFAULTS)) {
        if(incomingProfile[field]===undefined) continue;
        const parsed=PROFILE_SCHEMA[field as keyof typeof PROFILE_SCHEMA].safeParse(incomingProfile[field]);
        if(!parsed.success) {summary.settings.conflicts.push(`profile.${field}: invalid setting.`);continue;}
        const value=parsed.data;const currentValue=plan.profileChanges[field] ?? current.settings.profile?.[field as keyof typeof PROFILE_DEFAULTS] ?? defaultValue;
        if(value===currentValue) continue;
        if(currentValue!==defaultValue) {summary.settings.preserved.push(`profile.${field}: your current choice is kept; the imported value is not applied.`);continue;}
        plan.profileChanges[field]=value;summary.settings.applied.push(`profile.${field}`);
      }
      if(incomingProfile.account_names) summary.settings.preserved.push("profile.account_names: account-name matching affects future bank classification and is preserved without changing destination collection rules.");
    }
    const reminders=source.native.settings?.reminderPreferences;
    if(reminders) {
      for(const [field,defaultValue] of Object.entries(REMINDER_DEFAULTS)) {
        if(reminders[field]===undefined) continue;
        const value=reminders[field];const currentValue=plan.reminderChanges[field] ?? current.settings.reminderPreferences?.[field] ?? defaultValue;
        if(!Number.isInteger(value) || Number(value)<0 || Number(value)>1439) {summary.settings.conflicts.push(`reminders.${field}: invalid time.`);continue;}
        if(value===currentValue) continue;
        if(currentValue!==defaultValue) {summary.settings.preserved.push(`reminders.${field}: your current choice is kept; the imported value is not applied.`);continue;}
        plan.reminderChanges[field]=value;summary.settings.applied.push(`reminders.${field}`);
      }
      summary.settings.preserved.push("Reminder enable flags and delivery markers are retained as evidence. Import never enables notifications.");
    }
    if(source.native.retainedArchives?.length) summary.coverage.push({dataset:"alfred.native.retainedArchives",status:"preserved",count:source.native.retainedArchives.length,reason:"Prior import archives and their source provenance remain intact as receipt evidence; historical import operations are not executed again."});
    const supported=new Set(Object.values(NATIVE_TABLES).map((item)=>item.source));
    for(const [key,rows] of Object.entries(source.native.tables)) if(!supported.has(key as typeof NATIVE_TABLES[NativeTable]["source"]) && rows.length) summary.coverage.push({dataset:`alfred.native.${key}`,status:"preserved",count:rows.length,reason:key==="customCategories"?"Custom category definitions are retained as native evidence. Automatic category restoration is unsupported; recreate these categories manually in the destination to use them.":key==="bankPaymentResolutions"?"Explicit payment-resolution reasons, source evidence and returned-principal audit links are retained in the receipt and future exports. Supported excluded movements and refund links restore through the accounting core; historical bank-message IDs and resolution actions are not replayed.":"Raw cash source, accounting audit, undo or operational evidence is retained. It is not replayed over the shared accounting core."});
  }
  const rules=planNativeAccountRules(current,sources,ruleContext);
  if(rules.plan)plan.accountRules=rules.plan;
  Object.assign(summary.counts,rules.counts);Object.assign(summary.additions,rules.additions);Object.assign(summary.duplicateCounts,rules.duplicates);summary.duplicates+=rules.duplicates.account_rules+rules.duplicates.account_bindings;
  summary.conflicts.push(...rules.conflicts);summary.coverage.push(...rules.coverage);warnings.push(...rules.warnings);
  // Only invalid settings block an import. A differing destination choice is simply kept.
  summary.conflicts.push(...summary.settings.conflicts);
  if(summary.settings.applied.length) summary.coverage.push({dataset:"alfred.native.settings.safe-defaults",status:"supported",count:summary.settings.applied.length,reason:"Only safe default destination fields receive imported values; non-default destination settings are never overwritten."});
  if(summary.settings.preserved.length) summary.coverage.push({dataset:"alfred.native.settings.notification-and-source-controls",status:"preserved",count:summary.settings.preserved.length,reason:summary.settings.preserved.join(" ")});
  if(summary.counts.bills) warnings.push("Imported bills start paused. Resume them in Bills to enable scheduling and reminders.");
  if(summary.counts.investments) warnings.push("Investment financial records are restored with notifications paused. Resuming notices is a separate explicit action.");
  return {plan,summary,warnings};
}
