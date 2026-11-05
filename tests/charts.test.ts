import { describe, expect, it } from "vitest";

import { chartSummary, drawChart, type ChartQuery } from "@/lib/finance/charts";
import type { TransactionRecord } from "@/lib/finance/types";

const today = "2026-11-20";
const row = (date: string, type: "income" | "expense", amount: string, category: string, description: string, patch: Partial<Omit<TransactionRecord, "rowNumber">> = {}): TransactionRecord => ({
  transactionId: `${date}-${description}`, createdAt: `${date}T12:00:00.000Z`, transactionDate: date, userId: "42", type, amount, currency: "GHS", category, description,
  paymentMethod: "", notes: "", status: "active", updatedAt: `${date}T12:00:00.000Z`, sourceUpdateId: `test:${date}-${description}`, rowNumber: 0, ...patch,
});
const books = [
  row("2026-11-03", "expense", "50.00", "Food", "Waakye"),
  row("2026-11-04", "expense", "30.00", "Food", "Kelewele"),
  row("2026-11-12", "expense", "120.00", "Food", "Melcom"),
  row("2026-11-12", "expense", "40.00", "Transport", "Uber"),
  row("2026-11-13", "expense", "15.00", "Transport", "uber "),
  row("2026-11-01", "income", "2000.00", "Salary", "Salary"),
  row("2026-10-10", "expense", "100.00", "Food", "Shoprite"),
  row("2026-11-05", "expense", "999.00", "Food", "Deleted", { status: "deleted" }),
  row("2026-11-06", "expense", "10.00", "Food", "Dollars", { currency: "USD" }),
  row("2026-11-06", "expense", "77.00", "Food", "Someone else's", { userId: "43" }),
];
const draw = (query: Partial<ChartQuery>) => {
  const result = drawChart({ query: { measure: "spending", by: "category", period: "this_month", ...query }, transactions: books, userId: "42", currency: "GHS", today });
  if (!result.ok) throw new Error(result.message);
  return result.chart;
};

describe("charts drawn from the books", () => {
  it("adds up only the person's active payments in their currency, and says what it left out", () => {
    const chart = draw({});
    expect(chart.rows.map((item) => [item.label, item.minor, item.count])).toEqual([["Food", 20_000, 3], ["Transport", 5_500, 2]]);
    expect(chart.totalMinor).toBe(25_500);
    expect(chart.otherCurrencies).toEqual(["USD"]);
    expect(chart.rows[0].ask).toBe("Show my Food payments from 1 Nov 2026 to 30 Nov 2026");
  });

  it("buckets a month by week, stopping at today, and lines the previous month up against it", () => {
    const chart = draw({ by: "week", category: "Food", compare: true });
    expect(chart.subtitle).toBe("1 Nov to 20 Nov");
    expect(chart.rows.map((item) => item.label)).toEqual(["1 Nov", "2 Nov", "9 Nov", "16 Nov"]);
    expect(chart.rows.map((item) => item.minor)).toEqual([0, 8_000, 12_000, 0]);
    expect(chart.previousTotalMinor).toBe(10_000);
    expect(chart.previousLabel).toBe("1 Oct to 20 Oct");
    expect(chart.rows[1].ask).toBe("Show my Food payments from 2 Nov 2026 to 8 Nov 2026");
    expect(chartSummary(chart)).toContain("GH₵100.00 more than 1 Oct to 20 Oct (GH₵100.00)");
  });

  it("groups merchants regardless of case and spacing", () => {
    const chart = draw({ by: "merchant", category: "Transport" });
    expect(chart.rows).toEqual([expect.objectContaining({ label: "Uber", minor: 5_500, count: 2 })]);
  });

  it("charts net over time, and turns net by category into net by month", () => {
    const chart = draw({ measure: "net", by: "category", period: null, startDate: "2026-10-01", endDate: "2026-11-30" });
    expect(chart.by).toBe("month");
    expect(chart.rows.map((item) => [item.label, item.minor])).toEqual([["Oct", -10_000], ["Nov", 174_500]]);
    expect(chart.style).toBe("bar");
  });

  it("only draws a donut for parts of a whole, and a line only over time", () => {
    expect(draw({ style: "donut" }).style).toBe("donut");
    expect(draw({ style: "donut", by: "week" }).style).toBe("bar");
    expect(draw({ style: "line", by: "category" }).style).toBe("bar");
    expect(draw({ style: "line", by: "day" }).style).toBe("line");
  });

  it("switches days to weeks or months when the span is long", () => {
    expect(draw({ by: "day", period: null, startDate: "2026-01-01", endDate: "2026-11-20" }).by).toBe("month");
    expect(draw({ by: "day", period: null, startDate: "2026-07-01", endDate: "2026-11-20" }).by).toBe("week");
  });

  it("says plainly when there's nothing to chart", () => {
    const chart = draw({ period: "yesterday", category: "Transport" });
    expect(chartSummary(chart)).toMatch(/^Nothing recorded/);
  });
});

describe("comparing with before", () => {
  it("compares whole months with whole months, and a month so far with the same days last month", () => {
    const whole = drawChart({ query: { measure: "spending", by: "category", compare: true, period: "last_month" }, transactions: books, userId: "42", currency: "GHS", today });
    expect(whole.ok && whole.chart.previousLabel).toBe("Sep 2026");
    const sofar = drawChart({ query: { measure: "spending", by: "category", compare: true, period: "this_month" }, transactions: books, userId: "42", currency: "GHS", today });
    expect(sofar.ok && [sofar.chart.subtitle, sofar.chart.previousLabel]).toEqual(["1 Nov to 20 Nov", "1 Oct to 20 Oct"]);
    const march = drawChart({ query: { measure: "spending", by: "category", compare: true, period: "this_month" }, transactions: [], userId: "42", currency: "GHS", today: "2026-03-31" });
    expect(march.ok && march.chart.previousLabel).toBe("Feb 2026");
  });
});
