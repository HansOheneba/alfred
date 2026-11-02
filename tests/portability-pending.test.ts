import { beforeEach,describe,expect,it,vi } from "vitest";
import { createArchive,readArchive } from "../portability/archive.mjs";
import { emptyAccountingState } from "@/lib/finance/accounting/types";
import {GET as pendingRoute} from "@/app/api/portability/pending/route";
import {GET as detailRoute} from "@/app/api/portability/pending/[receiptId]/route";
import {GET as downloadRoute} from "@/app/api/portability/pending/[receiptId]/download/route";
import {POST as activationRoute} from "@/app/api/portability/pending/[receiptId]/preview-activation/route";
import { pendingDomainsForArchive,pendingFinanceDataDetails,downloadPendingFinanceData,previewPendingFinanceActivation,listPendingFinanceData,validateStoredArchive,pendingItemFromReceipt,type PendingReceiptRow } from "@/lib/portability/pending";
const mocks=vi.hoisted(()=>({query:vi.fn(),load:vi.fn(),exportNative:vi.fn(),owner:vi.fn(),row:null as unknown}));
vi.mock("@/lib/web/api",()=>({requireOwner:mocks.owner}));
vi.mock("@/lib/supabase/connection",()=>({query:mocks.query}));
vi.mock("@/lib/finance/accounting/persisted-store",()=>({loadAccountingState:mocks.load}));
vi.mock("@/lib/portability/export",async(importOriginal)=>({...await importOriginal<typeof import("@/lib/portability/export")>(),buildAlfredExport:mocks.exportNative}));
const OWNER="00000000-0000-0000-0000-000000000001",RECEIPT="00000000-0000-4000-8000-000000000001",NOW="2026-11-02T12:00:00.000Z";
const settings={} as never;
const emptyNative=()=>({schema:1,tables:{transactions:[],bankMessages:[],accountingStates:[],importedSources:[]},settings:{profile:{preferred_name:"",currency:"GHS",timezone:"Africa/Accra",communication_preference:"concise",financial_goals:"",account_names:""},reminderPreferences:{}},retainedArchives:[]});
async function receipt():Promise<PendingReceiptRow> {
 const archive=await readArchive(await createArchive({sourceApp:"alfred",namespace:"alfred:source",exportedAt:NOW,currency:"GHS",timezone:"Africa/Accra",coverage:[],datasets:{accounts:[],movements:[],snapshots:[],transfers:[],settlements:[],"alfred.native":{schema:1,tables:{budgets:[{budget_id:"source-budget",period:"2026-11",category:"Food",amount:"100.01",currency:"GHS",created_at:NOW,updated_at:NOW,access_token:"synthetic-secret",owner_id:"original-owner"}]}}}}));
 return{id:RECEIPT,archive_id:archive.archiveId,archive,summary:{counts:{accounts:0,movements:0},unsupported:["alfred.native: preserved"]},imported_at:NOW,undone_at:null,activation_of:null,created_ids:{accounting:{},native:{}}};
}
beforeEach(async()=>{vi.clearAllMocks();mocks.row=await receipt();mocks.owner.mockResolvedValue({profile:{profileId:OWNER},settings:{supabase:settings}});mocks.load.mockResolvedValue({state:emptyAccountingState(OWNER),availability:"ready",sourceVersion:"source-v1",rawTransactions:[]});mocks.exportNative.mockResolvedValue({datasets:{"alfred.native":emptyNative()},namespace:"alfred:target",currency:"GHS",timezone:"Africa/Accra",coverage:[]});mocks.query.mockImplementation(async(_settings,sql:string,values:unknown[]=[])=>{
 if(sql.includes("select to_regclass"))return[{ready:true}];if(sql.includes("native_version($1"))return[{version:"native-v1"}];if(sql.includes("as ids"))return[{ids:{accounting:{accounts:[],movements:[],snapshots:[],transfers:[],settlements:[]},native:{budgets:[]}}}];
 if(sql.includes("r.activation_of=any"))return[];if(sql.startsWith("select r.id"))return values[0]===OWNER?[mocks.row]:[];return[];
});});
describe("recoverable saved finance evidence",()=>{
 it("authenticates every saved-data endpoint and rejects a foreign receipt or origin",async()=>{
  const request=new Request("http://localhost/api/portability/pending");const context={params:Promise.resolve({receiptId:RECEIPT})};
  mocks.owner.mockResolvedValue(new Response("Sign in",{status:401}));const denied=await Promise.all([pendingRoute(request),detailRoute(request,context),downloadRoute(request,context),activationRoute(new Request(request.url,{method:"POST"}),context)]);expect(denied.map(item=>item.status)).toEqual([401,401,401,401]);expect(mocks.query).not.toHaveBeenCalled();
  mocks.owner.mockResolvedValue({profile:{profileId:"00000000-0000-0000-0000-000000000002"},settings:{supabase:settings}});expect((await detailRoute(request,context)).status).toBe(404);
  mocks.query.mockClear();expect((await activationRoute(new Request(request.url,{method:"POST",headers:{origin:"https://foreign.example"}}),context)).status).toBe(403);expect(mocks.query).not.toHaveBeenCalled();
 });
 it("exposes meaningful third-party, planning and rule fields and their exact source paths",async()=>{
  const archive=await readArchive(await createArchive({sourceApp:"money-tracker",namespace:"money:source",exportedAt:NOW,currency:"GHS",timezone:"Africa/Accra",coverage:[],datasets:{accounts:[],movements:[],snapshots:[],transfers:[],settlements:[],"moneyTracker.native":{planning:{thirdPartyGroups:[{id:"group",sourceMovementId:"payment",members:[{personId:"friend",principalMinor:4000}]}],thirdPartyAudit:[{groupId:"group",action:"assigned"}],plans:{"2026-11":{incomeEntries:[{id:"pay",amountMinor:100_000}],limit:50_000,categoryLimits:{Food:10000}}},rules:[{account:"Cash",description:"Market",category:"Food"}]}}}}));
  const domains=pendingDomainsForArchive(archive,[]);expect(domains.find(item=>item.dataset.endsWith("thirdPartyGroups"))).toMatchObject({status:"awaiting_support",count:1,path:["moneyTracker.native","planning","thirdPartyGroups"]});expect(domains.find(item=>item.dataset.endsWith("incomeIntentions"))?.reason).toContain("income intentions");expect(domains.find(item=>item.dataset.endsWith(".rules"))?.status).toBe("awaiting_support");
 });
 it("loads only same-owner receipts and redacts structured secrets without losing finance values or stored originals",async()=>{
  const before=structuredClone(mocks.row);const details=await pendingFinanceDataDetails(settings,OWNER,RECEIPT);expect(details.item.archiveId).toBe((before as PendingReceiptRow).archive_id);expect(JSON.stringify(details.datasets)).not.toContain("synthetic-secret");expect(JSON.stringify(details.datasets)).not.toContain("original-owner");expect(JSON.stringify(details.datasets)).toContain("100.01");expect(mocks.row).toEqual(before);
  await expect(pendingFinanceDataDetails(settings,"00000000-0000-0000-0000-000000000002",RECEIPT)).rejects.toThrow("does not belong");
 });
 it("downloads a verified safe source ZIP and retains original source identity in its provenance",async()=>{
  const result=await downloadPendingFinanceData(settings,OWNER,RECEIPT);const downloaded=await readArchive(result.bytes);expect(result.archiveId).toBe((mocks.row as PendingReceiptRow).archive_id);expect(downloaded.manifest.coverage.find(item=>item.dataset==="stored-source-provenance")?.reason).toContain(result.archiveId);expect(JSON.stringify(downloaded.datasets)).not.toContain("synthetic-secret");expect(JSON.stringify(downloaded.datasets)).toContain("100.01");
 });
 it("uses actual current adapters to stage newly supported records from an older core-only receipt without re-uploading",async()=>{
  const result=await previewPendingFinanceActivation(settings,OWNER,RECEIPT,new Date(NOW));expect(result.status).toBe("ready");if(result.status!=="ready")throw new Error("Expected activation");expect(result.preview.activationOf).toBe(RECEIPT);expect(result.preview.archiveId).toBe((mocks.row as PendingReceiptRow).archive_id);expect(result.preview.native.additions.budgets).toBe(1);
  const stage=mocks.query.mock.calls.find(call=>call[1].includes("insert into public.finance_import_previews"))!;expect(stage[2][14]).toBe(RECEIPT);expect(stage[2][15]).toMatch(/^[a-f0-9]{64}$/);expect(JSON.parse(stage[2][9])).toEqual((mocks.row as PendingReceiptRow).archive);expect(mocks.query.mock.calls.some(call=>call[1].startsWith("select public.alfred_confirm_finance_import("))).toBe(false);
 });
 it("returns nothing_new with no staged or financial mutation when the current adapter has already populated all records",async()=>{
  const first=await previewPendingFinanceActivation(settings,OWNER,RECEIPT,new Date(NOW));expect(first.status).toBe("ready");const stage=mocks.query.mock.calls.find(call=>call[1].includes("insert into public.finance_import_previews"))!;const native=emptyNative();Object.assign(native.tables,{budgets:JSON.parse(stage[2][13]).tables.budgets});mocks.exportNative.mockResolvedValue({datasets:{"alfred.native":native}});mocks.query.mockClear();
  const repeat=await previewPendingFinanceActivation(settings,OWNER,RECEIPT,new Date(NOW));expect(repeat.status).toBe("nothing_new");expect(repeat.text).toContain("not promised automatically");expect(mocks.query.mock.calls.some(call=>call[1].includes("insert into"))).toBe(false);
 });
 it("binds activation to the authenticated owner and stored receipt even when a body supplies other owners",async()=>{
  const response=await activationRoute(new Request("http://localhost/api/portability/pending/x/preview-activation",{method:"POST",body:JSON.stringify({ownerId:"foreign",archiveId:"fake"})}),{params:Promise.resolve({receiptId:RECEIPT})});expect(response.status).toBe(200);expect((await response.json()).status).toBe("ready");const stage=mocks.query.mock.calls.find(call=>call[1].includes("insert into public.finance_import_previews"))!;expect(stage[2][0]).toBe(OWNER);expect(stage[2][2]).toBe((mocks.row as PendingReceiptRow).archive_id);
 });
 it("blocks undone, edited or tampered sources without overwriting or inventing another archive ID",async()=>{
  (mocks.row as PendingReceiptRow).undone_at=NOW;expect((await previewPendingFinanceActivation(settings,OWNER,RECEIPT)).status).toBe("blocked");expect(mocks.query.mock.calls.some(call=>call[1].includes("insert into"))).toBe(false);
  const tampered=await receipt();(tampered.archive as {datasets:Record<string,unknown>}).datasets["extra"]={amount:"changed"};await expect(validateStoredArchive(tampered)).rejects.toThrow("integrity");
 });
 it("counts only imported feature IDs that still exist, including active activation children",async()=>{
  const row=await receipt();row.created_ids={accounting:{movements:["deleted","present"]},native:{budgets:["old-budget"]}};const archive=await validateStoredArchive(row);const child={...row,id:"child",activation_of:row.id,created_ids:{accounting:{},native:{budgets:["new-budget"]}}};
  const item=pendingItemFromReceipt(row,archive,[child],{accounting:{movements:["present"]},native:{budgets:["new-budget"]}});expect(item.activeCounts).toEqual({accounting:{movements:1},native:{budgets:1}});
  expect((await listPendingFinanceData(settings,OWNER)).items[0].receiptId).toBe(RECEIPT);
 });
});
