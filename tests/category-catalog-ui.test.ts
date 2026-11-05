import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/categories/route";
import { CATEGORY_SESSION_CHANGED, CategoryCatalogProvider, loadOwnedCategories } from "@/app/components/category-catalog";
import { prepareOverviewPlan } from "@/app/dashboard/overview-quick-actions";
import { prepareTransactionEdit } from "@/app/dashboard/transaction-edit-review";
import type { LedgerRow } from "@/lib/finance/analytics";
import type { CategoryRecord } from "@/lib/finance/types";

const mocks = vi.hoisted(() => ({ owner: vi.fn() }));
vi.mock("@/lib/web/api", async original => ({ ...await original<typeof import("@/lib/web/api")>(), requireOwner: mocks.owner }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const OWNER = "fictional-category-owner";
const category: CategoryRecord = { categoryId: "fictional-shopping", userId: OWNER, name: "Shopping", type: "expense", createdAt: "2026-11-05T12:00:00Z", rowNumber: 1 };
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("owner-scoped category suggestions", () => {
  it("accepts only the owner who opened the screen and sends an uncached authenticated read", async () => {
    const request = vi.fn(async () => Response.json({ ok: true, ownerId: OWNER, categories: [category] }));
    const signal = new AbortController().signal;
    await expect(loadOwnedCategories(OWNER, signal, request)).resolves.toEqual([category]);
    expect(request).toHaveBeenCalledExactlyOnceWith("/api/categories", { cache: "no-store", credentials: "same-origin", signal });
  });
  it.each(["another-fictional-owner", undefined])("rejects a changed or missing session owner (%s)", async ownerId => {
    const request = vi.fn(async () => Response.json({ ok: true, ownerId, categories: [category] }));
    await expect(loadOwnedCategories(OWNER, new AbortController().signal, request)).rejects.toThrow(CATEGORY_SESSION_CHANGED);
  });
  it.each([
    { ...category, userId: "another-fictional-owner" },
    { ...category, type: "unsupported" },
    { ...category, name: "" },
  ])("rejects foreign or malformed suggestions", async item => {
    const request = vi.fn(async () => Response.json({ ok: true, ownerId: OWNER, categories: [item] }));
    await expect(loadOwnedCategories(OWNER, new AbortController().signal, request)).rejects.toThrow("could not be loaded");
  });
  it("does not load private data while rendering", () => {
    const network = vi.fn(() => { throw new Error("No request during render"); });
    vi.stubGlobal("fetch", network);
    const html = renderToStaticMarkup(createElement(CategoryCatalogProvider, { ownerId: OWNER, refreshKey: "dashboard" }, createElement("p", null, "Unchanged content")));
    expect(html).toContain("Unchanged content"); expect(network).not.toHaveBeenCalled();
  });
  it("exposes only authenticated, stamped, uncached owner categories", async () => {
    mocks.owner.mockResolvedValue({ profile: { profileId: OWNER }, store: { listCategories: async () => [category, { ...category, userId: "another-fictional-owner" }] } });
    const response = await GET();
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(await response.json()).toEqual({ ok: true, ownerId: OWNER, categories: [category] });
    mocks.owner.mockResolvedValue(new Response(null, { status: 401 }));
    expect((await GET()).status).toBe(401);
  });
  it("keeps built-in screens usable when the store does not support custom categories", async () => {
    mocks.owner.mockResolvedValue({ profile: { profileId: OWNER }, store: {} });
    const response = await GET();
    expect(await response.json()).toEqual({ ok: true, ownerId: OWNER, categories: [] });
  });
});

describe("custom category draft reviews", () => {
  it("allows an existing custom expense category and rejects a different transaction type", () => {
    const draft = { kind: "budget" as const, category: "shopping", amount: "2000", period: "2026-11" };
    expect(prepareOverviewPlan(draft, "GHS", [], [category])).toEqual({ ok: true, review: { kind: "budget", payload: { category: "Shopping", amount: "2000.00", period: "2026-11" } } });
    expect(prepareOverviewPlan(draft, "GHS").ok).toBe(false);
    expect(prepareOverviewPlan(draft, "GHS", [], [{ ...category, type: "income" }]).ok).toBe(false);
  });
  it("reviews a custom transaction category change without inventing new categories", () => {
    const row: LedgerRow = { id: "fictional-transaction", type: "expense", date: "2026-11-05", category: "Food", amount: "30.00", minor: 3000, currency: "GHS", description: "Sample item", paymentMethod: "Cash" };
    const draft = { ...row, category: "shopping", includedFee: "" };
    expect(prepareTransactionEdit(row, draft, [category])).toMatchObject({ ok: true, review: { changes: { category: "Shopping" } } });
    expect(prepareTransactionEdit(row, draft).ok).toBe(false);
    expect(prepareTransactionEdit(row, { ...draft, type: "income" }, [category]).ok).toBe(false);
  });
});
