import { addDays, endOfMonth, inclusiveDays, toIso, type DateRange } from "@/lib/finance/dates";
import { toMinor } from "@/lib/finance/money";
import type { TransactionRecord } from "@/lib/finance/types";

/** A transaction trimmed to what the browser needs. Amounts are in minor units. */
export type LedgerRow = {
  id: string;
  date: string;
  type: "income" | "expense";
  minor: number;
  amount: string;
  currency: string;
  category: string;
  description: string;
  paymentMethod: string;
};

export function toLedgerRows(transactions: TransactionRecord[]): LedgerRow[] {
  return transactions
    .filter((item) => item.status === "active")
    .map((item) => ({
      id: item.transactionId,
      date: item.transactionDate,
      type: item.type,
      minor: toMinor(item.amount),
      amount: item.amount,
      currency: item.currency,
      category: item.category,
      description: item.description,
      paymentMethod: item.paymentMethod?.trim() || "Manual / cash",
    }))
    .sort((left, right) => right.date.localeCompare(left.date) || left.id.localeCompare(right.id));
}

export type RangePreset = "this_month" | "last_month" | "last_3_months" | "last_6_months" | "this_year" | "all";

export const RANGE_LABELS: Record<RangePreset, string> = {
  this_month: "This month",
  last_month: "Last month",
  last_3_months: "Last 3 months",
  last_6_months: "Last 6 months",
  this_year: "This year",
  all: "All time",
};

function monthStart(today: string, back: number): string {
  const [year, month] = today.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 - back, 1));
  return toIso(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

export function presetRange(preset: RangePreset, today: string, rows: LedgerRow[] = []): DateRange {
  if (preset === "this_month") return { start: monthStart(today, 0), end: endOfMonth(today) };
  if (preset === "last_month") {
    const start = monthStart(today, 1);
    return { start, end: endOfMonth(start) };
  }
  if (preset === "last_3_months") return { start: monthStart(today, 2), end: endOfMonth(today) };
  if (preset === "last_6_months") return { start: monthStart(today, 5), end: endOfMonth(today) };
  if (preset === "this_year") return { start: `${today.slice(0, 4)}-01-01`, end: `${today.slice(0, 4)}-12-31` };
  const earliest = rows.reduce((min, row) => (row.date < min ? row.date : min), today);
  return { start: earliest.slice(0, 8) + "01", end: endOfMonth(today) };
}

/** The same-length stretch just before a range, for "vs previous" comparisons. */
export function previousRange(range: DateRange): DateRange {
  const days = inclusiveDays(range);
  const end = addDays(range.start, -1);
  return { start: addDays(end, -(days - 1)), end };
}

export function inRows(rows: LedgerRow[], range: DateRange, currency: string, type?: "income" | "expense"): LedgerRow[] {
  return rows.filter(
    (row) => row.currency === currency && row.date >= range.start && row.date <= range.end && (!type || row.type === type),
  );
}

export function sumMinor(rows: LedgerRow[]): number {
  return rows.reduce((total, row) => total + row.minor, 0);
}

export function categoryTotals(rows: LedgerRow[]): { category: string; minor: number; count: number }[] {
  const totals = new Map<string, { minor: number; count: number }>();
  for (const row of rows) {
    const entry = totals.get(row.category) ?? { minor: 0, count: 0 };
    entry.minor += row.minor;
    entry.count += 1;
    totals.set(row.category, entry);
  }
  return [...totals.entries()]
    .map(([category, entry]) => ({ category, ...entry }))
    .sort((left, right) => right.minor - left.minor || left.category.localeCompare(right.category));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Spending and income per calendar month across a range. */
export function monthlySeries(rows: LedgerRow[], range: DateRange, currency: string) {
  const series: { month: string; label: string; spent: number; income: number }[] = [];
  let cursor = range.start.slice(0, 7);
  const last = range.end.slice(0, 7);
  while (cursor <= last) {
    const [year, month] = cursor.split("-").map(Number);
    series.push({ month: cursor, label: `${MONTHS[month - 1]}${year !== Number(last.slice(0, 4)) ? ` ${String(year).slice(2)}` : ""}`, spent: 0, income: 0 });
    const next = new Date(Date.UTC(year, month, 1));
    cursor = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  const byMonth = new Map(series.map((item) => [item.month, item]));
  for (const row of rows) {
    if (row.currency !== currency || row.date < range.start || row.date > range.end) continue;
    const bucket = byMonth.get(row.date.slice(0, 7));
    if (!bucket) continue;
    if (row.type === "expense") bucket.spent += row.minor;
    else bucket.income += row.minor;
  }
  return series;
}

/** Spending per day across a range, with a running total. */
export function dailySeries(rows: LedgerRow[], range: DateRange, currency: string) {
  const totals = new Map<string, number>();
  for (const row of inRows(rows, range, currency, "expense")) totals.set(row.date, (totals.get(row.date) ?? 0) + row.minor);
  const days: { date: string; label: string; spent: number; cumulative: number }[] = [];
  let running = 0;
  for (let date = range.start; date <= range.end; date = addDays(date, 1)) {
    const spent = totals.get(date) ?? 0;
    running += spent;
    days.push({ date, label: `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`, spent, cumulative: running });
  }
  return days;
}

/** Spending by weekday, Monday first, for spotting weekend habits. */
export function weekdaySeries(rows: LedgerRow[]) {
  const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const totals = names.map((label) => ({ label, spent: 0 }));
  for (const row of rows) {
    if (row.type !== "expense") continue;
    const [year, month, day] = row.date.split("-").map(Number);
    const index = (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
    totals[index].spent += row.minor;
  }
  return totals;
}

/** Where a category's money went, grouped by description. */
export function topDescriptions(rows: LedgerRow[], limit = 6) {
  const groups = new Map<string, { label: string; minor: number; count: number }>();
  for (const row of rows) {
    const key = row.description.trim().toLowerCase();
    const group = groups.get(key) ?? { label: row.description.trim(), minor: 0, count: 0 };
    group.minor += row.minor;
    group.count += 1;
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) => right.minor - left.minor).slice(0, limit);
}

/** Which account or payment method the period's spending came out of. */
export function accountTotals(rows: LedgerRow[]): { account: string; minor: number; count: number }[] {
  const totals = new Map<string, { minor: number; count: number }>();
  for (const row of rows) {
    if (row.type !== "expense" || row.minor <= 0) continue;
    const key = row.paymentMethod?.trim() || "Manual / cash";
    const entry = totals.get(key) ?? { minor: 0, count: 0 };
    entry.minor += row.minor;
    entry.count += 1;
    totals.set(key, entry);
  }
  return [...totals.entries()]
    .map(([account, entry]) => ({ account, ...entry }))
    .filter((entry) => entry.minor > 0)
    .sort((left, right) => right.minor - left.minor || left.account.localeCompare(right.account));
}

export type WeeklyPace = {
  weekStart: string;
  today: string;
  thisWeekMinor: number;
  lastWeekSameStretchMinor: number;
  changePercent: number | null;
};

/**
 * Compares spending this week (Monday through `today`) against the exact same
 * elapsed weekday stretch of last week.
 */
export function weeklyPace(rows: LedgerRow[], today: string, currency: string): WeeklyPace {
  const [year, month, day] = today.split("-").map(Number);
  const weekdayIndex = (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
  const weekStart = addDays(today, -weekdayIndex);
  const lastWeekStart = addDays(weekStart, -7);
  const lastWeekEnd = addDays(today, -7);

  const thisWeekMinor = sumMinor(inRows(rows, { start: weekStart, end: today }, currency, "expense"));
  const lastWeekSameStretchMinor = sumMinor(inRows(rows, { start: lastWeekStart, end: lastWeekEnd }, currency, "expense"));
  const changePercent =
    lastWeekSameStretchMinor > 0 ? Math.round(((thisWeekMinor - lastWeekSameStretchMinor) / lastWeekSameStretchMinor) * 100) : null;

  return {
    weekStart,
    today,
    thisWeekMinor,
    lastWeekSameStretchMinor,
    changePercent,
  };
}

export type SankeyFlowEntry = { label: string; minor: number };

export type SankeyFlowModel = {
  sources: SankeyFlowEntry[];
  expenses: SankeyFlowEntry[];
  incomingMinor: number;
  outgoingMinor: number;
  netMinor: number;
  remainderMinor: number;
  comparisonGapMinor: number;
  massMinor: number;
};

/**
 * Builds the model for the "Where it came from / Where it went" Sankey flow
 * diagram: income sources on the left, spending categories on the right, and
 * either net recorded inflow or outflow beyond recorded income to balance the two sides.
 */
export function buildSankeyModel(incomeRows: LedgerRow[], expenseRows: LedgerRow[]): SankeyFlowModel {
  const sources = categoryTotals(incomeRows)
    .filter((item) => item.minor > 0)
    .map((item) => ({ label: item.category, minor: item.minor }));
  const expenses = categoryTotals(expenseRows)
    .filter((item) => item.minor > 0)
    .map((item) => ({ label: item.category, minor: item.minor }));

  const incomingMinor = sources.reduce((sum, item) => sum + item.minor, 0);
  const outgoingMinor = expenses.reduce((sum, item) => sum + item.minor, 0);
  const netMinor = incomingMinor - outgoingMinor;
  const remainderMinor = Math.max(0, netMinor);
  const comparisonGapMinor = Math.max(0, -netMinor);
  const massMinor = Math.max(incomingMinor, outgoingMinor);

  return {
    sources,
    expenses,
    incomingMinor,
    outgoingMinor,
    netMinor,
    remainderMinor,
    comparisonGapMinor,
    massMinor,
  };
}
