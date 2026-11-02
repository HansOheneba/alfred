import { describe, expect, it } from "vitest";
import { createArchive, readArchive, type Datasets } from "../portability/archive.mjs";
import { accountBalances } from "@/lib/finance/accounting/accounts";
import { hydrateAccountingSources } from "@/lib/finance/accounting/sources";
import { emptyAccountingState } from "@/lib/finance/accounting/types";
import { accountingReportRows, projectAccountingTransactions } from "@/lib/finance/accounting/view";
import { CORE_DOMAINS, planImport } from "@/lib/portability/model";
const NOW = "2026-11-02T12:00:00.000Z";
const account = (id: string) => ({ id, label: id, provider: "Synthetic bank", currency: "GHS", includeInCash: true, createdAt: NOW });
const movement = (id: string, direction: "in" | "out", amountMinor: number, accountId = "cash") => ({ id, accountId, direction, status: "confirmed", sourceStatus: "confirmed", amountMinor, feeMinor: 25, taxMinor: 10, currency: "GHS", date: "2026-11-02", occurredAt: NOW, description: id, category: "Food", sourceId: id, sourceKind: "manual", sourceFingerprint: `fp-${id}`, legacyTransactionId: null, feeTransactionId: null, legacyClassification: null });
const ref = (id: string) => ({ movementId: id, sourceFingerprint: `fp-${id}` });
async function archive(datasets: Partial<Datasets> = {}) {
 return readArchive(await createArchive({ sourceApp: "money-tracker", namespace: "fixture:finance", exportedAt: NOW, timezone: "Africa/Accra", currency: "GHS", coverage: [], datasets: { accounts: [account("cash")], movements: [movement("purchase", "out", 10_000)], snapshots: [], transfers: [], settlements: [], ...datasets } }));
}
describe("deterministic Alfred accounting imports", () => {
 it("round trips archives into durable sources with separate fee/tax and session ownership", async () => {
  const input = await archive(); const plan = planImport(emptyAccountingState("destination-owner"), input, "p1", NOW);
  expect(plan.canConfirm).toBe(true);
  expect(plan.sources[0]).toMatchObject({ ownerId: "destination-owner", feeMinor: 25, taxMinor: 10, sourceKind: "manual", importProvenance: { namespace: "fixture:finance", sourceId: "purchase" } });
  const hydrated = hydrateAccountingSources(plan.next, plan.sources);
  expect(hydrated.movements[0].sourceMissing).toBe(false);
  expect(accountingReportRows(hydrated).map((row) => [row.category,row.minor])).toEqual(expect.arrayContaining([["Food",10_000],["Fees",25],["Taxes",10]]));
  expect(projectAccountingTransactions([],hydrated)).toHaveLength(3);
  const repeat = planImport(hydrated,input,"p2",NOW); expect(repeat.duplicates).toBe(2); expect(repeat.additions.movements).toBe(0);
 });
 it("flags differences without overwriting later edits",async()=>{
  const input=await archive(); const first=planImport(emptyAccountingState("owner"),input,"p1",NOW); first.next.movements[0].category="Changed later";
  const repeated=planImport(first.next,input,"p2",NOW); expect(repeated.canConfirm).toBe(false);expect(repeated.conflicts[0]).toContain("No record will be overwritten");expect(repeated.next.movements[0].category).toBe("Changed later");
 });
 it("preserves unsupported native records intact with explicit coverage",async()=>{
  const native={plans:[{id:"plan",amount:"123.00"}],thirdPartyGroups:[{id:"group",allocation:"200"}]};const input=await archive({"moneyTracker.native":native});
  expect(planImport(emptyAccountingState("owner"),input,"p",NOW).unsupported).toEqual([expect.stringContaining("moneyTracker.native")]);expect(input.datasets["moneyTracker.native"]).toEqual(native);
 });
 it("preserves partial refund offsets and all fee/tax contributions",async()=>{
  const input=await archive({movements:[movement("purchase","out",10_000),movement("refund","in",4_000)],settlements:[{id:"refund-link",kind:"refund",original:ref("purchase"),returns:[{...ref("refund"),principalMinor:3_000}],createdAt:NOW}]});
  const rows=accountingReportRows(planImport(emptyAccountingState("owner"),input,"p",NOW).next);expect(rows.find(row=>row.description==="purchase")?.minor).toBe(7_000);expect(rows.find(row=>row.description==="refund")?.minor).toBe(1_000);
  expect(rows.filter(row=>row.category==="Fees").reduce((s,r)=>s+r.minor,0)).toBe(50);expect(rows.filter(row=>row.category==="Taxes").reduce((s,r)=>s+r.minor,0)).toBe(20);
 });
 it("preserves loan principal and partial return without double counting income",async()=>{
  const input=await archive({movements:[movement("lent","out",10_000),movement("returned","in",4_000)],settlements:[{id:"loan",kind:"loan",original:ref("lent"),returns:[{...ref("returned"),principalMinor:4_000}],createdAt:NOW}]});
  const rows=accountingReportRows(planImport(emptyAccountingState("owner"),input,"p",NOW).next);expect(rows.filter(row=>row.category==="Food")).toEqual([]);expect(rows.filter(row=>row.category==="Taxes")).toHaveLength(2);
 });
 it("remaps transfer legs and balance references together",async()=>{
  const input=await archive({accounts:[account("cash"),account("savings")],movements:[{...movement("sent","out",5_000),status:"transfer"},{...movement("received","in",5_000,"savings"),status:"transfer"}],transfers:[{id:"transfer",outgoing:ref("sent"),incoming:ref("received"),createdAt:NOW}],snapshots:[{id:"balance",accountId:"cash",balanceMinor:19_965,occurredAt:NOW,sourceId:"sent",sourceMovementId:"sent",sourceFingerprint:"fp-sent"}]});
  const plan=planImport(emptyAccountingState("owner"),input,"p",NOW);expect(plan.next.transfers[0].outgoing.movementId).toBe(plan.next.movements[0].id);expect(plan.next.snapshots[0].sourceId).toBe(plan.next.movements[0].sourceId);expect(accountBalances(plan.next,"GHS").knownSubtotalMinor).toBe(19_965);expect(accountingReportRows(plan.next).every(row=>["Fees","Taxes"].includes(row.category))).toBe(true);
 });
 it("retains provenance across re-export so another app namespace adds no copies",async()=>{
  const input=await archive();const first=planImport(emptyAccountingState("owner"),input,"p",NOW);
  const core=Object.fromEntries(CORE_DOMAINS.map(domain=>[domain,first.next[domain].map(row=>{const copy={...row} as Record<string,unknown>;delete copy.ownerId;return copy;})])) as Datasets;
  const again=await readArchive(await createArchive({sourceApp:"alfred",namespace:"alfred:destination",exportedAt:NOW,timezone:"Africa/Accra",currency:"GHS",coverage:[],datasets:core}));
  const repeat=planImport(first.next,again,"p2",NOW);expect(repeat.duplicates).toBe(2);expect(repeat.conflicts).toEqual([]);
 });
});
