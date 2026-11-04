import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOAN_START_HREF, OverviewPlanSummary, OverviewQuickAction, prepareOverviewPlan, type OverviewPlanDraft } from "@/app/dashboard/overview-quick-actions";
import { POST as saveBudget } from "@/app/api/budgets/route";
import { POST as createGoal } from "@/app/api/goals/route";
import type { LedgerBudget } from "@/lib/web/ledger";

const mocks = vi.hoisted(() => ({ requireOwner: vi.fn(), refresh: vi.fn(), saveBudget: vi.fn(), appendGoal: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/lib/web/api", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/web/api")>(), requireOwner: mocks.requireOwner }));
const budget: OverviewPlanDraft = { kind: "budget", category: "Food", amount: "800", period: "2026-11" };
const goal: OverviewPlanDraft = { kind: "goal", name: "Sample laptop", targetAmount: "3000", currentAmount: "0", targetDate: "2027-03-01" };
const existing: LedgerBudget = { budgetId: "sample-budget", category: "Food", period: "2026-11", amount: "500.00", currency: "GHS", spentMinor: 0, budgetMinor: 50000, remainingMinor: 50000 };
const network = vi.fn(() => { throw new Error("Rendering or reviewing must not save anything"); });
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal("fetch", network);
  mocks.requireOwner.mockResolvedValue({ profile: { profileId: "fictional-current-owner", currency: "GHS" }, store: { saveBudget: mocks.saveBudget, appendSavingsGoal: mocks.appendGoal } });
  mocks.saveBudget.mockImplementation(async entry => entry);
  mocks.appendGoal.mockImplementation(async entry => entry);
});
afterEach(() => { expect(network).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe("overview create-and-review actions", () => {
  it("offers working budget/goal buttons and a clearly labelled draft-only loan handoff", () => {
    for (const [kind, label] of [["budget", "Add budget"], ["goal", "Create goal"]] as const) {
      const html = renderToStaticMarkup(createElement(OverviewQuickAction, { kind, currency: "GHS", today: "2026-11-04", budgets: [] }));
      expect(html).toMatch(new RegExp(`<button[^>]*aria-haspopup="dialog"[^>]*>${label}<\\/button>`));
      expect(html).not.toContain("Ask Alfred");
      expect(html).not.toContain("<form");
    }
    const html = renderToStaticMarkup(createElement(OverviewQuickAction, { kind: "loan", currency: "GHS", today: "2026-11-04" }));
    expect(html).toContain("Record money lent");
    expect(html).toContain("details in Chat and confirm before saving");
    expect(html).toContain(LOAN_START_HREF.replaceAll("&", "&amp;"));
    const url = new URL(LOAN_START_HREF, "https://alfred.invalid");
    expect(url.pathname).toBe("/chat");
    expect(url.searchParams.get("question")).toContain("confirm the loan before saving");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("canonicalizes a valid draft without adding client ownership or currency to either request", () => {
    const preparedBudget = prepareOverviewPlan({ ...budget, amount: "GHS 1,234.5" }, "GHS");
    expect(preparedBudget).toEqual({ ok: true, review: { kind: "budget", payload: { category: "Food", amount: "1234.50", period: "2026-11" } } });
    const preparedGoal = prepareOverviewPlan({ ...goal, name: "  Sample laptop  ", currentAmount: "" }, "GHS");
    expect(preparedGoal).toEqual({ ok: true, review: { kind: "goal", payload: { name: "Sample laptop", targetAmount: "3000.00", currentAmount: "0.00", targetDate: "2027-03-01" } } });
    expect(mocks.saveBudget).not.toHaveBeenCalled(); expect(mocks.appendGoal).not.toHaveBeenCalled();
  });

  it("restates an existing same-month/category/currency budget as an update with old and new amounts", () => {
    const prepared = prepareOverviewPlan(budget, "GHS", [existing]);
    expect(prepared).toMatchObject({ ok: true, review: { kind: "budget", previousAmount: "500.00", payload: { amount: "800.00" } } });
    if (!prepared.ok) throw new Error("Expected synthetic review");
    const html = renderToStaticMarkup(createElement(OverviewPlanSummary, { review: prepared.review, currency: "GHS" }));
    expect(html).toContain("Update this monthly spending limit"); expect(html).toContain("Current limit"); expect(html).toContain("New limit");
    expect(html).toContain("GH₵500.00"); expect(html).toContain("GH₵800.00");
    expect(prepareOverviewPlan(budget, "USD", [existing])).not.toHaveProperty("review.previousAmount");
    expect(prepareOverviewPlan({ ...budget, period: "2026-12" }, "GHS", [existing])).not.toHaveProperty("review.previousAmount");
  });

  it.each(["0", "-1", "10.001", "10000000", "NaN", "1e3"])("rejects invalid budget amount %s before a write", amount => {
    expect(prepareOverviewPlan({ ...budget, amount }, "GHS").ok).toBe(false);
  });

  it("uses existing amount limits and real calendar schemas for budget and goal dates", () => {
    expect(prepareOverviewPlan({ ...budget, amount: "9999999.99" }, "GHS").ok).toBe(true);
    expect(prepareOverviewPlan({ ...budget, period: "2026-13" }, "GHS").ok).toBe(false);
    expect(prepareOverviewPlan({ ...budget, category: "unsupported category" }, "GHS").ok).toBe(false);
    for (const patch of [{ name: " " }, { name: "x".repeat(81) }, { targetAmount: "0" }, { targetAmount: "10000000" }, { currentAmount: "-1" }, { currentAmount: "1.001" }, { currentAmount: "10000000" }, { targetDate: "2027-02-29" }]) expect(prepareOverviewPlan({ ...goal, ...patch }, "GHS").ok).toBe(false);
    expect(prepareOverviewPlan({ ...goal, targetDate: "2028-02-29", currentAmount: "0" }, "GHS").ok).toBe(true);
    expect(prepareOverviewPlan({ ...goal, targetDate: "" }, "GHS").ok).toBe(true);
  });
});

describe("existing budget/goal API ownership boundaries", () => {
  const request = (payload: unknown) => new Request("https://alfred.invalid/api/plans", { method: "POST", body: JSON.stringify(payload), headers: { "content-type": "application/json" } });
  it("still requires authentication before a creation", async () => {
    mocks.requireOwner.mockResolvedValue(new Response(null, { status: 401 }));
    expect((await saveBudget(request(budget))).status).toBe(401);
    expect((await createGoal(request(goal))).status).toBe(401);
    expect(mocks.saveBudget).not.toHaveBeenCalled(); expect(mocks.appendGoal).not.toHaveBeenCalled();
  });
  it("derives owner/currency from the signed-in account rather than extra client fields", async () => {
    const preparedBudget = prepareOverviewPlan(budget, "GHS");
    const preparedGoal = prepareOverviewPlan(goal, "GHS");
    if (!preparedBudget.ok || !preparedGoal.ok) throw new Error("Expected synthetic reviews");
    expect((await saveBudget(request({ ...preparedBudget.review.payload, userId: "foreign-owner", currency: "USD" }))).status).toBe(200);
    expect((await createGoal(request({ ...preparedGoal.review.payload, userId: "foreign-owner", currency: "USD" }))).status).toBe(200);
    expect(mocks.saveBudget).toHaveBeenCalledWith(expect.objectContaining({ userId: "fictional-current-owner", currency: "GHS", category: "Food", amount: "800.00" }));
    expect(mocks.appendGoal).toHaveBeenCalledWith(expect.objectContaining({ userId: "fictional-current-owner", currency: "GHS", name: "Sample laptop", currentAmount: "0.00" }));
  });
  it("keeps server-side amount/date validation as the final guard", async () => {
    expect((await saveBudget(request({ category: "Food", amount: "-1", period: "2026-11" }))).status).toBe(400);
    expect((await createGoal(request({ name: "Sample goal", targetAmount: "100", currentAmount: "0", targetDate: "2027-02-29" }))).status).toBe(400);
    expect(mocks.saveBudget).not.toHaveBeenCalled(); expect(mocks.appendGoal).not.toHaveBeenCalled();
  });
});
