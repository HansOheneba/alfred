const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export type DateRange = {
  start: string;
  end: string;
};

export const RELATIVE_PERIODS = [
  "today",
  "yesterday",
  "this_week",
  "last_week",
  "this_month",
  "last_month",
  "this_year",
] as const;

export type RelativePeriod = (typeof RELATIVE_PERIODS)[number];

export function isRealDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return (
    utc.getUTCFullYear() === year &&
    utc.getUTCMonth() === month - 1 &&
    utc.getUTCDate() === day
  );
}

export function toIso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function zonedYmd(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const weekday = WEEKDAY_INDEX[read("weekday")];
  if (weekday === undefined) {
    throw new Error("Could not resolve the calendar date.");
  }
  return toIso(Number(read("year")), Number(read("month")), Number(read("day")));
}

export function addDays(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  utc.setUTCDate(utc.getUTCDate() + days);
  return utc.toISOString().slice(0, 10);
}

/** Monday is the first day of the week. Sunday is the last. */
export function startOfWeek(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const sinceMonday = (weekday + 6) % 7;
  return addDays(isoDate, -sinceMonday);
}

export function endOfMonth(isoDate: string): string {
  const [year, month] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

export function rangeForPeriod(period: RelativePeriod, today: string): DateRange {
  if (period === "today") return { start: today, end: today };
  if (period === "yesterday") {
    const yesterday = addDays(today, -1);
    return { start: yesterday, end: yesterday };
  }
  if (period === "this_week") {
    const start = startOfWeek(today);
    return { start, end: addDays(start, 6) };
  }
  if (period === "last_week") {
    const start = addDays(startOfWeek(today), -7);
    return { start, end: addDays(start, 6) };
  }
  if (period === "this_month") {
    const start = `${today.slice(0, 7)}-01`;
    return { start, end: endOfMonth(start) };
  }
  if (period === "last_month") {
    const lastEnd = addDays(`${today.slice(0, 7)}-01`, -1);
    return { start: `${lastEnd.slice(0, 7)}-01`, end: lastEnd };
  }
  const year = today.slice(0, 4);
  return { start: `${year}-01-01`, end: `${year}-12-31` };
}

export function mostRecentYear(today: string, month: number): number {
  const currentMonth = Number(today.slice(5, 7));
  const currentYear = Number(today.slice(0, 4));
  return month <= currentMonth ? currentYear : currentYear - 1;
}

export function monthRange(year: number, month: number): DateRange {
  const start = toIso(year, month, 1);
  return { start, end: endOfMonth(start) };
}

export function inclusiveDays(range: DateRange): number {
  const start = Date.parse(`${range.start}T00:00:00.000Z`);
  const end = Date.parse(`${range.end}T00:00:00.000Z`);
  return Math.round((end - start) / 86_400_000) + 1;
}

export function shiftRangeBack(range: DateRange): DateRange {
  const days = inclusiveDays(range);
  const end = addDays(range.start, -1);
  return { start: addDays(end, -(days - 1)), end };
}

export function formatDisplayDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

export function formatRange(range: DateRange): string {
  if (range.start === range.end) return formatDisplayDate(range.start);
  return `${formatDisplayDate(range.start)} – ${formatDisplayDate(range.end)}`;
}

export function isSaneTransactionDate(date: string, today: string): boolean {
  if (!isRealDate(date)) return false;
  return date >= addDays(today, -365 * 10) && date <= addDays(today, 31);
}

export function resolveQueryRange(input: {
  period?: RelativePeriod | null;
  month?: number | null;
  year?: number | null;
  startDate?: string | null;
  endDate?: string | null;
  today: string;
}): { ok: true; range: DateRange } | { ok: false; message: string } {
  if (input.period) {
    return { ok: true, range: rangeForPeriod(input.period, input.today) };
  }
  if (input.month) {
    const year = input.year ?? mostRecentYear(input.today, input.month);
    if (year < 2000 || year > 2100) {
      return { ok: false, message: "That year is outside the range I can report." };
    }
    return { ok: true, range: monthRange(year, input.month) };
  }
  if (input.startDate || input.endDate) {
    const start = input.startDate ?? input.endDate;
    const end = input.endDate ?? input.startDate;
    if (!start || !end || !isRealDate(start) || !isRealDate(end) || start > end) {
      return { ok: false, message: "I need a valid start and end date." };
    }
    if (inclusiveDays({ start, end }) > 8000) {
      return {
        ok: false,
        message: "That date range is too long. Ask about a year or less at a time.",
      };
    }
    return { ok: true, range: { start, end } };
  }
  return { ok: true, range: rangeForPeriod("this_month", input.today) };
}
