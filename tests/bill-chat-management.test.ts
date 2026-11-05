import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SupabaseSettings } from "@/lib/config";
import { handleBillManagement, executeBillManagement } from "@/lib/finance/bill-management";
import { billManagementActionSchema, billManagementPendingSchema, type BillManagementAction, type BillManagementPending } from "@/lib/finance/bill-management-schema";
import { createSupabaseBillStore, MemoryBillStore, type BillRecord } from "@/lib/finance/bills";
import type { ActionContext } from "@/lib/finance/action-router";
import { MemoryFinanceStore } from "@/lib/finance/memory-store";
import { decidePending } from "@/lib/finance/pending";
import { profile } from "./helpers";

const mock = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/supabase/connection", () => ({ query: mock.query, withTransaction: async (_settings: unknown, fn: () => Promise<unknown>) => fn() }));

const OWNER = "00000000-0000-4000-8000-000000000042", OTHER = "00000000-0000-4000-8000-000000000043";
const NOW = new Date("2026-11-05T15:00:00.000Z");
const sample = (patch: Partial<BillRecord> = {}): BillRecord => ({ id: "00000000-0000-4000-8000-000000000001", ownerId: OWNER,
  name: "Fictional fibre", nextDate: "2026-12-10", amount: "240.00", currency: "GHS", cadence: "monthly", active: true,
  createdAt: "2026-11-01T12:00:00.000Z", updatedAt: "2026-11-01T12:00:00.000Z", ...patch });
const create: BillManagementAction = { type: "create_bill", name: "Fictional fibre", next_date: "2026-12-10", amount: "240.00", currency: "GHS", cadence: "monthly" };
function setup() {
  const finance = new MemoryFinanceStore(), bills = new MemoryBillStore();
  let sequence = 10;
  const ctx: ActionContext & { bills: MemoryBillStore } = { profile: profile(42, { profileId: OWNER }), store: finance, bills, now: NOW,
    updateId: 18, chatId: 100, confirmTransactions: "auto", pendingTtlMs: 600_000,
    createId: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12,"0")}`, createActionId: () => `billaction${++sequence}` };
  return { finance, bills, ctx };
}
async function proposed(action: BillManagementAction, ctx: ReturnType<typeof setup>["ctx"]) {
  ctx.updateId += 1;
  const response = await handleBillManagement(action,ctx);
  if (response.kind !== "confirm") throw new Error(response.text);
  const row = await ctx.store.getPendingAction(response.actionId);
  const payload = billManagementPendingSchema.parse(JSON.parse(row!.payloadJson));
  return { response, payload };
}
afterEach(() => { mock.query.mockReset(); });

describe("bill conversational management", () => {
  it("asks for missing create details without assuming currency, schedule, date or variable amount", async () => {
    const { ctx, bills, finance } = setup();
    const answer = await handleBillManagement({ type: "create_bill", name: "Fictional fibre" },ctx);
    expect(answer.kind).toBe("text");
    expect(answer.text).toContain("next due date, currency, repeat schedule");
    expect(answer.text).toContain("amount (or say it varies)");
    expect(await bills.list(OWNER)).toEqual([]);
    expect(await finance.listPendingActions(OWNER)).toEqual([]);
  });

  it("creates a full reviewed bill once after confirmation and keeps variable amounts explicit", async () => {
    const { ctx,bills } = setup();
    const { response,payload } = await proposed({ ...create, amount: null },ctx);
    expect(response.text).toContain("variable amount (GHS)");
    expect(response.text).toContain("tracking active");
    expect(await bills.list(OWNER)).toEqual([]);
    expect((await decidePending({ decision: "confirm",actionId: response.actionId,chatId: "100" },ctx)).text).toContain("Tracked Fictional fibre");
    expect(await bills.list(OWNER)).toMatchObject([{ name: "Fictional fibre",amount: null,cadence: "monthly",currency: "GHS",nextDate: "2026-12-10" }]);
    expect((await executeBillManagement(payload,ctx)).text).toContain("already saved");
    expect(await bills.list(OWNER)).toHaveLength(1);
  });

  it("cancels, expires and rejects confirmations belonging to another owner", async () => {
    const { ctx,bills } = setup();
    const { response } = await proposed(create,ctx);
    expect((await decidePending({ decision: "confirm",actionId: response.actionId,chatId: "100" },{ ...ctx, profile: profile(43,{ profileId: OTHER }) })).text).toContain("isn't for this chat");
    await decidePending({ decision: "cancel",actionId: response.actionId,chatId: "100" },ctx);
    expect(await bills.list(OWNER)).toEqual([]);
    const expired = await proposed(create,ctx);
    const late = { ...ctx,now: new Date(NOW.getTime()+700_000) };
    expect((await decidePending({ decision: "confirm",actionId: expired.response.actionId,chatId: "100" },late)).text).toContain("expired");
    expect(await bills.list(OWNER)).toEqual([]);
  });

  it("uses strict reads and reports unavailability instead of a false empty list", async () => {
    const { ctx,bills } = setup();
    bills.strictList = vi.fn().mockRejectedValue(new Error("synthetic unavailable"));
    expect((await handleBillManagement({ type: "get_bills" },ctx)).text).toContain("can't manage saved bills");
    expect((await handleBillManagement(create,ctx)).text).toContain("can't manage saved bills");
    expect(await bills.list(OWNER)).toEqual([]);
  });

  it("lists active records only unless paused bills are requested, scoped to the owner", async () => {
    const { ctx,bills } = setup();
    bills.bills = [sample(),sample({ id: "00000000-0000-4000-8000-000000000002",name: "Fictional music",active: false }),sample({ ownerId: OTHER,name: "Private service" })];
    const active = await handleBillManagement({ type: "get_bills" },ctx);
    expect(active.text).toContain("Fictional fibre"); expect(active.text).not.toContain("Fictional music"); expect(active.text).not.toContain("Private service");
    expect((await handleBillManagement({ type: "get_bills",include_inactive: true },ctx)).text).toContain("Fictional music");
    expect((await handleBillManagement({ type: "get_bills",name: "Fictional fibre" },ctx)).text).toContain("not evidence of payments");
  });

  it("bounds bill lists and ambiguity choices with a remaining count", async () => {
    const { ctx,bills } = setup();
    bills.bills = Array.from({ length: 22 },(_,index) => sample({ id: `00000000-0000-4000-8000-${String(index+1).padStart(12,"0")}` }));
    const list = await handleBillManagement({ type: "get_bills" },ctx);
    expect(list.text).toContain("2 more bills are not shown");
    expect(list.text).not.toContain("00000000-0000-4000-8000-000000000021");
    const choices = await handleBillManagement({ type: "delete_bill",name: "Fictional fibre" },ctx);
    expect(choices.text).toContain("2 more matching bills are not shown");
  });

  it("updates only provided fields and reviews exact before/after, including fixed to variable amounts", async () => {
    const { ctx,bills } = setup(); bills.bills = [sample({ active: false })];
    const { response,payload } = await proposed({ type: "update_bill",name: "fictional FIBRE",changes: { amount: null,next_date: "2026-12-20" } },ctx);
    expect(response.text).toContain("Before:"); expect(response.text).toContain("After:"); expect(response.text).toContain("GH₵240.00");
    expect(response.text).toContain("variable amount (GHS)");
    expect((await bills.list(OWNER))[0].amount).toBe("240.00");
    expect((await executeBillManagement(payload,ctx)).text).toContain("Updated");
    expect((await bills.list(OWNER))[0]).toMatchObject({ amount: null,nextDate: "2026-12-20",active: false,currency: "GHS",cadence: "monthly" });
    expect((await executeBillManagement(payload,ctx)).text).toContain("already saved");
  });

  it("pauses and resumes tracking without claiming to cancel a provider", async () => {
    const { ctx,bills } = setup(); bills.bills = [sample()];
    const paused = await proposed({ type: "set_bill_active",name: "Fictional fibre",active: false },ctx);
    expect(paused.response.text).toContain("does not pay or cancel");
    await executeBillManagement(paused.payload,ctx);
    expect((await bills.list(OWNER))[0].active).toBe(false);
    const resumed = await proposed({ type: "set_bill_active",name: "Fictional fibre",active: true },ctx);
    expect((await executeBillManagement(resumed.payload,ctx)).text).toContain("Resumed");
    expect((await bills.list(OWNER))[0].active).toBe(true);
  });

  it("requires unambiguous exact targets and never creates a missing update target", async () => {
    const { ctx,bills } = setup(); bills.bills = [sample(),sample({ id: "00000000-0000-4000-8000-000000000002" })];
    const ambiguous = await handleBillManagement({ type: "delete_bill",name: "Fictional fibre" },ctx);
    expect(ambiguous.text).toContain("More than one");
    expect(ambiguous.text).toContain("00000000-0000-4000-8000-000000000001");
    expect(ambiguous.text).toContain("00000000-0000-4000-8000-000000000002");
    expect((await handleBillManagement({ type: "delete_bill" },ctx)).text).toContain("Which saved bill");
    expect((await handleBillManagement({ type: "update_bill",name: "Fictional",changes: { amount: "15.00" } },ctx)).text).toContain("couldn't find");
    expect((await handleBillManagement({ type: "update_bill",bill_id: "00000000-0000-4000-8000-000000000999",changes: { amount: "15.00" } },ctx)).text).toContain("couldn't find");
    await expect(bills.save(OWNER,{ id: "00000000-0000-4000-8000-000000000999",name: "Missing",nextDate: "2026-12-10",amount: "2.00",currency: "GHS",cadence: "once" })).rejects.toThrow("no longer available");
    expect(await bills.list(OWNER)).toHaveLength(2);
  });

  it("rejects stale updates and deletions atomically", async () => {
    const { ctx,bills } = setup(); bills.bills = [sample()];
    const update = await proposed({ type: "update_bill",name: "Fictional fibre",changes: { amount: "250.00" } },ctx);
    const deletion = await proposed({ type: "delete_bill",name: "Fictional fibre" },ctx);
    bills.bills[0].amount = "275.00";
    expect((await executeBillManagement(update.payload,ctx)).text).toContain("changed since I asked");
    expect((await executeBillManagement(deletion.payload,ctx)).text).toContain("changed since I asked");
    expect((await bills.list(OWNER))[0].amount).toBe("275.00");
    const exact = await proposed({ type: "delete_bill",bill_id: sample().id },ctx);
    expect((await executeBillManagement(exact.payload,ctx)).text).toContain("Removed Fictional fibre");
    expect(await bills.list(OWNER)).toEqual([]);
    expect((await executeBillManagement(exact.payload,ctx)).text).toContain("no longer available");
  });

  it("rejects forged cross-owner payloads and invalid model details", async () => {
    const { ctx,bills } = setup(); bills.bills = [sample({ ownerId: OTHER })];
    const forged: BillManagementPending = { type: "delete_bill",originUpdateId: "1",before: sample({ ownerId: OTHER }) };
    expect((await executeBillManagement(forged,ctx)).text).toContain("no longer available");
    expect(await bills.list(OTHER)).toHaveLength(1);
    for (const invalid of [ { ...create,amount: "-1.00" },{ ...create,next_date: "2026-02-30" },{ ...create,cadence: "daily" },{ ...create,currency: "usd" }]) expect(billManagementActionSchema.safeParse(invalid).success).toBe(false);
    expect((await handleBillManagement({ ...create,next_date: "2026-02-30" },ctx)).text).toContain("aren't valid");
    expect(await bills.list(OWNER)).toEqual([]);
  });
});

describe("bill confirmed SQL writes", () => {
  it("preserves exact microsecond snapshots, rejects sub-millisecond races, and scopes every write", async () => {
    const db = new PGlite();
    try {
      await db.exec(`create table public.bills (id uuid primary key default gen_random_uuid(),owner_id uuid not null,name text not null,next_date date not null,amount numeric(16,2),currency text not null,cadence text not null,active boolean not null,created_at timestamptz not null default now(),updated_at timestamptz not null default now());`);
      mock.query.mockImplementation(async (_settings: unknown,sql: string,values: unknown[]) => (await db.query(sql,values)).rows);
      const store = createSupabaseBillStore({} as SupabaseSettings);
      await db.query(`insert into bills (id,owner_id,name,next_date,amount,currency,cadence,active,created_at,updated_at) values ($1,$2,'Fictional fibre','2026-12-10',240,'GHS','monthly',true,'2026-11-01T12:00:00.123456Z','2026-11-01T12:00:00.654321Z')`,[sample().id,OWNER]);
      const before = (await store.strictList!(OWNER))[0];
      expect(before.createdAt).toBe("2026-11-01T12:00:00.123456Z"); expect(before.updatedAt).toBe("2026-11-01T12:00:00.654321Z");
      const after = { ...before,amount: null,updatedAt: NOW.toISOString() };
      expect(await store.applyConfirmed!(OTHER,{ kind: "update",before,after })).toBe("missing");
      expect(await store.applyConfirmed!(OWNER,{ kind: "update",before,after })).toBe("applied");
      expect(await store.applyConfirmed!(OWNER,{ kind: "update",before,after })).toBe("already_applied");
      const current = (await store.strictList!(OWNER))[0];
      await db.query(`update bills set updated_at='2026-11-05T15:00:00.000001Z' where id=$1`,[current.id]);
      expect(await store.applyConfirmed!(OWNER,{ kind: "delete",before: current })).toBe("stale");
      expect(await store.applyConfirmed!(OWNER,{ kind: "update",before: current,after: { ...current,active: false,updatedAt: "2026-11-05T16:00:00.000Z" } })).toBe("stale");
      const precise = (await store.strictList!(OWNER))[0];
      expect(await store.applyConfirmed!(OWNER,{ kind: "delete",before: precise })).toBe("applied");
      const created = sample({ id: "00000000-0000-4000-8000-000000000099",createdAt: NOW.toISOString(),updatedAt: NOW.toISOString() });
      expect(await store.applyConfirmed!(OWNER,{ kind: "create",bill: created })).toBe("applied");
      expect(await store.applyConfirmed!(OWNER,{ kind: "create",bill: created })).toBe("already_applied");
      expect(await store.applyConfirmed!(OTHER,{ kind: "create",bill: { ...created,ownerId: OTHER } })).toBe("missing");
      await expect(store.save(OWNER,{ id: sample().id,name: "Missing",nextDate: "2026-12-10",amount: "2.00",currency: "GHS",cadence: "once" })).rejects.toThrow("no longer available");
      expect(await store.strictList!(OWNER)).toHaveLength(1);
      expect(await store.strictList!(OTHER)).toEqual([]);
      await db.exec("drop table bills");
      await expect(store.strictList!(OWNER)).rejects.toThrow();
      expect(await store.list(OWNER)).toEqual([]);
    } finally { await db.close(); }
  });
});
