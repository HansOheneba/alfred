import { describe, expect, it } from "vitest";
import { DEFAULT_OVERVIEW_VIEW, overviewScrollPosition, overviewViewFromParams, overviewViewHref } from "@/app/dashboard/overview-view";

describe("Overview report history", () => {
  it("round trips report preferences without dropping transaction filters or a section anchor", () => {
    const view = { preset: "last_3_months" as const, category: "Rent & home", dailyMode: "cumulative" as const, insightsOpen: true };
    const href = overviewViewHref("/dashboard?tx_q=sample&tx_type=expense#overview-transactions", view);
    const url = new URL(href, "https://alfred.invalid");
    expect(overviewViewFromParams(url.searchParams)).toEqual(view);
    expect(url.searchParams.get("tx_q")).toBe("sample");
    expect(url.searchParams.get("tx_type")).toBe("expense");
    expect(url.hash).toBe("#overview-transactions");
  });

  it("returns to a concise default URL while retaining unrelated read-only state", () => {
    expect(overviewViewHref("/dashboard?range=all&category=Food&chart=cumulative&insights=1&tx_q=sample", DEFAULT_OVERVIEW_VIEW)).toBe("/dashboard?tx_q=sample");
  });

  it("rejects unknown modes and unbounded category text", () => {
    const params = new URLSearchParams({ range: "prototype", category: "x".repeat(41), chart: "other", insights: "yes" });
    expect(overviewViewFromParams(params)).toEqual(DEFAULT_OVERVIEW_VIEW);
    expect(overviewViewFromParams(new URLSearchParams({ range: "__proto__" })).preset).toBe("this_month");
  });

  it("restores only a finite bounded history scroll position", () => {
    for (const value of [undefined, null, "300", -1, NaN, Infinity, 2_000_001]) expect(overviewScrollPosition(value)).toBeNull();
    expect(overviewScrollPosition(0)).toBe(0);
    expect(overviewScrollPosition(4826.5)).toBe(4826.5);
  });
});
