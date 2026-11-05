import { getGettingStartedState } from "@/app/components/getting-started-state";
import {
  RANGE_LABELS, accountTotals, buildSankeyModel, categoryTotals, dailySeries, inRows,
  monthlySeries, presetRange, previousRange, sumMinor, topDescriptions, weekdaySeries,
  weeklyPace, type RangePreset,
} from "@/lib/finance/analytics";
import type { Ledger } from "./ledger";

export function overviewYearRange(today: string) {
  const [year, month] = today.split("-").map(Number);
  return { start: new Date(Date.UTC(year, month - 12, 1)).toISOString().slice(0, 10), end: new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10) };
}

/** All analytics use the complete canonical report; the transaction page never drives totals. */
export function buildOverviewSummary(ledger: Ledger) {
  const { currency, today } = ledger;
  const rows = ledger.rows.filter(row => row.currency === currency);
  const yearRange = overviewYearRange(today);
  const categoryRows = new Map<string, typeof rows>();
  for (const row of rows) {
    const group = categoryRows.get(row.category) ?? [];
    group.push(row); categoryRows.set(row.category, group);
  }
  const categoryTrends = Object.fromEntries([...categoryRows].map(([category, group]) => [category, monthlySeries(group, yearRange, currency).slice(-6).map(item => ({ label: item.label, spent: item.spent }))]));
  const reports = Object.fromEntries((Object.keys(RANGE_LABELS) as RangePreset[]).map(preset => {
    const range = presetRange(preset, today, rows), previous = previousRange(range);
    const expenses = inRows(rows, range, currency, "expense"), income = inRows(rows, range, currency, "income");
    const categories = categoryTotals(expenses);
    const expenseGroups = new Map<string, typeof expenses>();
    for (const row of expenses) {
      const group = expenseGroups.get(row.category) ?? [];
      group.push(row); expenseGroups.set(row.category, group);
    }
    return [preset, {
      range, previous, spent: sumMinor(expenses), earned: sumMinor(income),
      previousSpent: sumMinor(inRows(rows, previous, currency, "expense")),
      previousEarned: sumMinor(inRows(rows, previous, currency, "income")),
      categories, accounts: accountTotals(expenses), sankey: buildSankeyModel(income, expenses),
      daily: dailySeries(rows, { start: range.start, end: today < range.end && today >= range.start ? today : range.end }, currency),
      weekdays: weekdaySeries(expenses),
      transactionCategories: [...new Set([...expenses, ...income].map(row => row.category))].sort(),
      categoryDetails: Object.fromEntries(categories.map(({ category, minor, count }) => {
        return [category, { minor, count, descriptions: topDescriptions(expenseGroups.get(category) ?? []) }];
      })),
    }];
  })) as Record<RangePreset, OverviewReport>;
  return {
    reports, categoryTrends, pace: weeklyPace(rows, today, currency), monthly: monthlySeries(rows, yearRange, currency),
    totalRowCount: ledger.rows.length, currencyRowCount: rows.length,
    otherCurrencyCount: ledger.rows.length - rows.length, setup: getGettingStartedState(ledger),
  };
}

export type OverviewReport = {
  range: ReturnType<typeof presetRange>; previous: ReturnType<typeof previousRange>;
  spent: number; earned: number; previousSpent: number; previousEarned: number;
  categories: ReturnType<typeof categoryTotals>; accounts: ReturnType<typeof accountTotals>;
  sankey: ReturnType<typeof buildSankeyModel>; daily: ReturnType<typeof dailySeries>;
  weekdays: ReturnType<typeof weekdaySeries>; transactionCategories: string[];
  categoryDetails: Record<string, { minor: number; count: number; descriptions: ReturnType<typeof topDescriptions> }>;
};
export type OverviewSummary = ReturnType<typeof buildOverviewSummary>;
