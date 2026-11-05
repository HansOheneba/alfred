import { addDays, endOfMonth, formatDisplayDate, inclusiveDays, resolveQueryRange, shiftRangeBack, type DateRange, type RelativePeriod } from "@/lib/finance/dates";
import { formatMinor, toMinor } from "@/lib/finance/money";
import type { TransactionRecord } from "@/lib/finance/types";

/**
 * Charts Alfred draws when asked ("chart my food spending by week"). The
 * model only describes the chart; every number is worked out here from the
 * books, so a chart can't show a figure the ledger doesn't have, and a chart
 * kept on the Overview recalculates from the same description.
 */

export type ChartMeasure = "spending" | "income" | "net";
export type ChartBy = "category" | "merchant" | "day" | "week" | "month";
export type ChartStyle = "bar" | "line" | "donut" | "table";

/** What to chart, as the person asked it: relative periods stay relative so a kept chart moves with time. */
export type ChartQuery = {
  measure: ChartMeasure;
  by: ChartBy;
  style?: ChartStyle | null;
  compare?: boolean | null;
  category?: string | null;
  period?: RelativePeriod | null;
  month?: number | null;
  year?: number | null;
  startDate?: string | null;
  endDate?: string | null;
};

export type ChartRow = {
  label: string;
  minor: number;
  count: number;
  /** The same bucket or label in the period before, when comparing. */
  previous?: number;
  /** What to ask Alfred to list the payments behind this bar. */
  ask?: string;
};

export type DrawnChart = {
  kind: "chart";
  query: ChartQuery;
  title: string;
  subtitle: string;
  style: ChartStyle;
  by: ChartBy;
  measure: ChartMeasure;
  currency: string;
  rows: ChartRow[];
  totalMinor: number;
  previousTotalMinor?: number;
  previousLabel?: string;
  /** Payments in other currencies, left out of the totals. */
  otherCurrencies?: string[];
};

const TIME: ChartBy[] = ["day", "week", "month"];
const MERCHANTS_SHOWN = 7;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A day as "3 Nov", or "3 Nov 2025" outside the current year. */
function shortDay(iso: string, today: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return `${day} ${MONTHS[month - 1]}${iso.slice(0, 4) === today.slice(0, 4) ? "" : ` ${year}`}`;
}

function spanLabel(range: DateRange, today: string): string {
  if (range.start === range.end) return shortDay(range.start, today);
  if (range.start.endsWith("-01") && range.end === endOfMonth(range.start)) return `${MONTHS[Number(range.start.slice(5, 7)) - 1]} ${range.start.slice(0, 4)}`;
  return `${shortDay(range.start, today)} to ${shortDay(range.end, today)}`;
}

/** Monday on or before a date. */
function weekStart(iso: string): string {
  const day = new Date(`${iso}T00:00:00.000Z`).getUTCDay();
  return addDays(iso, -((day + 6) % 7));
}

/** The buckets a time chart is split into, oldest first, each clipped to the range. */
function buckets(range: DateRange, by: ChartBy): DateRange[] {
  const out: DateRange[] = [];
  if (by === "day") for (let day = range.start; day <= range.end; day = addDays(day, 1)) out.push({ start: day, end: day });
  if (by === "week") {
    for (let start = weekStart(range.start); start <= range.end; start = addDays(start, 7)) {
      out.push({ start: start < range.start ? range.start : start, end: addDays(start, 6) > range.end ? range.end : addDays(start, 6) });
    }
  }
  if (by === "month") {
    for (let start = `${range.start.slice(0, 7)}-01`; start <= range.end; start = addDays(endOfMonth(start), 1)) {
      out.push({ start: start < range.start ? range.start : start, end: endOfMonth(start) > range.end ? range.end : endOfMonth(start) });
    }
  }
  return out;
}

/** Days are fine for a month, weeks for half a year; longer than that reads better in months. */
function fittingBy(by: ChartBy, range: DateRange): ChartBy {
  const days = inclusiveDays(range);
  if (by === "day" && days > 62) return days > 186 ? "month" : "week";
  if (by === "week" && days > 186) return "month";
  return by;
}

/**
 * The period before. Whole months compare with the whole months before them;
 * a month so far compares with the same days of the month before; anything
 * else with the same number of days just before.
 */
function previousRange(range: DateRange): DateRange {
  if (!range.start.endsWith("-01")) return shiftRangeBack(range);
  const months = Math.max(1, (Number(range.end.slice(0, 4)) - Number(range.start.slice(0, 4))) * 12 + Number(range.end.slice(5, 7)) - Number(range.start.slice(5, 7)) + 1);
  let start = range.start;
  for (let index = 0; index < months; index++) start = `${addDays(start, -1).slice(0, 7)}-01`;
  if (range.end === endOfMonth(range.end)) return { start, end: addDays(range.start, -1) };
  // The month so far against the same days last month, ending at that month's last day if it's shorter.
  const day = Number(range.end.slice(8, 10));
  let endMonth = start;
  for (let index = 1; index < months; index++) endMonth = addDays(endOfMonth(endMonth), 1);
  const last = endOfMonth(endMonth);
  const end = `${endMonth.slice(0, 8)}${String(day).padStart(2, "0")}`;
  return { start, end: end > last ? last : end };
}

const merchantKey = (description: string) => description.toLowerCase().replace(/\s+/g, " ").trim();

/** Signed amount for the measure: spending and income count up; net is income less spending. */
function signed(row: TransactionRecord, measure: ChartMeasure): number {
  const minor = toMinor(row.amount);
  if (measure === "net") return row.type === "income" ? minor : -minor;
  return minor;
}

function relevant(rows: TransactionRecord[], userId: string, measure: ChartMeasure, category: string | null): TransactionRecord[] {
  return rows.filter((row) => row.userId === userId && row.status === "active"
    && (measure === "net" || row.type === (measure === "income" ? "income" : "expense"))
    && (!category || row.category === category));
}

/** Rows for one period, keyed by label so a comparison can line labels up. */
function tally(rows: TransactionRecord[], range: DateRange, by: ChartBy, measure: ChartMeasure, today: string): Map<string, { label: string; minor: number; count: number; range?: DateRange }> {
  const inside = rows.filter((row) => row.transactionDate >= range.start && row.transactionDate <= range.end);
  const out = new Map<string, { label: string; minor: number; count: number; range?: DateRange }>();
  if (TIME.includes(by)) {
    buckets(range, by).forEach((bucket, index) => {
      const items = inside.filter((row) => row.transactionDate >= bucket.start && row.transactionDate <= bucket.end);
      const label = by === "month" ? `${MONTHS[Number(bucket.start.slice(5, 7)) - 1]}${bucket.start.slice(0, 4) === today.slice(0, 4) ? "" : ` ${bucket.start.slice(2, 4)}`}` : shortDay(bucket.start, today);
      out.set(String(index), { label, minor: items.reduce((sum, row) => sum + signed(row, measure), 0), count: items.length, range: bucket });
    });
    return out;
  }
  for (const row of inside) {
    const key = by === "category" ? row.category : merchantKey(row.description);
    const current = out.get(key) ?? { label: by === "category" ? row.category : row.description.trim(), minor: 0, count: 0 };
    current.minor += signed(row, measure);
    current.count += 1;
    out.set(key, current);
  }
  return out;
}

/** Works out a chart from the person's books. `category` must already be resolved to one of their categories. */
export function drawChart(input: { query: ChartQuery; transactions: TransactionRecord[]; userId: string; currency: string; today: string }): { ok: true; chart: DrawnChart } | { ok: false; message: string } {
  const { query, today, currency } = input;
  const resolved = resolveQueryRange({ period: query.period, month: query.month, year: query.year, startDate: query.startDate, endDate: query.endDate, today });
  if (!resolved.ok) return resolved;
  const measure = query.measure;
  // Net only makes sense over time; a chart of net by category is really spending by category.
  const wanted: ChartBy = measure === "net" && !TIME.includes(query.by) ? "month" : query.by;
  // A time chart stops at today rather than drawing the rest of the month as zeros, and a comparison
  // of a month still going on is the days so far against the same days before, so it's like for like.
  const range = (TIME.includes(wanted) || query.compare) && resolved.range.end > today && resolved.range.start <= today ? { start: resolved.range.start, end: today } : resolved.range;
  const by = TIME.includes(wanted) ? fittingBy(wanted, range) : wanted;
  const all = relevant(input.transactions, input.userId, measure, query.category ?? null);
  const rows = all.filter((row) => row.currency === currency);
  const otherCurrencies = [...new Set(all.filter((row) => row.currency !== currency && row.transactionDate >= range.start && row.transactionDate <= range.end).map((row) => row.currency))];
  const current = tally(rows, range, by, measure, today);
  const before = query.compare ? previousRange(range) : null;
  const previous = before ? tally(rows, before, by, measure, today) : null;

  const what = query.category ? `${query.category} ${measure === "income" ? "income" : "spending"}` : measure === "net" ? "Money in less money out" : measure === "income" ? "Income" : "Spending";
  const kind = measure === "income" ? "income" : "payments";
  const between = (span: DateRange) => `from ${formatDisplayDate(span.start)} to ${formatDisplayDate(span.end)}`;
  let chartRows: ChartRow[];
  if (TIME.includes(by)) {
    const previousList = previous ? [...previous.values()] : [];
    chartRows = [...current.values()].map((item, index) => ({
      label: item.label, minor: item.minor, count: item.count,
      ...(previous ? { previous: previousList[index]?.minor ?? 0 } : {}),
      ...(measure !== "net" && item.count ? { ask: `Show my ${query.category ? `${query.category} ` : ""}${kind} ${between(item.range!)}` } : {}),
    }));
  } else {
    // Comparing, something only spent on before still shows, at nothing now.
    for (const [key, item] of previous ?? []) if (!current.has(key)) current.set(key, { label: item.label, minor: 0, count: 0 });
    const before = (key: string) => previous?.get(key)?.minor ?? 0;
    const sorted = [...current.entries()].sort(([leftKey, left], [rightKey, right]) => right.minor - left.minor || before(rightKey) - before(leftKey) || left.label.localeCompare(right.label));
    const shown = by === "merchant" ? sorted.slice(0, MERCHANTS_SHOWN) : sorted;
    chartRows = shown.map(([key, item]) => ({
      label: item.label, minor: item.minor, count: item.count,
      ...(previous ? { previous: previous.get(key)?.minor ?? 0 } : {}),
      ask: by === "category" ? `Show my ${item.label} ${kind} ${between(range)}` : `Show my ${kind} ${measure === "income" ? "from" : "to"} ${item.label} ${between(range)}`,
    }));
    const rest = sorted.slice(shown.length);
    if (rest.length) chartRows.push({ label: `${rest.length} more`, minor: rest.reduce((sum, [, item]) => sum + item.minor, 0), count: rest.reduce((sum, [, item]) => sum + item.count, 0) });
  }
  const totalMinor = [...current.values()].reduce((sum, item) => sum + item.minor, 0);
  const previousTotalMinor = previous ? [...previous.values()].reduce((sum, item) => sum + item.minor, 0) : undefined;
  const categorical = !TIME.includes(by);
  // A line suits a run of days or weeks; a donut only works for parts of a whole.
  const style: ChartStyle = query.style === "table" ? "table"
    : query.style === "donut" && categorical && measure !== "net" ? "donut"
      : query.style === "line" && !categorical ? "line"
        : !categorical && chartRows.length > 8 && !query.style ? "line" : "bar";
  const byWords = { category: "by category", merchant: "by where it went", day: "by day", week: "by week", month: "by month" }[by];
  return {
    ok: true,
    chart: {
      kind: "chart", query, by, measure, style, currency,
      title: `${what} ${measure === "net" && by === "month" && query.by !== "month" ? "by month" : byWords}`,
      subtitle: spanLabel(range, today),
      rows: chartRows, totalMinor,
      ...(previousTotalMinor !== undefined && before ? { previousTotalMinor, previousLabel: spanLabel(before, today) } : {}),
      ...(otherCurrencies.length ? { otherCurrencies } : {}),
    },
  };
}

export type ChartFrame = { key: string; label: string; range: DateRange };
export type ChartPlan = { query: ChartQuery; measure: ChartMeasure; by: ChartBy; range: DateRange; before: DateRange | null; frames: ChartFrame[]; previousFrames: ChartFrame[] };
export type ChartTallyFact = { key: string; label: string; minor: number; count: number; range?: DateRange };
export type ChartFacts = { current: ChartTallyFact[]; previous: ChartTallyFact[]; totalMinor: number; previousTotalMinor: number; otherCurrencies: string[]; merchantRest?: { groups: number; minor: number; count: number } };

/** Resolve relative dates and zero frames without reading any financial details. */
export function planChart(query: ChartQuery, today: string): { ok: true; plan: ChartPlan } | { ok: false; message: string } {
  const resolved = resolveQueryRange({ period: query.period, month: query.month, year: query.year, startDate: query.startDate, endDate: query.endDate, today });
  if (!resolved.ok) return resolved;
  const wanted: ChartBy = query.measure === "net" && !TIME.includes(query.by) ? "month" : query.by;
  const range = (TIME.includes(wanted) || query.compare) && resolved.range.end > today && resolved.range.start <= today ? { start: resolved.range.start, end: today } : resolved.range;
  const by = TIME.includes(wanted) ? fittingBy(wanted, range) : wanted, before = query.compare ? previousRange(range) : null;
  const frames = (span: DateRange) => TIME.includes(by) ? buckets(span, by).map((range, index) => ({ key: String(index), range,
    label: by === "month" ? `${MONTHS[Number(range.start.slice(5, 7)) - 1]}${range.start.slice(0, 4) === today.slice(0, 4) ? "" : ` ${range.start.slice(2, 4)}`}` : shortDay(range.start, today) })) : [];
  return { ok: true, plan: { query, measure: query.measure, by, range, before, frames: frames(range), previousFrames: before ? frames(before) : [] } };
}

/** Canonical full-input fact oracle for bounded-reader parity tests; drawChart remains independent. */
export function chartFactsForPlan(plan: ChartPlan, transactions: TransactionRecord[], userId: string, currency: string, today: string): ChartFacts {
  const all = relevant(transactions, userId, plan.measure, plan.query.category ?? null), own = all.filter(row => row.currency === currency);
  const current = tally(own, plan.range, plan.by, plan.measure, today), previous = plan.before ? tally(own, plan.before, plan.by, plan.measure, today) : new Map();
  return { current: [...current].map(([key, value]) => ({ key, ...value })), previous: [...previous].map(([key, value]) => ({ key, ...value })),
    totalMinor: [...current.values()].reduce((sum, value) => sum + value.minor, 0), previousTotalMinor: [...previous.values()].reduce((sum, value) => sum + value.minor, 0),
    otherCurrencies: [...new Set(all.filter(row => row.currency !== currency && row.transactionDate >= plan.range.start && row.transactionDate <= plan.range.end).map(row => row.currency))] };
}

/** Format canonical aggregate facts. Merchant readers may provide seven groups and an explicit remainder. */
export function formatChartFacts(plan: ChartPlan, facts: ChartFacts, currency: string, today: string): DrawnChart {
  const { query, range, by, measure, before } = plan;
  const current = new Map(facts.current.map(item => [item.key, item])), previous = before ? new Map(facts.previous.map(item => [item.key, item])) : null;
  const what = query.category ? `${query.category} ${measure === "income" ? "income" : "spending"}` : measure === "net" ? "Money in less money out" : measure === "income" ? "Income" : "Spending";
  const kind = measure === "income" ? "income" : "payments", between = (span: DateRange) => `from ${formatDisplayDate(span.start)} to ${formatDisplayDate(span.end)}`;
  let rows: ChartRow[];
  if (TIME.includes(by)) {
    const previousList = previous ? [...previous.values()] : [];
    rows = [...current.values()].map((item, index) => ({ label: item.label, minor: item.minor, count: item.count,
      ...(previous ? { previous: previousList[index]?.minor ?? 0 } : {}),
      ...(measure !== "net" && item.count ? { ask: `Show my ${query.category ? `${query.category} ` : ""}${kind} ${between(item.range!)}` } : {}) }));
  } else {
    for (const [key, item] of previous ?? []) if (!current.has(key)) current.set(key, { key, label: item.label, minor: 0, count: 0 });
    const prior = (key: string) => previous?.get(key)?.minor ?? 0;
    const sorted = [...current.entries()].sort(([leftKey, left], [rightKey, right]) => right.minor - left.minor || prior(rightKey) - prior(leftKey) || left.label.localeCompare(right.label));
    const shown = by === "merchant" ? sorted.slice(0, MERCHANTS_SHOWN) : sorted;
    rows = shown.map(([key, item]) => ({ label: item.label, minor: item.minor, count: item.count,
      ...(previous ? { previous: previous.get(key)?.minor ?? 0 } : {}),
      ask: by === "category" ? `Show my ${item.label} ${kind} ${between(range)}` : `Show my ${kind} ${measure === "income" ? "from" : "to"} ${item.label} ${between(range)}` }));
    const rest = sorted.slice(shown.length), boundedRest = facts.merchantRest;
    if (boundedRest && boundedRest.groups > 0) rows.push({ label: `${boundedRest.groups} more`, minor: boundedRest.minor, count: boundedRest.count });
    else if (rest.length) rows.push({ label: `${rest.length} more`, minor: rest.reduce((sum, [, item]) => sum + item.minor, 0), count: rest.reduce((sum, [, item]) => sum + item.count, 0) });
  }
  const categorical = !TIME.includes(by);
  const style: ChartStyle = query.style === "table" ? "table" : query.style === "donut" && categorical && measure !== "net" ? "donut" : query.style === "line" && !categorical ? "line" : !categorical && rows.length > 8 && !query.style ? "line" : "bar";
  const byWords = { category: "by category", merchant: "by where it went", day: "by day", week: "by week", month: "by month" }[by];
  return { kind: "chart", query, by, measure, style, currency, title: `${what} ${measure === "net" && by === "month" && query.by !== "month" ? "by month" : byWords}`, subtitle: spanLabel(range, today), rows, totalMinor: facts.totalMinor,
    ...(before ? { previousTotalMinor: facts.previousTotalMinor, previousLabel: spanLabel(before, today) } : {}), ...(facts.otherCurrencies.length ? { otherCurrencies: facts.otherCurrencies } : {}) };
}

/** The reply that goes with a chart: the total, the biggest part, and the change when comparing. Every figure is from the chart. */
export function chartSummary(chart: DrawnChart): string {
  const money = (minor: number) => formatMinor(minor, chart.currency);
  if (chart.rows.every((row) => row.count === 0)) return `Nothing recorded for ${chart.title.toLowerCase()}, ${chart.subtitle}.`;
  const lines = [`${chart.title}, ${chart.subtitle}: ${money(chart.totalMinor)}${chart.measure === "net" ? " overall" : " in all"}.`];
  const top = [...chart.rows].filter((row) => !/^\d+ more$/.test(row.label)).sort((left, right) => (chart.measure === "net" ? Math.abs(right.minor) - Math.abs(left.minor) : right.minor - left.minor))[0];
  if (top && chart.totalMinor > 0 && chart.measure !== "net") {
    const share = Math.round((top.minor / chart.totalMinor) * 100);
    const when = chart.by === "week" ? `the week of ${top.label}` : top.label;
    lines.push(chart.by === "category" || chart.by === "merchant" ? `The biggest part is ${top.label} at ${money(top.minor)} (${share}%).` : `The highest was ${when} at ${money(top.minor)}.`);
  }
  if (chart.previousTotalMinor !== undefined && chart.previousLabel) {
    const change = chart.totalMinor - chart.previousTotalMinor;
    lines.push(change === 0 ? `That's the same as ${chart.previousLabel}.` : `That's ${money(Math.abs(change))} ${change > 0 ? "more" : "less"} than ${chart.previousLabel} (${money(chart.previousTotalMinor)}).`);
  }
  if (chart.otherCurrencies?.length) lines.push(`Payments in ${chart.otherCurrencies.join(", ")} aren't included.`);
  return lines.join(" ");
}
