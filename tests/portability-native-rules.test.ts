import {describe,expect,it} from "vitest";
import {planNativeAccountRules,type NativeRuleContext} from "@/lib/portability/native-account-rules";
import {collectNativeRestoreSources} from "@/lib/portability/native-sources";
import type {AlfredNativeExport} from "@/lib/portability/export";
import type {NativeRestoreSource} from "@/lib/portability/native-restoration";
import type {ImportArchive} from "@/lib/portability/model";
const NOW="2026-11-02T12:00:00.000Z",ID="00000000-0000-4000-8000-000000000001";
const empty=():AlfredNativeExport=>({schema:1,tables:{accountRuleStates:[]},settings:{profile:null,reminderPreferences:null},retainedArchives:[]});
const source=():NativeRestoreSource=>({namespace:"money:source",native:{schema:1,tables:{},accountRules:{revision:0,rules:[{id:ID,accountId:"source-account",matchMode:"exact",merchantExact:"  MARKET   SHOP ",direction:"out",category:"Food",active:true,priority:1000,effectiveFrom:NOW,createdAt:NOW,revision:0}],bindings:[]}}});
const context:NativeRuleContext={ownerId:"target-owner",previewId:"preview",destinationNamespace:"alfred:target",accountIdMap:new Map([["source-account","target-account"]]),accountProvenanceMap:new Map([["money:source\0source-account","target-account"]])};
describe("native account-rule append plans",()=>{
 it("remaps exact account and rule IDs while retaining scope, dates, ordering and source evidence",()=>{
  const input=source();const before=structuredClone(input);const result=planNativeAccountRules(empty(),[input],context);expect(result.conflicts).toEqual([]);expect(result.additions.account_rules).toBe(1);expect(result.plan?.state.rules[0]).toMatchObject({accountId:"target-account",merchantExact:"market shop",direction:"out",priority:1000,effectiveFrom:NOW,revision:1,importProvenance:{namespace:"money:source",sourceId:ID}});expect(result.plan?.state.rules[0].id).not.toBe(ID);expect(result.plan?.state.ownerId).toBe("target-owner");expect(input).toEqual(before);
 });
 it("recognizes unchanged rules across global revision changes and blocks edited records",()=>{
  const first=planNativeAccountRules(empty(),[source()],context);const current=empty();current.tables.accountRuleStates=[{state:first.plan!.state}];
  const repeated=planNativeAccountRules(current,[source()],{...context,previewId:"retry"});expect(repeated.duplicates.account_rules).toBe(1);expect(repeated.plan).toBeUndefined();
  const changed=source();(changed.native.accountRules!.rules[0] as {category:string}).category="Other";const conflict=planNativeAccountRules(current,[changed],context);expect(conflict.conflicts[0]).toContain("will be overwritten");expect(conflict.plan).toBeUndefined();
 });
 it("preserves current aggregate rows byte-for-field and never substitutes provider labels for account mappings",()=>{
  const current=empty();const prior={id:"00000000-0000-4000-8000-000000000099",accountId:"another",matchMode:"exact" as const,merchantExact:"existing",direction:"out" as const,category:"Other",active:true,priority:0,effectiveFrom:NOW,createdAt:NOW,revision:4};current.tables.accountRuleStates=[{state:{ownerId:"target-owner",revision:4,rules:[prior],bindings:[]}}];
  const append=planNativeAccountRules(current,[source()],context);expect(append.plan!.state.rules[0]).toEqual(prior);expect(append.plan!.state.revision).toBe(5);
  const unavailable=planNativeAccountRules(current,[source()],{...context,accountIdMap:new Map()});expect(unavailable.plan).toBeUndefined();expect(unavailable.conflicts).toEqual([]);expect(unavailable.coverage.find(item=>item.status==="preserved")?.reason).toContain("without an exact imported account reference");
 });
 it("uses namespace-qualified outer account provenance when recovering rules through another app",()=>{
  const input=source();input.accountReferences=[{id:"source-account",namespace:"money:source",sourceId:"source-account"}];
  expect(planNativeAccountRules(empty(),[input],context).additions.account_rules).toBe(1);
  input.accountReferences[0].namespace="unrelated:owner";expect(planNativeAccountRules(empty(),[input],context).plan).toBeUndefined();
 });
});
const archive=(datasets:Record<string,unknown>):ImportArchive=>({archiveId:"fixture",manifest:{namespace:"money:outer",sourceApp:"money-tracker",exportedAt:NOW,coverage:[]},datasets});
const nativeGoal={schema:1,tables:{savingsGoals:[{goal_id:"original-goal",name:"Saved goal"}]}};
describe("bounded recognized native archive wrappers",()=>{
 it("recovers supported native feature records without replaying a nested cash core or arbitrary object paths",()=>{
  const nested={sourceManifest:{namespace:"alfred:source",exportedAt:NOW},datasets:{"alfred.native":nativeGoal,movements:[{id:"must-not-replay"}]}};
  const sources=collectNativeRestoreSources(archive({preservedArchives:[nested,nested],arbitrary:{deep:nested}}));expect(sources).toHaveLength(1);expect(sources[0].native.tables.savingsGoals).toHaveLength(1);expect((sources[0] as unknown as Record<string,unknown>).movements).toBeUndefined();expect(collectNativeRestoreSources(archive({arbitrary:{deep:nested}}))).toEqual([]);
 });
 it("keeps the newest complete namespace snapshot and respects an authoritative outer Alfred snapshot",()=>{
  const old={manifest:{namespace:"alfred:source",exportedAt:"2026-11-01T12:00:00Z"},datasets:{"alfred.native":nativeGoal}};const latest={sourceManifest:{namespace:"alfred:source",exportedAt:NOW},datasets:{"alfred.native":{schema:1,tables:{savingsGoals:[]}}}};
  expect(collectNativeRestoreSources(archive({preservedArchives:[old,latest]}))[0].native.tables.savingsGoals).toEqual([]);
  const outer={schema:1,tables:{savingsGoals:[]},retainedArchives:[{archive:old}]};expect(collectNativeRestoreSources(archive({"alfred.native":outer}))).toHaveLength(1);expect(collectNativeRestoreSources(archive({"alfred.native":outer}))[0].native.tables.savingsGoals).toEqual([]);
 });
});
