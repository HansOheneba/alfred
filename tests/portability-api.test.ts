import { beforeEach, describe, expect, it, vi } from "vitest";
import { createArchive, readArchive } from "../portability/archive.mjs";
import { emptyAccountingState } from "@/lib/finance/accounting/types";
import { exportFinanceArchive, previewFinanceImport } from "@/lib/portability/service";
import { boundedBody, readIdentifier, requireSameOrigin } from "@/lib/portability/http";
import { POST as previewRoute } from "@/app/api/portability/preview/route";
import { POST as confirmRoute } from "@/app/api/portability/confirm/route";
import { POST as resumeRoute } from "@/app/api/portability/resume-notifications/route";
import { POST as undoRoute } from "@/app/api/portability/undo/route";
import { GET as receiptsRoute } from "@/app/api/portability/receipts/route";
import { GET as exportRoute } from "@/app/api/portability/export/route";
const mocks=vi.hoisted(()=>({query:vi.fn(),owner:vi.fn(),load:vi.fn(),exportNative:vi.fn()}));
vi.mock("@/lib/supabase/connection",()=>({query:mocks.query}));
vi.mock("@/lib/portability/export",()=>({buildAlfredExport:mocks.exportNative}));
vi.mock("@/lib/web/api",()=>({requireOwner:mocks.owner}));
vi.mock("@/lib/finance/accounting/persisted-store",()=>({loadAccountingState:mocks.load}));
const OWNER="00000000-0000-0000-0000-000000000001";
const owner={profile:{profileId:OWNER},settings:{supabase:{}}};
const request=(path:string,value:unknown)=>new Request(`http://localhost/api/portability/${path}`,{method:"POST",headers:{"content-type":"application/json","origin":"http://localhost"},body:JSON.stringify(value)});
beforeEach(()=>{vi.clearAllMocks();mocks.owner.mockResolvedValue(owner);mocks.query.mockImplementation(async(_settings,sql:string)=>sql.includes("native_version($1")?[{version:"native-v1"}]:[{ready:true}]);mocks.exportNative.mockResolvedValue({datasets:{"alfred.native":{schema:1,tables:{transactions:[],bankMessages:[],accountingStates:[],importedSources:[]},settings:{profile:{preferred_name:"",currency:"GHS",timezone:"Africa/Accra",communication_preference:"concise",financial_goals:""},reminderPreferences:{}},retainedArchives:[]}},namespace:"alfred:fixture",currency:"GHS",timezone:"Africa/Accra",coverage:[]});mocks.load.mockResolvedValue({state:emptyAccountingState(OWNER),availability:"ready",sourceVersion:"v1",rawTransactions:[]});});
describe("owner-scoped portability HTTP boundary",()=>{
 it("rejects unauthenticated access to every export/import endpoint",async()=>{
  mocks.owner.mockResolvedValue(new Response("Sign in",{status:401}));
  const responses=await Promise.all([exportRoute(new Request("http://localhost/api/portability/export")),previewRoute(request("preview",{})),confirmRoute(request("confirm",{})),undoRoute(request("undo",{})),resumeRoute(request("resume-notifications",{})),receiptsRoute()]);
  expect(responses.map(row=>row.status)).toEqual([401,401,401,401,401,401]);expect(mocks.query).not.toHaveBeenCalled();
 });
 it("rejects malformed ZIP before querying or staging destination records",async()=>{
  const response=await previewRoute(new Request("http://localhost/api/portability/preview",{method:"POST",body:new Uint8Array([1,2,3])}));
  expect(response.status).toBe(400);expect((await response.json()).text).toContain("Invalid finance archive");expect(mocks.query).not.toHaveBeenCalled();
 });
 it("exports verified finance ZIPs and reports whether device presentation preferences were supplied",async()=>{
  const finance=await readArchive(await exportFinanceArchive({} as never,OWNER));expect(finance.datasets["alfred.native"]).toBeDefined();expect(finance.manifest.coverage.find(item=>item.dataset==="alfred.browserPreferences")?.status).toBe("unavailable");expect(finance.datasets["alfred.browserPreferences"]).toBeUndefined();
  const preferences={schema:1,appearance:"dark",privacy:"masked",home:"overview"};const complete=await readArchive(await exportFinanceArchive({} as never,OWNER,preferences));expect(complete.datasets["alfred.browserPreferences"]).toEqual(preferences);expect(complete.manifest.coverage.find(item=>item.dataset==="alfred.browserPreferences")?.status).toBe("supported");
 });
 it("stages a fully validated archive with session ownership, without committing financial records",async()=>{
  const zip=await createArchive({sourceApp:"money-tracker",namespace:"synthetic:source",exportedAt:"2026-11-02T12:00:00.000Z",timezone:"Africa/Accra",currency:"GHS",coverage:[{dataset:"moneyTracker.native",status:"supported",reason:"Native source support"}],datasets:{accounts:[],movements:[],snapshots:[],transfers:[],settlements:[],"moneyTracker.native":{plans:[{id:"p",amount:"12.30"}]}}});
  const preview=await previewFinanceImport({} as never,OWNER,zip,new Date("2026-11-02T12:00:00.000Z"));
  expect(preview.canConfirm).toBe(true);expect(preview.expiresAt).toBe("2026-11-02T12:30:00.000Z");expect(preview.unsupported.some(item=>item.includes("no native destination records"))).toBe(false);expect(preview.coverage.find(row=>row.dataset==="moneyTracker.native")?.status).toBe("preserved");
  const call=mocks.query.mock.calls.find(entry=>entry[1].includes("insert into public.finance_import_previews"))!;expect(call[1]).toContain("insert into public.finance_import_previews");expect(call[2][0]).toBe(OWNER);expect(JSON.parse(call[2][7]).ownerId).toBe(OWNER);expect(JSON.parse(call[2][9]).datasets["moneyTracker.native"].plans[0].amount).toBe("12.30");
  expect(mocks.query.mock.calls.some((entry)=>/insert into public.accounting_states/.test(entry[1]))).toBe(false);
 });
 it("requires separate confirmation and never accepts archive-supplied owner arguments",async()=>{
  const bad=await confirmRoute(request("confirm",{previewId:"00000000-0000-0000-0000-000000000002",ownerId:"other"}));expect(bad.status).toBe(400);expect(mocks.query).not.toHaveBeenCalled();
  const receipt={id:"receipt",archiveId:"a",counts:{},unsupported:[],undoAvailable:true};mocks.query.mockResolvedValueOnce([{ready:true}]).mockResolvedValueOnce([{result:{status:"saved",receipt}}]);
  const good=await confirmRoute(request("confirm",{previewId:"00000000-0000-0000-0000-000000000002"}));expect(good.status).toBe(200);expect(mocks.query.mock.calls[1][2]).toEqual([OWNER,"00000000-0000-0000-0000-000000000002"]);expect(good.headers.get("cache-control")).toBe("no-store");
 });
 it("reports migration unavailable, cross-owner not-found and later-edit undo conflicts safely",async()=>{
  mocks.query.mockResolvedValueOnce([{ready:false}]);expect((await undoRoute(request("undo",{receiptId:"00000000-0000-0000-0000-000000000002"}))).status).toBe(503);
  mocks.query.mockResolvedValueOnce([{ready:true}]).mockResolvedValueOnce([{result:{status:"missing"}}]);expect((await undoRoute(request("undo",{receiptId:"00000000-0000-0000-0000-000000000002"}))).status).toBe(404);
  mocks.query.mockResolvedValueOnce([{ready:true}]).mockResolvedValueOnce([{result:{status:"stale"}}]);const stale=await undoRoute(request("undo",{receiptId:"00000000-0000-0000-0000-000000000002"}));expect(stale.status).toBe(409);expect((await stale.json()).text).toContain("never discard later edits");
 });
 it("resumes only a receipt owned by the session after a separate explicit action",async()=>{
  mocks.query.mockResolvedValueOnce([{ready:true}]).mockResolvedValueOnce([{result:{status:"saved",resumed:2}}]);
  const response=await resumeRoute(request("resume-notifications",{receiptId:"00000000-0000-0000-0000-000000000002"}));expect(response.status).toBe(200);expect(await response.json()).toEqual({ok:true,resumed:2});expect(mocks.query.mock.calls[1][2]).toEqual([OWNER,"00000000-0000-0000-0000-000000000002"]);
 });
 it("does not claim an interrupted write left financial records unchanged",async()=>{
  for(const [route,key,path] of [[confirmRoute,"previewId","confirm"],[undoRoute,"receiptId","undo"],[resumeRoute,"receiptId","resume-notifications"]] as const) {
   mocks.query.mockResolvedValueOnce([{ready:true}]).mockRejectedValueOnce(new Error("Connection interrupted after sending the write"));
   const response=await route(request(path,{[key]:"00000000-0000-0000-0000-000000000002"}));
   const body=await response.json();expect(response.status).toBe(500);expect(body.text).toContain("result could not be confirmed");expect(body.text).toContain("Check Previous imports");expect(body.text).not.toContain("No financial records were changed");expect(body.text).not.toContain("Connection interrupted");
  }
 });
 it("stages native existing-feature additions and keeps a differing current setting without blocking",async()=>{
  const at="2026-11-02T12:00:00.000Z";const zip=await createArchive({sourceApp:"alfred",namespace:"alfred:source",exportedAt:at,timezone:"Africa/Accra",currency:"GHS",coverage:[],datasets:{accounts:[],movements:[],snapshots:[],transfers:[],settlements:[],"alfred.native":{schema:1,tables:{budgets:[{budget_id:"sourcebudget",period:"2026-11",category:"Food",amount:"100.00",currency:"GHS",created_at:at,updated_at:at}]},settings:{profile:{preferred_name:"Imported name"}}}}});
  mocks.exportNative.mockResolvedValue({datasets:{"alfred.native":{schema:1,tables:{},settings:{profile:{preferred_name:"Current name",currency:"GHS",timezone:"Africa/Accra",communication_preference:"concise",financial_goals:""},reminderPreferences:{}},retainedArchives:[]}}});
  const preview=await previewFinanceImport({} as never,OWNER,zip);expect(preview.native.additions.budgets).toBe(1);expect(preview.native.settings.conflicts).toEqual([]);expect(preview.native.settings.preserved.join(" ")).toContain("profile.preferred_name: your current choice is kept");expect(preview.canConfirm).toBe(true);
  const staged=mocks.query.mock.calls.find(entry=>entry[1].includes("insert into public.finance_import_previews"))!;expect(JSON.parse(staged[2][10]).canConfirm).toBe(true);expect(JSON.parse(staged[2][13]).tables.budgets).toHaveLength(1);expect(JSON.parse(staged[2][13]).profileChanges).toEqual({});
 });
 it("reports the bounded pending-preview quota without committing finance records",async()=>{
  const zip=await createArchive({sourceApp:"alfred",namespace:"alfred:quota",exportedAt:"2026-11-02T12:00:00.000Z",timezone:"Africa/Accra",currency:"GHS",coverage:[],datasets:{accounts:[],movements:[],snapshots:[],transfers:[],settlements:[]}});
  mocks.query.mockImplementation(async(_settings,sql:string)=>{if(sql.includes("insert into public.finance_import_previews"))throw new Error("The ledger query failed: Too many pending import previews");return sql.includes("native_version($1")?[{version:"native-v1"}]:[{ready:true}];});
  const response=await previewRoute(new Request("http://localhost/api/portability/preview",{method:"POST",body:new Uint8Array(zip)}));expect(response.status).toBe(409);expect((await response.json()).text).toContain("five pending import previews");expect(mocks.query.mock.calls.some(entry=>entry[1].startsWith("select public.alfred_confirm_finance_import("))).toBe(false);
 });
 it("bounds streamed body before parsing even without content length and checks origin",async()=>{
  await expect(boundedBody(new Request("http://localhost",{method:"POST",body:"12345"}),4)).rejects.toThrow("too large");
  await expect(readIdentifier(request("confirm",{previewId:"bad"}),"previewId")).rejects.toThrow("valid import");
  expect(requireSameOrigin(new Request("http://localhost",{headers:{origin:"https://other.example"}}))?.status).toBe(403);
 });
});
