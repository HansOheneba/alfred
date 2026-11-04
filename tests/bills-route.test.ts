import type { z } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BillRecord } from "@/lib/finance/bills";
import { upcomingBills } from "@/lib/finance/bill-schedule";
const mocks = vi.hoisted(() => ({ owner: vi.fn(), list: vi.fn(), save: vi.fn(), setActive: vi.fn(), remove: vi.fn(), create: vi.fn() }));
vi.mock("@/lib/web/api", () => ({
  requireOwner: mocks.owner,
  fail: (text: string, status: number) => Response.json({ ok: false, text }, { status }),
  readBody: async (request: Request, schema: z.ZodType) => { try { const parsed = schema.safeParse(await request.json()); return parsed.success ? parsed.data : Response.json({ ok: false }, { status: 400 }); } catch { return Response.json({ ok: false }, { status: 400 }); } },
}));
vi.mock("@/lib/finance/bills", () => ({ createSupabaseBillStore: mocks.create, upcomingBills }));
vi.mock("@/lib/log", () => ({ logError: vi.fn() }));
import { POST } from "@/app/api/bills/route";
const OWNER = "00000000-0000-4000-8000-000000000001", BILL = "00000000-0000-4000-8000-000000000010", FOREIGN_BILL = "00000000-0000-4000-8000-000000000020";
const existing: BillRecord = { id: BILL, ownerId: OWNER, name: "Sample foreign-currency bill", nextDate: "2026-11-10", amount: "12.50", currency: "USD", cadence: "monthly", active: false, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
const payload = (extra: Record<string, unknown> = {}) => ({ action: "save", name: "Reviewed bill", nextDate: "2026-12-31", amount: "25.75", cadence: "yearly", ...extra });
const request = (body: unknown) => new Request("https://synthetic.invalid/api/bills", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
beforeEach(() => {
  vi.clearAllMocks(); mocks.owner.mockResolvedValue({ profile: { profileId: OWNER, currency: "GHS", timezone: "Africa/Accra" }, settings: { supabase: { synthetic: true } } });
  mocks.list.mockResolvedValue([structuredClone(existing)]); mocks.save.mockResolvedValue(existing); mocks.create.mockReturnValue({ list: mocks.list, save: mocks.save, setActive: mocks.setActive, remove: mocks.remove });
});
describe("bill edits preserve owned currency", () => {
  it("preserves the existing bill currency and paused state while applying reviewed schedule and amount", async () => {
    const result = await POST(request(payload({ id: BILL, currency: "EUR" })));
    expect(result.status).toBe(200); expect(mocks.list).toHaveBeenCalledWith(OWNER);
    expect(mocks.save).toHaveBeenCalledWith(OWNER, { id: BILL, name: "Reviewed bill", nextDate: "2026-12-31", amount: "25.75", currency: "USD", cadence: "yearly", active: false });
  });
  it("honours an explicit active-state edit without changing currency", async () => {
    expect((await POST(request(payload({ id: BILL, active: true })))).status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith(OWNER, expect.objectContaining({ currency: "USD", active: true }));
  });
  it("does not create a replacement when the requested bill is absent", async () => {
    mocks.list.mockResolvedValue([]);
    expect((await POST(request(payload({ id: BILL })))).status).toBe(404); expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.list).toHaveBeenCalledWith(OWNER);
  });
  it("never edits a foreign-owner record even if an adapter returns it", async () => {
    mocks.list.mockResolvedValue([{ ...existing, id: FOREIGN_BILL, ownerId: "00000000-0000-4000-8000-000000000002" }]);
    expect((await POST(request(payload({ id: FOREIGN_BILL })))).status).toBe(404);
    expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.list).toHaveBeenCalledWith(OWNER);
  });
  it("keeps new bills scoped to profile currency despite a forged currency field", async () => {
    expect((await POST(request(payload({ currency: "USD" })))).status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith(OWNER, expect.objectContaining({ id: undefined, currency: "GHS", active: true }));
  });
  it("does not query or save bills without authentication", async () => {
    mocks.owner.mockResolvedValue(new Response("Sign in", { status: 401 }));
    expect((await POST(request(payload({ id: BILL })))).status).toBe(401); expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it("rejects invalid amounts and keeps variable amounts null", async () => {
    expect((await POST(request(payload({ id: BILL, amount: "invalid" })))).status).toBe(400); expect(mocks.save).not.toHaveBeenCalled();
    expect((await POST(request(payload({ id: BILL, amount: null })))).status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith(OWNER, expect.objectContaining({ currency: "USD", amount: null }));
  });
});
