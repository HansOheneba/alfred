import { describe, expect, it } from "vitest";
import { createArchive, readArchive } from "../portability/archive.mjs";
import { hydrateAccountingSources, sourceMovements } from "@/lib/finance/accounting/sources";
import { emptyAccountingState } from "@/lib/finance/accounting/types";
import type { TransactionRecord } from "@/lib/finance/types";
import { scrubNativeOwnership, type AlfredNativeExport } from "@/lib/portability/export";
import { planImport } from "@/lib/portability/model";
import { accountingCoreFromNative } from "@/lib/portability/native-core";
const NOW="2026-11-02T12:00:00.000Z";
const toArchive=async(datasets:ReturnType<typeof accountingCoreFromNative>["datasets"],namespace:string)=>readArchive(await createArchive({sourceApp:"alfred",namespace,timezone:"Africa/Accra",currency:"GHS",exportedAt:NOW,coverage:[],datasets}));
function native(tables:Record<string,Record<string,unknown>[]>):AlfredNativeExport{return {schema:1,tables:{transactions:[],bankMessages:[],accountingStates:[],importedSources:[],...tables},settings:{profile:null,reminderPreferences:null},retainedArchives:[]};}
describe("native export accounting normalization",()=>{
 it("exports exact hydrated native source fingerprints and retains explicit category and account choices",async()=>{
  const raw:TransactionRecord={transactionId:"original",createdAt:NOW,transactionDate:"2026-11-02",userId:"owner-a",type:"expense",amount:"10.25",currency:"GHS",category:"Food",description:"Synthetic",paymentMethod:"GCB",notes:"Note",status:"active",updatedAt:NOW,sourceUpdateId:"original",rowNumber:71};
  const state={...emptyAccountingState("owner-a"),accounts:[{id:"cash",label:"Cash",provider:"GCB",currency:"GHS",includeInCash:true,createdAt:NOW}],movements:sourceMovements("owner-a",[raw],[]).map(row=>({...row,accountId:"cash",category:"Explicit category"}))};
  const evidence=native({transactions:[{id:"71",transaction_id:"original",created_at:"2026-11-02T12:00:00+00:00",transaction_date:"2026-11-02",type:"expense",amount:"10.25",currency:"GHS",category:"Food",description:"Synthetic",payment_method:"GCB",notes:"Note",status:"active",updated_at:"2026-11-02T12:00:00+00:00",source_update_id:"original"}],accountingStates:[{state:scrubNativeOwnership(state)}]});
  const exported=accountingCoreFromNative(evidence,"owner-a","alfred:a");
  expect(exported.coverage).toEqual([]);expect(exported.datasets.movements[0]).toMatchObject({sourceFingerprint:state.movements[0].sourceFingerprint,category:"Explicit category",accountId:"cash",importProvenance:{namespace:"alfred:a",sourceId:"transaction:original"}});
  const first=planImport(emptyAccountingState("owner-b"),await toArchive(exported.datasets,"alfred:a"),"p1",NOW,"alfred:b");
  const loadedB=hydrateAccountingSources(first.next,first.sources);
  const snapshotB=native({accountingStates:[{state:scrubNativeOwnership(loadedB)}],importedSources:first.sources.map(row=>({movement:scrubNativeOwnership(row)}))});
  const exportedB=accountingCoreFromNative(snapshotB,"owner-b","alfred:b");
  const archiveB=await toArchive(exportedB.datasets,"alfred:b");
  const retry=planImport(loadedB,archiveB,"p2",NOW,"alfred:b");expect(retry.additions.movements).toBe(0);expect(retry.conflicts).toEqual([]);expect(retry.duplicates).toBe(2);
  const returned=planImport(state,archiveB,"p3",NOW,"alfred:a");expect(returned.additions.movements).toBe(0);expect(returned.additions.accounts).toBe(0);expect(returned.next.movements).toHaveLength(1);expect(returned.conflicts.length).toBeGreaterThan(0);
 });
 it("exports generated reported-balance snapshots longer than 200 characters",async()=>{
  const id="x".repeat(150);const movement={id,ownerId:"owner",accountId:"cash",direction:"out" as const,status:"confirmed" as const,amountMinor:100,feeMinor:1,taxMinor:1,currency:"GHS",date:"2026-11-02",occurredAt:NOW,description:"Synthetic",category:"Food",sourceId:id,sourceKind:"manual" as const,sourceFingerprint:"f".repeat(64),legacyTransactionId:null,feeTransactionId:null,legacyClassification:null,reportedBalanceMinor:500,importProvenance:{namespace:"fixture",sourceId:id}};
  const state={...emptyAccountingState("owner"),accounts:[{id:"cash",label:"Cash",provider:"GCB",currency:"GHS",includeInCash:true,createdAt:NOW}],movements:[movement]};
  const loaded=hydrateAccountingSources(state,[movement]);expect(loaded.snapshots[0].id.length).toBeGreaterThan(200);
  const exported=accountingCoreFromNative(native({accountingStates:[{state:scrubNativeOwnership(loaded)}],importedSources:[{movement:scrubNativeOwnership(movement)}]}),"owner","alfred:owner");
  expect(exported.coverage).toEqual([]);expect((await toArchive(exported.datasets,"alfred:owner")).datasets.snapshots).toHaveLength(1);
 });
});
