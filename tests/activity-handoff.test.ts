import { describe, expect, it } from "vitest";
import { activityHref, overviewTransactionSearch, parseActivityHandoff, parseOverviewTransactionFilters } from "@/lib/web/activity-handoff";

describe("transaction drill-down view state", () => {
  it("carries the exact period, currency, category, search, type and sort into Activity", () => {
    const selected = { start: "2026-11-01", end: "2026-11-30", currency: "GHS", category: "Rent & home", search: "Sample payment", type: "expense" as const, sort: "amount-desc" as const };
    const href = activityHref(selected);
    expect(href.startsWith("/accounts?tab=activity&")).toBe(true);
    expect(parseActivityHandoff(new URL(href, "https://example.invalid").search)).toEqual(selected);
  });
  it("does not accept impossible or reversed dates and unknown selectors", () => {
    expect(parseActivityHandoff("?from=2026-02-31&to=not-a-date&type=delete&sort=sql&currency=ghs")).toMatchObject({ start: "", end: "", type: "all", sort: "date-desc", currency: "" });
    expect(parseActivityHandoff("?from=2026-12-01&to=2026-11-01")).toMatchObject({ start: "", end: "" });
    expect(activityHref({ category: "all", search: " ", type: "all" })).toBe("/accounts?tab=activity");
  });
  it("bounds URL text and encodes characters as data rather than additional parameters", () => {
    expect(parseActivityHandoff(new URL(activityHref({ search: "A&B?type=income" }), "https://example.invalid").search)).toMatchObject({ search: "A&B?type=income", type: "all" });
    expect(parseActivityHandoff(`?category=${"x".repeat(41)}&q=${"x".repeat(201)}`)).toMatchObject({ search: "", category: "" });
  });
  it("updates table state without dropping report state, payment targets or unrelated parameters", () => {
    const before = "?range=last_month&category=Food&chart=cumulative&insights=open&payment=sample&tx_q=old";
    const next = overviewTransactionSearch(before, { search: "Coffee", type: "expense", category: "Food", sort: "amount-desc" });
    const params = new URLSearchParams(next);
    expect(params.get("range")).toBe("last_month"); expect(params.get("category")).toBe("Food"); expect(params.get("payment")).toBe("sample");
    expect(parseOverviewTransactionFilters(next)).toEqual({ search: "Coffee", type: "expense", category: "Food", sort: "amount-desc" });
    const cleared = new URLSearchParams(overviewTransactionSearch(next, { search: "", type: "all", category: "all", sort: "date-desc" }));
    expect([...cleared.keys()].some(key => key.startsWith("tx_"))).toBe(false);
    expect(cleared.get("range")).toBe("last_month");
  });
});
