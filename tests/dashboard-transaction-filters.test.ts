import { describe, expect, it } from "vitest";
import { filterOverviewTransactions } from "@/app/dashboard/transactions-table";
import type { LedgerRow } from "@/lib/finance/analytics";

const row = (id: string, date: string, minor: number, type: LedgerRow["type"], category: string, description: string): LedgerRow => ({ id, date, minor, type, category, description, amount: (minor / 100).toFixed(2), currency: "GHS", paymentMethod: "Synthetic account" });
const records = [
  row("accounting:market", "2026-11-02", 2500, "expense", "Food", "Market groceries"),
  row("payday", "2026-11-04", 90000, "income", "Salary", "Monthly pay"),
  row("bus", "2026-11-03", 1500, "expense", "Transport", "Bus fare"),
  row("refund-adjustment", "2026-11-01", -500, "expense", "Food", "Market adjustment"),
];
const defaults = { search: "", type: "all", category: "all", sort: "date-desc" } as const;

describe("Overview transaction filters", () => {
  it("orders the full source newest first without changing source data or durable IDs", () => {
    const before = structuredClone(records);
    expect(filterOverviewTransactions(records, defaults).map((item) => item.id)).toEqual(["payday", "bus", "accounting:market", "refund-adjustment"]);
    expect(records).toEqual(before);
  });

  it("combines a case-insensitive trimmed search with type and category", () => {
    expect(filterOverviewTransactions(records, { ...defaults, search: "  MARKET  ", type: "expense", category: "Food" }).map((item) => item.id)).toEqual(["accounting:market", "refund-adjustment"]);
    expect(filterOverviewTransactions(records, { ...defaults, search: "Market", type: "income", category: "Food" })).toEqual([]);
  });

  it("searches category names as well as descriptions", () => {
    expect(filterOverviewTransactions(records, { ...defaults, search: "transport" }).map((item) => item.id)).toEqual(["bus"]);
  });

  it("retains signed accounting adjustments when sorting by amount", () => {
    expect(filterOverviewTransactions(records, { ...defaults, sort: "amount-asc" }).map((item) => item.id)).toEqual(["refund-adjustment", "bus", "accounting:market", "payday"]);
    expect(filterOverviewTransactions(records, { ...defaults, sort: "amount-desc" }).map((item) => item.id)).toEqual(["payday", "accounting:market", "bus", "refund-adjustment"]);
    expect(records.find((item) => item.id === "refund-adjustment")?.minor).toBe(-500);
  });

  it("supports oldest first and a cleared filter without truncating the source collection", () => {
    expect(filterOverviewTransactions(records, { ...defaults, sort: "date-asc" }).map((item) => item.id)).toEqual(["refund-adjustment", "accounting:market", "bus", "payday"]);
    expect(filterOverviewTransactions(records, defaults)).toHaveLength(records.length);
  });

  it("handles empty data and categories with no matches", () => {
    expect(filterOverviewTransactions([], defaults)).toEqual([]);
    expect(filterOverviewTransactions(records, { ...defaults, category: "Gift" })).toEqual([]);
  });
});
