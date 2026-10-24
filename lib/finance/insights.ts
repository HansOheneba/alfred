import { budgetMath } from "@/lib/finance/budgets";
import { endOfMonth, inclusiveDays, shiftRangeBack, toIso, type DateRange } from "@/lib/finance/dates";
import { formatMinor, toMinor } from "@/lib/finance/money";
import { inRange, largestExpenses, totalsByCategory } from "@/lib/finance/summaries";
import type { BudgetRecord, TransactionRecord } from "@/lib/finance/types";

export type InsightInput = {
  userId: string;
  currency: string;
  range: DateRange;
  today: string;
  transactions: TransactionRecord[];
  budgets: BudgetRecord[];
};

/**
 * Plain-language findings for one period, worked out from stored records.
 * Every figure here is computed by the server, so the voice layer may reword
 * these lines but never needs to do arithmetic.
 */
export function buildInsights(input: InsightInput): string[] {
  const { userId, currency, range, today } = input;
  const own = input.transactions.filter((item) => item.currency === currency);
  const expenses = inRange(own, { userId, range, type: "expense" });
  const income = inRange(own, { userId, range, type: "income" });
  const money = (minor: number) => formatMinor(minor, currency);
  const lines: string[] = [];

  if (expenses.length === 0) {
    lines.push("No expenses are recorded for this period yet.");
    return lines;
  }

  const spent = sum(expenses);
  const earned = sum(income);
  lines.push(`Total spent: ${money(spent)} across ${expenses.length} expenses.`);
  if (earned > 0) {
    const kept = earned - spent;
    lines.push(
      kept >= 0
        ? `Income: ${money(earned)}. ${money(kept)} of it is not spent yet (${percent(kept, earned)} of income).`
        : `Income: ${money(earned)}. Spending is ${money(-kept)} more than income.`,
    );
  }

  const categories = totalsByCategory(expenses).filter((item) => item.category !== "Savings");
  const top = categories.slice(0, 3).map((item) => `${item.category} ${money(item.minor)} (${percent(item.minor, spent)})`);
  if (top.length > 0) lines.push(`Where the money went: ${top.join(", ")}.`);

  const repeats = repeatedSpends(expenses).slice(0, 2);
  repeats.forEach((item) => lines.push(`Repeated spend: ${item.description} ${item.count} times, ${money(item.minor)} in total.`));

  const biggest = largestExpenses(expenses, 1)[0];
  if (biggest) lines.push(`Biggest single expense: ${biggest.description}, ${money(toMinor(biggest.amount))} (${biggest.category}).`);

  const elapsedEnd = today < range.end ? today : range.end;
  if (elapsedEnd >= range.start) {
    const days = inclusiveDays({ start: range.start, end: elapsedEnd });
    // Estimates are rounded to whole units so they don't read as exact figures.
    const daily = Math.round(spent / days / 100) * 100;
    lines.push(`Average spend per day so far: ${money(daily)}.`);
    const remaining = inclusiveDays(range) - days;
    if (remaining > 0) {
      const projected = Math.round((spent + (spent / days) * remaining) / 100) * 100;
      lines.push(`At this pace the period ends around ${money(projected)}.`);
    }
  }

  const weekend = expenses.filter((item) => isWeekend(item.transactionDate));
  if (weekend.length > 0 && weekend.length < expenses.length) {
    lines.push(`Weekend spending: ${money(sum(weekend))} (${percent(sum(weekend), spent)} of the total).`);
  }

  const previous = inRange(own, { userId, range: comparableRange(range, today), type: "expense" });
  if (previous.length > 0) {
    const before = sum(previous);
    const delta = spent - before;
    lines.push(
      delta === 0
        ? `Same total as the previous period (${money(before)}).`
        : `${delta > 0 ? "Up" : "Down"} ${money(Math.abs(delta))} on the same stretch of the previous period (${money(before)}).`,
    );
    const shift = biggestCategoryShift(expenses, previous);
    if (shift) {
      lines.push(
        `${shift.category} moved the most: ${money(shift.now)} now against ${money(shift.before)} before.`,
      );
    }
  }

  const saved = sum(expenses.filter((item) => item.category === "Savings"));
  if (saved > 0) lines.push(`Put into savings: ${money(saved)}.`);

  const month = range.start.slice(0, 7);
  for (const budget of input.budgets.filter((item) => item.period === month && item.currency === currency)) {
    const math = budgetMath(budget, input.transactions);
    if (math.remainingMinor < 0) {
      lines.push(`${budget.category} budget is over by ${money(-math.remainingMinor)}.`);
    } else if (math.spentMinor * 5 >= math.budgetMinor * 4) {
      lines.push(`${budget.category} budget has ${money(math.remainingMinor)} left (${percent(math.spentMinor, math.budgetMinor)} used).`);
    } else {
      lines.push(`${budget.category} budget is on track: ${money(math.remainingMinor)} left.`);
    }
  }
  return lines;
}

function sum(rows: TransactionRecord[]): number {
  return rows.reduce((total, item) => total + toMinor(item.amount), 0);
}

function percent(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  return `${Math.round((part / whole) * 100)}%`;
}

function isWeekend(isoDate: string): boolean {
  const [year, month, day] = isoDate.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 || weekday === 6;
}

function repeatedSpends(rows: TransactionRecord[]) {
  const groups = new Map<string, { description: string; count: number; minor: number }>();
  for (const item of rows) {
    const key = item.description.trim().toLowerCase();
    const group = groups.get(key) ?? { description: item.description.trim(), count: 0, minor: 0 };
    group.count += 1;
    group.minor += toMinor(item.amount);
    groups.set(key, group);
  }
  return [...groups.values()].filter((item) => item.count >= 3).sort((left, right) => right.minor - left.minor);
}

function biggestCategoryShift(current: TransactionRecord[], previous: TransactionRecord[]) {
  const now = new Map(totalsByCategory(current).map((item) => [item.category, item.minor]));
  const before = new Map(totalsByCategory(previous).map((item) => [item.category, item.minor]));
  let best: { category: string; now: number; before: number } | null = null;
  for (const category of new Set([...now.keys(), ...before.keys()])) {
    if (category === "Savings") continue;
    const entry = { category, now: now.get(category) ?? 0, before: before.get(category) ?? 0 };
    if (!best || Math.abs(entry.now - entry.before) > Math.abs(best.now - best.before)) best = entry;
  }
  return best && best.now !== best.before ? best : null;
}

/**
 * The earlier stretch to compare against. A calendar month is compared with
 * the month before; one still in progress only with the same days of it.
 */
function comparableRange(range: DateRange, today: string): DateRange {
  const fullMonth = range.start.endsWith("-01") && range.end === endOfMonth(range.start);
  if (!fullMonth) return shiftRangeBack(range);
  const [year, month] = range.start.split("-").map(Number);
  const start = month === 1 ? toIso(year - 1, 12, 1) : toIso(year, month - 1, 1);
  const lastDay = endOfMonth(start);
  if (today < range.start || today >= range.end) return { start, end: lastDay };
  const sameDay = `${start.slice(0, 8)}${today.slice(8, 10)}`;
  return { start, end: sameDay > lastDay ? lastDay : sameDay };
}
