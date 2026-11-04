import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseSettings } from "@/lib/config";
const transport=vi.hoisted(()=>({query:vi.fn()}));
vi.mock("@/lib/supabase/connection",()=>({query:transport.query}));
import { loadImportedTransferProviderResult } from "@/lib/bank/imported-account-providers";
import { resolveTransferAccount } from "@/lib/bank/own-transfers";
import { sourceMovements } from "@/lib/finance/accounting/sources";
import { emptyAccountingState } from "@/lib/finance/accounting/types";
import type { BankMessage } from "@/lib/bank/store";
const OWNER="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",OTHER="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",HASH="a".repeat(64),NS="money-site:summary-fixture";
const settings={} as SupabaseSettings;
const account=()=>({id:"destination-account",label:"Any alias",provider:"Imported Money Tracker",currency:"GHS",includeInCash:true,createdAt:"2026-11-04T12:00:00Z",importProvenance:{namespace:NS,sourceId:"hubtel-wallet"}});
const document=()=>({archiveId:HASH,manifest:{sourceApp:"money-tracker",namespace:NS,currency:"GHS"},datasets:{accounts:[{id:"hubtel-wallet",provider:"Imported Money Tracker",currency:"GHS",includeInCash:true}],"moneyTracker.native":{snapshot:{currency:"GHS",accounts:[{account:"hubtel-wallet",cash:true}]}}}});
const migration=readFileSync(new URL("../supabase/migrations/20261104170000_import_provider_summaries.sql",import.meta.url),"utf8");
let db:PGlite,restoreFunctions=false;
beforeAll(async()=>{
 db=new PGlite();
 await db.exec("create role anon;create role authenticated;create table finance_import_receipts(owner_id uuid,id text,archive_id text,archive jsonb,after_state jsonb,undone_at timestamptz,primary key(owner_id,id))");
 await db.exec(migration);
 transport.query.mockImplementation(async(_settings,sql:string,values:unknown[]=[]) =>(await db.query(sql,values)).rows);
});
beforeEach(async()=>{await db.exec("alter table finance_import_receipts enable trigger derive_import_provider_summary;truncate finance_import_receipts");if(restoreFunctions){await db.exec(migration);restoreFunctions=false;}transport.query.mockClear();});
afterAll(async()=>{await db.close();});
async function insert(id="receipt",legacy=false,payload:unknown=document()) {
 if(legacy)await db.exec("alter table finance_import_receipts disable trigger derive_import_provider_summary");
 try {await db.query("insert into finance_import_receipts(owner_id,id,archive_id,archive,after_state) values($1,$2,$3,$4::jsonb,$5::jsonb)",[OWNER,id,HASH,JSON.stringify(payload),JSON.stringify({ownerId:OWNER,accounts:[account()]})]);}
 finally {if(legacy)await db.exec("alter table finance_import_receipts enable trigger derive_import_provider_summary");}
}
async function lookup(){return loadImportedTransferProviderResult(settings,OWNER,[account()],{summaryReady:true});}
async function backfill(id="receipt",owner=OWNER){return(await db.query<{result:{status:string}}>("select public.alfred_backfill_import_provider_summary($1::uuid,$2) as result",[owner,id])).rows[0].result.status;}

describe("compact verified import-provider summary lifecycle",()=>{
 it("derives compact facts at the receipt insert without changing financial account metadata",async()=>{
  await insert();
  const row=(await db.query<{provider_identity_summary:{schema:number;facts:unknown[]};provider_identity_archive_id:string;after_state:{accounts:unknown[]}}>("select provider_identity_summary,provider_identity_archive_id,after_state from finance_import_receipts")).rows[0];
  expect(row.provider_identity_summary).toEqual({schema:1,facts:[{accountId:account().id,namespace:NS,sourceId:"hubtel-wallet",provider:"hubtel",currency:"GHS",includeInCash:true}]});
  expect(row.provider_identity_archive_id).toBe(HASH);expect(row.after_state.accounts).toEqual([account()]);
  const result=await lookup();expect(result.providers).toEqual(new Map([[account().id,"hubtel"]]));expect(result.status).toBe("summary");expect(result.needsBackfill).toBe(false);
 });
 it("uses only the summary after an 8MB import and never re-runs archive derivation on reads",async()=>{
  await insert("receipt",false,{...document(),syntheticPayload:"x".repeat(8_000_000)});
  await db.exec("create or replace function public.alfred_derive_import_provider_summary(owner uuid,receipt_key text,archive_hash text,document jsonb,saved_state jsonb) returns jsonb language plpgsql as $$begin raise exception 'Synthetic archive derivation must not run on this read';end$$");restoreFunctions=true;
  const result=await lookup();expect(result.providers.size).toBe(1);expect(result.status).toBe("summary");
  expect(transport.query.mock.calls.every((call)=>String(call[1]).includes("alfred_import_provider_facts"))).toBe(true);
  const response=await db.query<{result:unknown}>("select public.alfred_import_provider_facts($1::uuid,$2::jsonb) result",[OWNER,JSON.stringify([{account_id:account().id,namespace:NS,source_id:"hubtel-wallet",provider:"hubtel"}])]);
  expect(JSON.stringify(response.rows).length).toBeLessThan(1024);
 });
 it("commits receipt and summary together and rejects mismatched archive lineage atomically",async()=>{
  await db.exec("begin");await insert();expect((await lookup()).providers.size).toBe(1);await db.exec("rollback");expect((await lookup()).providers.size).toBe(0);
  await expect(insert("bad",false,{...document(),archiveId:"b".repeat(64)})).rejects.toThrow("lineage");expect((await db.query("select * from finance_import_receipts")).rows).toHaveLength(0);
 });
 it("does not trust supplied summary/version values and keeps original receipt source immutable",async()=>{
  await insert();
  await db.query("update finance_import_receipts set provider_identity_summary=$1::jsonb,provider_identity_summary_version=99",[JSON.stringify({schema:1,facts:[{accountId:account().id,provider:"momo"}]})]);
  expect((await lookup()).providers).toEqual(new Map([[account().id,"hubtel"]]));
  await expect(db.query("update finance_import_receipts set archive_id=$1",["b".repeat(64)])).rejects.toThrow("immutable");
  await expect(db.query("update finance_import_receipts set after_state=$1::jsonb",[JSON.stringify({ownerId:OWNER,accounts:[]})])).rejects.toThrow("immutable");
 });
 it.each(["version","fingerprint","archive-id","shape"])("fails closed on corrupted %s summary without falling back to archives",async(kind)=>{
  await insert();await db.exec("alter table finance_import_receipts disable trigger derive_import_provider_summary");
  if(kind==="version")await db.exec("update finance_import_receipts set provider_identity_summary_version=99");
  if(kind==="fingerprint")await db.exec("update finance_import_receipts set provider_identity_summary_fingerprint='bad'");
  if(kind==="archive-id")await db.query("update finance_import_receipts set provider_identity_archive_id=$1",["b".repeat(64)]);
  if(kind==="shape")await db.exec("update finance_import_receipts set provider_identity_summary='{}'::jsonb");
  await db.exec("alter table finance_import_receipts enable trigger derive_import_provider_summary");
  const result=await lookup();expect(result.status).toBe("corrupt");expect(result.providers.size).toBe(0);
 });
 it("respects undo, foreign ownership and current provider/currency/cash edits",async()=>{
  await insert();expect((await loadImportedTransferProviderResult(settings,OTHER,[account()],{summaryReady:true})).providers.size).toBe(0);
  for(const edited of [{...account(),provider:"Explicit bank"},{...account(),currency:"USD"},{...account(),includeInCash:false}])expect((await loadImportedTransferProviderResult(settings,OWNER,[edited],{summaryReady:true})).providers.size).toBe(0);
  await db.exec("update finance_import_receipts set undone_at=now()");expect((await lookup()).providers.size).toBe(0);expect(await backfill()).toBe("undone");
 });
 it("keeps old receipts usable through a bounded read-only fallback and prepares them explicitly/idempotently",async()=>{
  await insert("receipt",true);let result=await lookup();expect(result.status).toBe("legacy-fallback");expect(result.needsBackfill).toBe(true);expect(result.providers.size).toBe(1);
  expect((await db.query<{missing:boolean}>("select provider_identity_summary is null as missing from finance_import_receipts")).rows[0].missing).toBe(true);
  expect(await backfill()).toBe("prepared");expect(await backfill()).toBe("current");result=await lookup();expect(result.status).toBe("summary");expect(result.needsBackfill).toBe(false);
 });
 it("flags more than two old receipts instead of silently scanning an incomplete archive set",async()=>{
  for(const id of ["one","two","three"])await insert(id,true);
  let result=await lookup();expect(result.status).toBe("backfill-required");expect(result.needsBackfill).toBe(true);expect(result.providers.size).toBe(0);
  expect(await backfill("one",OTHER)).toBe("missing_or_busy");expect(await backfill("one")).toBe("prepared");result=await lookup();expect(result.status).toBe("summary");expect(result.providers.size).toBe(1);
 });
 it("never turns one proved account and one missing provider proof into a falsely unique account",async()=>{
  await insert();const unresolved={...account(),id:"second-hubtel",importProvenance:{namespace:"money-site:another-owner-import",sourceId:"hubtel-wallet"}};
  const result=await loadImportedTransferProviderResult(settings,OWNER,[account(),unresolved],{summaryReady:true});
  expect(result.providers.size).toBe(0);expect(result.status).toBe("incomplete");
 });
 it("vetoes partial implicit-provider resolution while retaining an explicit saved account assignment",()=>{
  const bank:BankMessage={id:"00000000-0000-4000-8000-000000000001",ownerId:OWNER,source:"hubtel",channel:"mac",externalId:"88123456",direction:"out",kind:"payment",amount:"1.00",fee:"0.00",currency:"GHS",counterparty:"Hubtel wallet",balance:"99.00",occurredAt:"2026-11-04T12:00:00Z",status:"needs_label",transactionId:null,feeTransactionId:null,askedAt:null,raw:"GHS 1.00 was withdrawn from your Hubtel wallet.",readBy:"rules"};
  const unresolved={...account(),id:"second-hubtel",importProvenance:{namespace:"money-site:other-import",sourceId:"hubtel-wallet"}};
  const state={...emptyAccountingState(OWNER),accounts:[account(),unresolved],movements:sourceMovements(OWNER,[],[bank])};
  expect(resolveTransferAccount(state,bank,undefined,undefined,new Map([[account().id,"hubtel"]]))).toBeNull();
  state.movements[0].accountId=account().id;
  expect(resolveTransferAccount(state,bank,undefined,undefined,new Map())).toEqual(account());
  const native={...account(),id:"native-hubtel",provider:"Hubtel"};
  state.accounts=[native,...Array.from({length:101},(_,index)=>({...account(),id:`unverified-${index}`,importProvenance:{namespace:`money-site:origin-${index}`,sourceId:"hubtel-wallet"}}))];
  state.movements[0].accountId=null;
  expect(resolveTransferAccount(state,bank,undefined,undefined,new Map())).toBeNull();
  state.movements[0].accountId=native.id;
  expect(resolveTransferAccount(state,bank,undefined,undefined,new Map())).toEqual(native);
 });
});
