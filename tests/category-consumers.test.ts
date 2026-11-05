import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as saveBudget } from "@/app/api/budgets/route";
import { PATCH as editTransaction } from "@/app/api/transactions/route";
import { MemoryFinanceStore } from "@/lib/finance/memory-store";
import { normalizeDrafts } from "@/lib/finance/transactions";
import { trackTurnData } from "@/lib/conversation/turn-data";
import type { StudioDeps } from "@/lib/studio/handle";
import { expense, NOW, profile } from "./helpers";

const mocks = vi.hoisted(() => ({ requireOwner: vi.fn() }));
vi.mock("@/lib/web/api", async original => ({ ...await original<typeof import("@/lib/web/api")>(), requireOwner: mocks.requireOwner }));
const request = (method: string, body: unknown) => new Request("https://alfred.invalid/api/finance", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const category = (userId = "42", name = "Shopping", type: "expense" | "income" = "expense") => ({ categoryId: `${userId}-${name}`, userId, name, type, createdAt: NOW.toISOString() });

describe("custom category consumers", () => {
  let store: MemoryFinanceStore;
  beforeEach(() => {
    store = new MemoryFinanceStore();
    mocks.requireOwner.mockResolvedValue({ profile: profile(), store });
  });

  it("uses only saved categories belonging to the draft owner and transaction type", async () => {
    const own = await store.createCategory(category());
    const foreign = await store.createCategory(category("99", "Foreign category"));
    const income = await store.createCategory(category("42", "Royalties", "income"));
    const draft = { transaction_type: "expense" as const, amount: "25.00", currency: "GHS", category: "shopping", description: "Fictional shopping" };
    expect(normalizeDrafts([draft], profile(), "2026-10-11", [own, foreign, income])).toMatchObject({ ok: true, drafts: [{ category: "Shopping" }] });
    expect(normalizeDrafts([{ ...draft, category: "Foreign category" }], profile(), "2026-10-11", [own, foreign]).ok).toBe(false);
    expect(normalizeDrafts([{ ...draft, category: "Royalties" }], profile(), "2026-10-11", [income]).ok).toBe(false);
  });

  it("accepts an owner's custom budget category without allowing client ownership or category invention", async () => {
    await store.createCategory(category());
    await store.createCategory(category("99", "Private category"));
    const input = { category: "shopping", amount: "2000", period: "2026-11", userId: "99", currency: "USD" };
    expect((await saveBudget(request("POST", input))).status).toBe(200);
    expect(await store.listBudgets("42")).toMatchObject([{ category: "Shopping", amount: "2000.00", currency: "GHS", userId: "42" }]);
    expect(await store.listBudgets("99")).toEqual([]);
    for (const name of ["Private category", "Invented category"]) expect((await saveBudget(request("POST", { ...input, category: name }))).status).toBe(400);
  });

  it("validates custom categories when editing a native transaction", async () => {
    await store.createCategory(category());
    await store.createCategory(category("99", "Private category"));
    const row = await store.appendTransaction(expense());
    expect((await editTransaction(request("PATCH", { transactionId: row.transactionId, changes: { category: "Shopping" } }))).status).toBe(200);
    expect((await store.listTransactions("42"))[0].category).toBe("Shopping");
    expect((await editTransaction(request("PATCH", { transactionId: row.transactionId, changes: { category: "Private category" } }))).status).toBe(400);
    expect((await editTransaction(request("PATCH", { transactionId: row.transactionId, changes: { category: "Shopping", transactionType: "income" } }))).status).toBe(400);
  });

  it("invalidates turn snapshots after category creation and its combined budget write", async () => {
    const tracked = trackTurnData({ store } as unknown as StudioDeps);
    const before = tracked.deps.store.listCategories!("42");
    expect(await before).toEqual([]);
    await tracked.deps.store.createCategory!(category(), { budgetId: "fictional-budget", userId: "42", category: "Shopping", amount: "2000.00", currency: "GHS", period: "2026-11", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
    expect(tracked.changed()).toBe(true);
    expect(tracked.deps.store.listCategories!("42")).not.toBe(before);
    expect(await tracked.deps.store.listCategories!("42")).toHaveLength(1);
    expect(await store.listBudgets("42")).toHaveLength(1);
  });
});
