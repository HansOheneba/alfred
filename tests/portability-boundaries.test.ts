import { describe, expect, it } from "vitest";
import { createArchive, readArchive, type Datasets } from "../portability/archive.mjs";
import { applyAccountingAction } from "@/lib/finance/accounting/reducer";
import { emptyAccountingState, type AccountingState } from "@/lib/finance/accounting/types";
import { CORE_DOMAINS, planImport } from "@/lib/portability/model";
import { selectPortableCore } from "@/lib/portability/native-core";
import { scrubNativeOwnership } from "@/lib/portability/export";
const NOW="2026-11-02T12:00:00.000Z";
const datasets:Datasets={accounts:[{id:"cash",label:"Cash",provider:"Synthetic",currency:"GHS",includeInCash:true,createdAt:NOW}],movements:[{id:"original",accountId:"cash",direction:"out",status:"confirmed",amountMinor:10_000,feeMinor:25,taxMinor:10,currency:"GHS",date:"2026-11-02",occurredAt:NOW,description:"Synthetic",category:"Food",sourceId:"raw-source",sourceKind:"transaction",sourceFingerprint:"stable",legacyTransactionId:"raw-source",feeTransactionId:null,legacyClassification:null}],snapshots:[],transfers:[],settlements:[]};
const archive=async(data:Datasets=datasets,namespace="alfred:original")=>readArchive(await createArchive({sourceApp:"alfred",namespace,timezone:"Africa/Accra",currency:"GHS",exportedAt:NOW,coverage:[],datasets:data}));
describe("portability boundaries",()=>{
 it("blocks regular undo from crossing import and undo-import events while allowing later edits to undo",async()=>{
  const first=planImport(emptyAccountingState("owner"),await archive(),"p",NOW).next;
  expect(()=>applyAccountingAction(first,{type:"undo",requestId:"u1",expectedRevision:1},NOW)).toThrow("import receipt");
  const edited=applyAccountingAction(first,{type:"update_account",accountId:first.accounts[0].id,changes:{label:"Changed"},requestId:"edit",expectedRevision:1},NOW);
  const undone=applyAccountingAction(edited,{type:"undo",requestId:"u2",expectedRevision:2},NOW);
  expect(undone.accounts[0].label).toBe("Cash");expect(()=>applyAccountingAction(undone,{type:"undo",requestId:"u3",expectedRevision:3},NOW)).toThrow("import receipt");
  const importUndone:AccountingState={...emptyAccountingState("owner"),revision:2,audit:[...first.audit,{...first.audit[0],id:"u",requestId:"undo-import:p",action:"undo_import",revision:2}]};
  expect(()=>applyAccountingAction(importUndone,{type:"undo",requestId:"u4",expectedRevision:2},NOW)).toThrow("import receipt");
 });
 it("does not create a second copy when original native data returns through another app",async()=>{
  const original:AccountingState={...emptyAccountingState("original-owner"),accounts:datasets.accounts as AccountingState["accounts"],movements:(datasets.movements as AccountingState["movements"]).map(row=>({...row,ownerId:"original-owner"}))};
  const first=planImport(emptyAccountingState("other-owner"),await archive(),"p1",NOW,"alfred:other").next;
  const portable=Object.fromEntries(CORE_DOMAINS.map(domain=>[domain,first[domain].map(row=>{const item={...row} as Record<string,unknown>;delete item.ownerId;return item;})])) as Datasets;
  const back=planImport(original,await archive(portable,"alfred:other"),"p2",NOW,"alfred:original");
  expect(back.additions.movements).toBe(0);expect(back.additions.accounts).toBe(0);expect(back.conflicts.length).toBeGreaterThan(0);expect(back.next.movements).toHaveLength(1);
 });
 it("preserves stale native links and missing sources only in raw evidence coverage",()=>{
  const source=structuredClone(datasets);source.movements.push({...source.movements[0] as object,id:"missing",sourceMissing:true});
  source.snapshots=[{id:"stale",accountId:"cash",balanceMinor:500,occurredAt:NOW,sourceId:"raw-source",sourceMovementId:"original",sourceFingerprint:"changed"}];
  const selected=selectPortableCore(source);expect(selected.datasets.movements).toHaveLength(1);expect(selected.datasets.snapshots).toEqual([]);expect(selected.coverage.map(row=>row.dataset)).toEqual(expect.arrayContaining(["alfred.native.unsupportedCore.movements","alfred.native.unsupportedCore.snapshots"]));
  expect(source.movements).toHaveLength(2);expect(source.snapshots).toHaveLength(1);
 });
 it("removes nested structured credentials, session/push keys and local paths without changing finance fields",()=>{
  expect(scrubNativeOwnership({owner_id:"other",raw:{amount:"12.30",access_token:"secret",pushSubscription:{endpoint:"secret"},file_path:"/private",taxMinor:10,note:"Finance note"}})).toEqual({raw:{amount:"12.30",taxMinor:10,note:"Finance note"}});
 });
});
