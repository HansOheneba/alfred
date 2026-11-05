import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DashboardClient } from "@/app/dashboard/dashboard-client";
import { formatMinor } from "@/lib/finance/money";
import type { Ledger } from "@/lib/web/ledger";
import { buildOverviewSummary } from "@/lib/web/overview-summary";
import { overviewTransactionQueryKey } from "@/lib/web/overview-transactions";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

describe("Overview separated summary and transaction-page display", () => {
  it("renders full totals with 15 details on both layouts and offers the remaining complete history", () => {
    const ledger: Ledger = { today: "2026-11-05", currency: "GHS", rows: Array.from({ length: 35 }, (_, index) => ({ id: `fictional:${index}`, date: "2026-11-04", type: "expense", amount: "1.00", minor: 100, currency: "GHS", category: "Food", description: `Fictional visible purchase ${index}`, paymentMethod: "Fictional wallet" })), budgets: [], goals: [], insights: [], owed: [], owe: [], bank: { connected: false, lastUsedAt: null, lastEmptyAt: null, accountNames: [], needsLabel: [], balances: [] } };
    const summary = buildOverviewSummary(ledger);
    const page = { rows: ledger.rows.slice(0, 15), total: 35, categories: ["Food"], nextCursor: "fictional-next-page", version: "a".repeat(64), queryKey: overviewTransactionQueryKey({ preset: "this_month", category: null, filters: { search: "", type: "all", category: "all", sort: "date-desc" } }) };
    const html = renderToStaticMarkup(createElement(DashboardClient, { ledger: { ...ledger, rows: [] }, overview: summary, transactions: { ownerId: "fictional-owner", initialPage: page }, name: "" }));
    expect(html).toContain(formatMinor(3500, "GHS"));
    expect(html.match(/aria-label="View details for Fictional visible purchase /g)).toHaveLength(30);
    expect(html).toContain("Showing 15 of 35"); expect(html).toContain("Show more");
    expect(html).toContain("Fictional visible purchase 14"); expect(html).not.toContain("Fictional visible purchase 15");
    expect(html).not.toContain("6 of 15"); expect(html).not.toContain("No spending or income is recorded");
  });
});
