import { calendarDay, nextOccurrence } from "@/lib/finance/bill-schedule";
import type { BillRecord } from "@/lib/finance/bills";
import { addDays } from "@/lib/finance/dates";
import { formatMinor, toMinor } from "@/lib/finance/money";
import type { TransactionRecord } from "@/lib/finance/types";

/**
 * "What's left before payday". Payday is learned from incomes labelled Salary
 * and confirmed by the person; what's left is the included cash balance from
 * their bank texts minus bills due before payday. Nothing here guesses future
 * spending: the usual daily spend is shown beside the figure, never taken off it.
 */

/** What the person told Alfred: a day of the month, or that they have no regular payday. */
export type PaydaySetting = { day: number | null; regular: boolean };

export type LearnedPayday = { day: number; months: number; lastPaid: string };

export type Payday =
  | { status: "confirmed"; day: number }
  | { status: "learned"; day: number; months: number; lastPaid: string }
  | { status: "none" }
  | { status: "unknown" };

export type PaydayBill = { name: string; date: string; minor: number | null };

export type PaydayForecast = {
  status: "confirmed" | "learned";
  day: number;
  /** Months of salary the day was learned from, when it was learned. */
  learnedFrom: number | null;
  paydayDate: string;
  days: number;
  currency: string;
  /** Included cash from bank-text balances; null when any included account has no balance yet. */
  cashMinor: number | null;
  cashMissing: number;
  bills: PaydayBill[];
  billsMinor: number;
  /** Bills due before payday whose amount varies, so they aren't in billsMinor. */
  unpricedBills: number;
  leftMinor: number | null;
  /** What's left spread over the days until payday. */
  perDayMinor: number | null;
  /** Average daily spending over the last 30 days, shown beside the figure, never taken off it. */
  usualDailyMinor: number | null;
  /** Bills due before payday come to more than what's in the accounts. */
  tight: boolean;
};

const LOOKBACK_DAYS = 200;
const USUAL_SPEND_DAYS = 30;
/** Salaries a few days apart (moved for a weekend) still count as the same payday. */
const MAX_SPREAD = 5;

const isSalary = (row: TransactionRecord) => row.type === "income" && row.status !== "deleted" && row.category.trim().toLowerCase() === "salary";

/**
 * The usual day salary lands, from at least two different months of incomes
 * labelled Salary. The biggest salary in each month counts; a payday that moves
 * around by more than a few days isn't regular, so nothing is learned.
 */
export function learnPayday(transactions: TransactionRecord[], currency: string, today: string): LearnedPayday | null {
  const since = addDays(today, -LOOKBACK_DAYS);
  const byMonth = new Map<string, TransactionRecord>();
  for (const row of transactions) {
    if (!isSalary(row) || row.currency !== currency || row.transactionDate < since || row.transactionDate > today) continue;
    const month = row.transactionDate.slice(0, 7);
    const current = byMonth.get(month);
    if (!current || toMinor(row.amount) > toMinor(current.amount)) byMonth.set(month, row);
  }
  const dates = [...byMonth.values()].map((row) => row.transactionDate).sort();
  if (dates.length < 2) return null;
  const days = dates.map((date) => Number(date.slice(8, 10)));
  if (Math.max(...days) - Math.min(...days) > MAX_SPREAD) return null;
  const counts = new Map<number, number>();
  for (const day of days) counts.set(day, (counts.get(day) ?? 0) + 1);
  // The most common day; on a tie, the later one, since a weekend moves pay earlier.
  const day = [...counts.entries()].sort((left, right) => right[1] - left[1] || right[0] - left[0])[0][0];
  return { day, months: dates.length, lastPaid: dates.at(-1)! };
}

export function resolvePayday(setting: PaydaySetting | null, learned: LearnedPayday | null): Payday {
  if (setting && !setting.regular) return { status: "none" };
  if (setting?.day) return { status: "confirmed", day: setting.day };
  if (learned) return { status: "learned", ...learned };
  return { status: "unknown" };
}

/**
 * The next payday on or after today. When this month's salary has already
 * come in (early, say before a weekend), payday is next month's.
 */
export function nextPayday(day: number, today: string, lastPaid: string | null = null): string {
  const [year, month] = today.split("-").map(Number);
  const thisMonth = calendarDay(year, month - 1, day);
  const paidAlready = lastPaid !== null && lastPaid.slice(0, 7) === thisMonth.slice(0, 7) && addDays(lastPaid, MAX_SPREAD + 1) > thisMonth;
  if (thisMonth >= today && !paidAlready) return thisMonth;
  return calendarDay(month === 12 ? year + 1 : year, month % 12, day);
}

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** Each time a bill falls due from today up to the day before payday. */
export function billsBefore(bills: BillRecord[], today: string, payday: string, currency: string): PaydayBill[] {
  const due: PaydayBill[] = [];
  for (const bill of bills) {
    if (bill.currency !== currency) continue;
    let date = nextOccurrence(bill, today);
    while (date && date < payday) {
      due.push({ name: bill.name, date, minor: bill.amount === null ? null : toMinor(bill.amount) });
      if (bill.cadence === "once") break;
      const next = nextOccurrence(bill, addDays(date, 1));
      if (!next || next <= date) break;
      date = next;
    }
  }
  return due.sort((left, right) => left.date.localeCompare(right.date) || left.name.localeCompare(right.name));
}

/** Average daily spending in this currency over the last 30 days, or null with no spending at all. */
export function usualDailySpend(transactions: TransactionRecord[], currency: string, today: string): number | null {
  const since = addDays(today, -USUAL_SPEND_DAYS);
  let total = 0;
  for (const row of transactions) {
    if (row.type !== "expense" || row.status === "deleted" || row.currency !== currency) continue;
    if (row.transactionDate <= since || row.transactionDate > today) continue;
    total += toMinor(row.amount);
  }
  return total > 0 ? Math.round(total / USUAL_SPEND_DAYS) : null;
}

export function forecastPayday(input: {
  payday: Payday;
  today: string;
  currency: string;
  cash: { totalMinor: number | null; missingCount: number };
  bills: BillRecord[];
  transactions: TransactionRecord[];
}): PaydayForecast | null {
  const { payday, today, currency } = input;
  if (payday.status !== "confirmed" && payday.status !== "learned") return null;
  const lastPaid = payday.status === "learned" ? payday.lastPaid : lastSalary(input.transactions, currency, today);
  const paydayDate = nextPayday(payday.day, today, lastPaid);
  const days = daysBetween(today, paydayDate);
  const bills = billsBefore(input.bills, today, paydayDate, currency);
  const billsMinor = bills.reduce((sum, bill) => sum + (bill.minor ?? 0), 0);
  const cashMinor = input.cash.totalMinor;
  const leftMinor = cashMinor === null ? null : cashMinor - billsMinor;
  return {
    status: payday.status,
    day: payday.day,
    learnedFrom: payday.status === "learned" ? payday.months : null,
    paydayDate,
    days,
    currency,
    cashMinor,
    cashMissing: input.cash.missingCount,
    bills,
    billsMinor,
    unpricedBills: bills.filter((bill) => bill.minor === null).length,
    leftMinor,
    perDayMinor: leftMinor !== null && leftMinor > 0 && days > 0 ? Math.floor(leftMinor / days) : null,
    usualDailyMinor: usualDailySpend(input.transactions, currency, today),
    tight: leftMinor !== null && leftMinor < 0,
  };
}

function lastSalary(transactions: TransactionRecord[], currency: string, today: string): string | null {
  let latest: string | null = null;
  for (const row of transactions) {
    if (isSalary(row) && row.currency === currency && row.transactionDate <= today && (!latest || row.transactionDate > latest)) latest = row.transactionDate;
  }
  return latest;
}

export function ordinal(day: number): string {
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) return `${day}th`;
  return `${day}${["th", "st", "nd", "rd"][day % 10] ?? "th"}`;
}

/** "Wed 25 Nov". */
export const shortDate = (date: string) =>
  new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));

export function daysLabel(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

/** The chat answer: every figure comes from the forecast, nothing is estimated in the text. */
export function paydayText(forecast: PaydayForecast | null, payday: Payday): string {
  if (payday.status === "none") return "You told me you don't have a regular payday, so I'm not forecasting one. Tell me the day it usually lands if that changes.";
  if (!forecast) {
    return "I don't know your payday yet. Label your salary when it comes in, or tell me the day it usually lands (\"payday is the 25th\").";
  }
  const money = (minor: number) => formatMinor(minor, forecast.currency);
  const lines = [`Payday is ${shortDate(forecast.paydayDate)}, ${daysLabel(forecast.days)}.`];
  if (forecast.days === 0) lines[0] = `Payday is today, ${shortDate(forecast.paydayDate)}.`;
  const priced = forecast.bills.filter((bill) => bill.minor !== null);
  if (forecast.leftMinor !== null) {
    const after = priced.length ? ` after ${priced.map((bill) => bill.name).join(", ")}` : "";
    lines.push(forecast.leftMinor < 0
      ? `Bills due before then come to ${money(forecast.billsMinor)}, ${money(-forecast.leftMinor)} more than the ${money(forecast.cashMinor!)} in your accounts.`
      : `${money(forecast.leftMinor)} left${after}.`);
    if (forecast.perDayMinor !== null) lines.push(`That's about ${money(forecast.perDayMinor)} a day until payday.`);
  } else {
    lines.push(forecast.cashMissing > 0
      ? `I can't say what's left yet: ${forecast.cashMissing === 1 ? "one of your accounts has" : `${forecast.cashMissing} of your accounts have`} no balance from a bank text.`
      : "I can't say what's left yet: none of your accounts has a balance from a bank text.");
    if (priced.length) lines.push(`Bills due before then: ${money(forecast.billsMinor)}.`);
  }
  if (priced.length) lines.push(...priced.map((bill) => `• ${bill.name}: ${money(bill.minor!)} on ${shortDate(bill.date)}`));
  if (forecast.unpricedBills) lines.push(`${forecast.unpricedBills === 1 ? "One bill varies" : `${forecast.unpricedBills} bills vary`} in amount, so ${forecast.unpricedBills === 1 ? "it isn't" : "they aren't"} counted.`);
  if (forecast.usualDailyMinor !== null) lines.push(`You've been spending about ${money(forecast.usualDailyMinor)} a day this past month.`);
  if (forecast.status === "learned") lines.push(`I took payday as the ${ordinal(forecast.day)} from your salary in the last ${forecast.learnedFrom} months. Is that right?`);
  return lines.join("\n");
}
