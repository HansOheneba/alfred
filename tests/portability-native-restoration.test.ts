import { describe, expect, it } from "vitest";
import { loanBalances, type LoanEntry } from "@/lib/finance/loans";
import { NATIVE_TABLES, planNativeRestoration, type NativeRestoreInput, type NativeRestoreSource } from "@/lib/portability/native-restoration";
import type { AlfredNativeExport } from "@/lib/portability/export";
const NOW="2026-11-02T12:00:00.123456+00:00";
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const defaults={preferred_name:"",currency:"GHS",timezone:"Africa/Accra",communication_preference:"concise",financial_goals:"",account_names:"",created_at:NOW,updated_at:NOW};
function destination():AlfredNativeExport{return{schema:1,tables:Object.fromEntries(Object.values(NATIVE_TABLES).map(item=>[item.source,[]])),settings:{profile:{...defaults},reminderPreferences:{morning_enabled:false,commute_enabled:false,evening_enabled:false,morning_minute:480,commute_minute:510,evening_minute:1200}},retainedArchives:[]};}
function fixture():NativeRestoreSource{return{namespace:"alfred:source",native:{schema:1,tables:{
 budgets:[{budget_id:"budget",period:"2026-11",category:"Food",amount:"1200.01",currency:"GHS",created_at:NOW,updated_at:NOW}],
 savingsGoals:[{goal_id:"goal",name:"Emergency",target_amount:"1000.00",current_amount:"200.01",currency:"GHS",target_date:"2027-01-01",status:"active",created_at:NOW,updated_at:NOW}],
 bills:[{id:id(1),name:"Rent",next_date:"2026-12-01",amount:"1200.00",currency:"GHS",cadence:"monthly",active:true,reminded_for:"2026-11-01",created_at:NOW,updated_at:NOW}],
 investments:[{id:id(2),name:"Savings fund",kind:"mutual_fund",provider:"Synthetic",currency:"GHS",invested_before:"900.00",principal:null,rate:null,started_on:null,matures_on:null,reminded_at:null,payee_key:"funding",status:"active",created_at:NOW,updated_at:NOW}],
 investmentHoldings:[{id:id(3),investment_id:id(2),symbol:"SYN",quantity:"1.123456",cost:"99.01",updated_at:NOW}],
 investmentValues:[{id:id(4),investment_id:id(2),value:"1000.02",as_of:NOW,source:"reported",created_at:NOW}],
 investmentContributions:[{id:id(5),investment_id:id(2),amount:"-10.25",currency:"GHS",occurred_on:"2026-11-01",bank_message_id:id(99),note:"Withdrawal",created_at:NOW}],
 loans:[{id:id(6),person:"Ama",person_key:"ama",kind:"borrowed",amount:"100.00",currency:"GHS",occurred_at:NOW,note:"Borrowed",bank_message_id:id(98),created_at:NOW}],
 people:[{person_key:"ama",name:"Ama",note:"Friend",updated_at:NOW}],payeeRules:[{payee_key:"funding",category:"Savings",description:"Savings fund",kind:"investment",updated_at:NOW}],
 aboutMe:[{id:id(7),note:"Paid on the 25th",account:null,created_at:NOW}],
 messages:[{id:id(8),channel:"web",role:"user",body:"Synthetic financial history",created_at:NOW,client_id:"original-client",intent:null,meta:{chart:{title:"Synthetic"}}}],
 transactions:[{id:"retained-raw",amount:"10.00"}],labelUndo:[{changes:[]}],
 },settings:{profile:{...defaults,preferred_name:"Synthetic person",financial_goals:"Save for a trip",account_names:"Original filter"},reminderPreferences:{morning_enabled:true,morning_minute:500}}}};}
function afterImport(plan:ReturnType<typeof planNativeRestoration>["plan"]):AlfredNativeExport {
 const current=destination();for(const [table,rows]of Object.entries(plan.tables)) current.tables[NATIVE_TABLES[table as keyof typeof NATIVE_TABLES].source]=rows.map(row=>({...row,importProvenance:{namespace:plan.origins.find(item=>item.table===table&&item.recordKey===String(row[NATIVE_TABLES[table as keyof typeof NATIVE_TABLES].key]))!.namespace,sourceId:plan.origins.find(item=>item.table===table&&item.recordKey===String(row[NATIVE_TABLES[table as keyof typeof NATIVE_TABLES].key]))!.sourceKey}}));
 Object.assign(current.settings.profile!,plan.profileChanges);Object.assign(current.settings.reminderPreferences!,plan.reminderChanges);return current;
}
describe("native existing-feature restoration",()=>{
 it("plans all 12 native domains, exact numerics and remapped relationships without mutating source",()=>{
  const source=fixture();const before=structuredClone(source);const result=planNativeRestoration(destination(),[source],"alfred:destination",NOW);
  expect(result.summary.conflicts).toEqual([]);for(const table of Object.keys(NATIVE_TABLES))expect(result.summary.additions[table as keyof typeof NATIVE_TABLES]).toBe(1);
  expect(result.plan.origins).toHaveLength(12);expect(result.plan.tables.investment_holdings[0]).toMatchObject({quantity:"1.123456",investment_id:result.plan.tables.investments[0].id});expect(result.plan.tables.investment_contributions[0]).toMatchObject({amount:"-10.25",bank_message_id:null});
  expect(result.plan.tables.bills[0]).toMatchObject({active:false,reminded_for:null});expect(result.plan.tables.investments[0]).toMatchObject({status:"active",import_notifications_paused:true,reminded_at:null});
  expect(result.plan.tables.messages[0]).toMatchObject({client_id:null,created_at:"2026-11-02T12:00:00.123456Z"});expect(result.plan.profileChanges).toEqual({preferred_name:"Synthetic person",financial_goals:"Save for a trip"});expect(result.plan.reminderChanges).toEqual({morning_minute:500});expect(result.summary.settings.preserved.join(" ")).toContain("enable flags");expect(source).toEqual(before);
 });
 it("recognizes every repeated native record using provenance and scopes opaque IDs per destination",()=>{
  const first=planNativeRestoration(destination(),[fixture()],"alfred:destination",NOW);const restored=afterImport(first.plan);
  const retry=planNativeRestoration(restored,[fixture()],"alfred:destination",NOW);expect(retry.summary.duplicates).toBe(12);expect(retry.summary.conflicts).toEqual([]);expect(retry.plan.origins).toEqual([]);
  const nextSource:NativeRestoreSource={namespace:"alfred:destination",native:restored as unknown as NativeRestoreInput};
  const hop=planNativeRestoration(restored,[nextSource],"alfred:destination",NOW);expect(hop.summary.duplicates).toBe(12);expect(hop.summary.conflicts).toEqual([]);
  const other=planNativeRestoration(destination(),[fixture()],"alfred:other-owner",NOW);expect(other.plan.tables.investments[0].id).not.toBe(first.plan.tables.investments[0].id);expect(other.plan.tables.budgets[0].budget_id).not.toBe(first.plan.tables.budgets[0].budget_id);expect(other.plan.tables.payee_rules[0].payee_key).toBe("funding");
 });
 it("detects natural feature conflicts and non-default settings before confirmation",()=>{
  const current=destination();current.tables.budgets=[{...fixture().native.tables.budgets[0],budget_id:"existing"}];current.settings.profile!.preferred_name="Existing person";current.settings.reminderPreferences!.morning_minute=600;
  const result=planNativeRestoration(current,[fixture()],"alfred:destination",NOW);expect(result.summary.conflicts.join(" ")).toContain("unique name or category");expect(result.summary.conflicts.join(" ")).toContain("non-default");expect(result.plan.profileChanges.preferred_name).toBeUndefined();expect(result.plan.reminderChanges.morning_minute).toBeUndefined();
 });
 it("preserves account filtering and operational records without activating them",()=>{
  const source=fixture();source.native.tables.aboutMe.push({id:id(9),note:"Managed account",account:"1234",created_at:NOW});
  const result=planNativeRestoration(destination(),[source],"alfred:destination",NOW);expect(result.plan.tables.about_me).toHaveLength(1);expect(result.summary.coverage).toEqual(expect.arrayContaining([expect.objectContaining({dataset:"alfred.native.aboutMe.account-exclusions",status:"preserved",count:1}),expect.objectContaining({dataset:"alfred.native.transactions",status:"preserved"})]));expect(result.plan.profileChanges.account_names).toBeUndefined();expect(result.plan.reminderChanges.morning_enabled).toBeUndefined();
 });
 it("rejects malformed native months, calendar dates and timestamps before staging",()=>{
  for(const change of [
    (source:NativeRestoreSource)=>{source.native.tables.budgets[0].period="2026-99";},
    (source:NativeRestoreSource)=>{source.native.tables.bills[0].next_date="2026-02-30";},
    (source:NativeRestoreSource)=>{source.native.tables.messages[0].created_at="2026-02-30T12:00:00Z";},
    (source:NativeRestoreSource)=>{source.native.tables.messages[0].created_at="2026-11-02T24:00:00Z";},
    (source:NativeRestoreSource)=>{source.native.tables.messages[0].created_at="2026-11-02T12:00:00+24:00";},
  ]) {const source=fixture();change(source);expect(planNativeRestoration(destination(),[source],"alfred:destination",NOW).summary.conflicts.length).toBeGreaterThan(0);}
 });
 it("preserves Unicode note boundaries according to PostgreSQL character limits",()=>{
  const source=fixture();source.native.tables.aboutMe[0].note="😀".repeat(300);
  const result=planNativeRestoration(destination(),[source],"alfred:destination",NOW);expect(result.summary.conflicts).toEqual([]);expect(result.plan.tables.about_me[0].note).toBe("😀".repeat(300));
 });
 it("validates native schema, values, provenance and parent references without silently committing invalid records",()=>{
  const source=fixture();source.native.tables.investmentHoldings[0].investment_id=id(999);source.native.tables.bills[0].amount="NaN";source.native.tables.loans[0].importProvenance={namespace:7,sourceId:"bad"};
  const result=planNativeRestoration(destination(),[source],"alfred:destination",NOW);expect(result.summary.conflicts).toHaveLength(3);expect(result.plan.tables.bills).toEqual([]);expect(result.plan.tables.investment_holdings).toEqual([]);expect(result.plan.tables.loans).toEqual([]);
 });
 it("preserves native loanBalances for borrowing, repayments and money lent without creating cash transactions",()=>{
  const source=fixture();source.native.tables.loans=[
   {...source.native.tables.loans[0],kind:"lent",amount:"100.00"},{...source.native.tables.loans[0],id:id(20),kind:"repaid",amount:"40.00"},
   {...source.native.tables.loans[0],id:id(21),kind:"borrowed",amount:"90.00"},{...source.native.tables.loans[0],id:id(22),kind:"paid_back",amount:"30.00"}];
  const result=planNativeRestoration(destination(),[source],"alfred:destination",NOW);
  const entries=(rows:Record<string,unknown>[])=>rows.map(row=>({id:row.id,person:row.person,personKey:row.person_key,kind:row.kind,amount:row.amount,currency:row.currency,occurredAt:row.occurred_at,note:row.note,bankMessageId:null})) as LoanEntry[];
  const before=loanBalances(entries(source.native.tables.loans));const after=loanBalances(entries(result.plan.tables.loans));expect(after.map(row=>({owed:row.owed,owe:row.owe}))).toEqual(before.map(row=>({owed:row.owed,owe:row.owe})));expect(after[0]).toMatchObject({owed:"60.00",owe:"60.00"});expect(Object.keys(result.plan.tables)).not.toContain("transactions");
 });
});
