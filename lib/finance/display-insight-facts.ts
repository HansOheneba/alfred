import { endOfMonth, inclusiveDays, shiftRangeBack, toIso, type DateRange } from "./dates";
import { formatMinor, toMinor } from "./money";
import { estimateRenewalCadence, renewalGroupForTransaction } from "./bill-renewals";
import type { BillRecord, RenewalSuggestion } from "./bills";
import type { InsightInput } from "./insights";
import type { BudgetRecord, TransactionRecord } from "./types";

export type DisplayExpenseFact = { description: string; minor: number; category: string };
export type DisplayCategoryFact = { category: string; minor: number; count: number; biggest: DisplayExpenseFact | null };
export type DisplayRepeatFact = { description: string; count: number; minor: number };
/** SQL aggregates over a complete canonical generation; no historical detail collection is required. */
export type DisplayInsightFacts = {
  ownerId: string; currency: string; range: DateRange; today: string;
  expenseCount: number; spentMinor: number; incomeMinor: number;
  categories: DisplayCategoryFact[]; repeats: DisplayRepeatFact[];
  fees: { count: number; minor: number }; biggest: DisplayExpenseFact | null;
  weekend: { count: number; minor: number };
  previous: { count: number; minor: number; categories: { category: string; minor: number }[] };
  budgetSpending: { ownerId: string; period: string; currency: string; category: string; spentMinor: number }[];
};

/** Same comparison window as buildInsights, including elapsed calendar-month comparisons. */
export function comparableInsightRange(range: DateRange, today: string): DateRange {
  const fullMonth = range.start.endsWith("-01") && range.end === endOfMonth(range.start);
  if (!fullMonth) return shiftRangeBack(range);
  const [year, month] = range.start.split("-").map(Number);
  const start = month === 1 ? toIso(year - 1, 12, 1) : toIso(year, month - 1, 1);
  const lastDay = endOfMonth(start);
  if (today < range.start || today >= range.end) return { start, end: lastDay };
  const sameDay = `${start.slice(0, 8)}${today.slice(8, 10)}`;
  return { start, end: sameDay > lastDay ? lastDay : sameDay };
}

const sum = (rows: TransactionRecord[]) => rows.reduce((total, row) => total + toMinor(row.amount), 0);
const expense = (row: TransactionRecord): DisplayExpenseFact => ({ description: row.description, minor: toMinor(row.amount), category: row.category });
const biggest = (rows: TransactionRecord[]): DisplayExpenseFact | null => {
  const first = [...rows].sort((left, right) => toMinor(right.amount) - toMinor(left.amount))[0];
  return first ? expense(first) : null;
};
function categories(rows: TransactionRecord[]): DisplayCategoryFact[] {
  const groups = new Map<string, TransactionRecord[]>();
  for (const row of rows) { const group = groups.get(row.category) ?? []; group.push(row); groups.set(row.category, group); }
  return [...groups].map(([category, group]) => ({ category, minor: sum(group), count: group.length, biggest: biggest(group) }))
    .sort((left, right) => right.minor - left.minor || left.category.localeCompare(right.category));
}
function isWeekend(date: string): boolean {
  const [year, month, day] = date.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 || weekday === 6;
}

/** Full-input oracle/helper for tests and workers; enabled page reads aggregate these facts in SQL. */
export function buildDisplayInsightFacts(input: Omit<InsightInput, "budgets">): DisplayInsightFacts {
  const { userId: ownerId, currency, range, today } = input;
  const own = input.transactions.filter(row => row.userId === ownerId && row.status === "active" && row.currency === currency);
  const inRange = (rows: TransactionRecord[], target: DateRange) => rows.filter(row => row.transactionDate >= target.start && row.transactionDate <= target.end);
  const expenses = inRange(own.filter(row => row.type === "expense"), range);
  const income = inRange(own.filter(row => row.type === "income"), range);
  const prior = inRange(own.filter(row => row.type === "expense"), comparableInsightRange(range, today));
  const repeats = new Map<string, DisplayRepeatFact>();
  for (const row of expenses.filter(row => row.category !== "Fees")) {
    const key = row.description.trim().toLowerCase(), group = repeats.get(key) ?? { description: row.description.trim(), count: 0, minor: 0 };
    group.count++; group.minor += toMinor(row.amount); repeats.set(key, group);
  }
  const fees = expenses.filter(row => row.category === "Fees"), weekend = expenses.filter(row => isWeekend(row.transactionDate));
  const budgetSpending = new Map<string, DisplayInsightFacts["budgetSpending"][number]>();
  const period = range.start.slice(0, 7);
  for (const row of input.transactions) {
    if (row.status !== "active" || row.type !== "expense" || !row.transactionDate.startsWith(period) || row.currency !== currency) continue;
    const key = JSON.stringify([row.userId, row.category]), group = budgetSpending.get(key) ?? { ownerId: row.userId, period, currency, category: row.category, spentMinor: 0 };
    group.spentMinor += toMinor(row.amount); budgetSpending.set(key, group);
  }
  return {
    ownerId, currency, range, today, expenseCount: expenses.length, spentMinor: sum(expenses), incomeMinor: sum(income),
    categories: categories(expenses), repeats: [...repeats.values()].filter(group => group.count >= 3).sort((left, right) => right.minor - left.minor).slice(0, 2),
    fees: { count: fees.length, minor: sum(fees) }, biggest: biggest(expenses), weekend: { count: weekend.length, minor: sum(weekend) },
    previous: { count: prior.length, minor: sum(prior), categories: categories(prior).map(({ category, minor }) => ({ category, minor })) },
    budgetSpending: [...budgetSpending.values()],
  };
}

const percent = (part: number, whole: number) => whole <= 0 ? "0%" : `${Math.round(part / whole * 100)}%`;

/** Preserve the existing server-authored wording while combining fresh budget definitions at read time. */
export function formatDisplayInsights(facts: DisplayInsightFacts, budgets: BudgetRecord[]): string[] {
  const { currency, range, today, spentMinor: spent, incomeMinor: earned } = facts;
  const money = (minor: number) => formatMinor(minor, currency), lines: string[] = [];
  if (facts.expenseCount === 0) return ["No expenses are recorded for this period yet, so there is no pattern to read."];
  lines.push(`Total spent: ${money(spent)} across ${facts.expenseCount} expenses.`);
  if (earned > 0) {
    const kept = earned - spent;
    lines.push(kept >= 0 ? `Income: ${money(earned)}. ${money(kept)} of it is not spent yet (${percent(kept, earned)} of income).` : `Income: ${money(earned)}. Spending is ${money(-kept)} more than income.`);
  }
  const currentCategories = [...facts.categories].sort((left, right) => right.minor - left.minor || left.category.localeCompare(right.category));
  const nonSavings = currentCategories.filter(row => row.category !== "Savings");
  const top = nonSavings.slice(0, 3).map(row => `${row.category} ${money(row.minor)} (${percent(row.minor, spent)})`);
  if (top.length) lines.push(`Where the money went: ${top.join(", ")}.`);
  const repeats = facts.repeats.slice(0, 2);
  for (const row of repeats) lines.push(`Repeated spend: ${row.description} ${row.count} times, ${money(row.minor)} in total.`);
  if (facts.fees.count > 1) lines.push(`Transfer fees: ${money(facts.fees.minor)} across ${facts.fees.count} charges.`);
  if (facts.biggest) lines.push(`Biggest single expense: ${facts.biggest.description}, ${money(facts.biggest.minor)} (${facts.biggest.category}).`);
  const elapsedEnd = today < range.end ? today : range.end;
  if (elapsedEnd >= range.start) {
    const days = inclusiveDays({ start: range.start, end: elapsedEnd });
    lines.push(`Average spend per day so far: ${money(Math.round(spent / days / 100) * 100)}.`);
    const remaining = inclusiveDays(range) - days;
    if (remaining > 0) lines.push(`At this pace the period ends around ${money(Math.round((spent + spent / days * remaining) / 100) * 100)}.`);
  }
  if (facts.weekend.count > 0 && facts.weekend.count < facts.expenseCount) lines.push(`Weekend spending: ${money(facts.weekend.minor)} (${percent(facts.weekend.minor, spent)} of the total).`);
  if (facts.previous.count > 0) {
    const before = facts.previous.minor, change = spent - before;
    lines.push(change === 0 ? `Same total as the previous period (${money(before)}).` : `${change > 0 ? "Up" : "Down"} ${money(Math.abs(change))} on the same stretch of the previous period (${money(before)}).`);
    const now = new Map(currentCategories.map(row => [row.category, row.minor]));
    const prior = new Map([...facts.previous.categories].sort((left, right) => right.minor - left.minor || left.category.localeCompare(right.category)).map(row => [row.category, row.minor]));
    let shift: { category: string; now: number; before: number } | null = null;
    for (const category of new Set([...now.keys(), ...prior.keys()])) {
      if (category === "Savings") continue;
      const item = { category, now: now.get(category) ?? 0, before: prior.get(category) ?? 0 };
      if (!shift || Math.abs(item.now - item.before) > Math.abs(shift.now - shift.before)) shift = item;
    }
    if (shift && shift.now !== shift.before) lines.push(`${shift.category} moved the most: ${money(shift.now)} now against ${money(shift.before)} before.`);
  }
  const ideas: string[] = [], first = nonSavings[0], second = nonSavings[1];
  if (first && first.minor * 10 >= spent * 3) {
    const big = first.biggest?.minor ?? 0;
    ideas.push(first.biggest && big * 2 >= first.minor && first.count > 1
      ? `Idea: most of ${first.category} is one payment (${first.biggest.description}, ${money(big)}). If that's a fixed bill, set it aside at the start of the month; the rest of ${first.category} came to ${money(first.minor - big)}.`
      : `Idea: ${first.category} is the biggest area at ${percent(first.minor, spent)} of spending, so it's the first place to look for savings.`);
  }
  if (second && second.category === "Transport" && second.minor * 5 >= spent) ideas.push(`Idea: Transport came to ${money(second.minor)}. Planning or sharing a few trips a week is usually the easiest cut there.`);
  else if (repeats[0] && repeats[0].count >= 3) ideas.push(`Idea: ${repeats[0].description} came up ${repeats[0].count} times. Halving that would save about ${money(Math.round(repeats[0].minor / 2))}.`);
  lines.push(...ideas.slice(0, 2));
  const savings = currentCategories.find(row => row.category === "Savings")?.minor ?? 0;
  if (savings > 0) lines.push(`Put into savings: ${money(savings)}.`);
  for (const budget of budgets.filter(row => row.period === range.start.slice(0, 7) && row.currency === currency)) {
    const spentMinor = facts.budgetSpending.find(row => row.ownerId === budget.userId && row.period === budget.period && row.currency === budget.currency && row.category === budget.category)?.spentMinor ?? 0;
    const budgetMinor = toMinor(budget.amount), remaining = budgetMinor - spentMinor;
    if (remaining < 0) lines.push(`${budget.category} budget is over by ${money(-remaining)}.`);
    else if (spentMinor * 5 >= budgetMinor * 4) lines.push(`${budget.category} budget has ${money(remaining)} left (${percent(spentMinor, budgetMinor)} used).`);
    else lines.push(`${budget.category} budget is on track: ${money(remaining)} left.`);
  }
  return lines;
}

export type DisplayRenewalPaymentFact = { date: string; ordinal: number; minor: number; amount: string };
/** Service identity persisted with each canonical row; saved-name filtering happens before grouping. */
export function displayRenewalGroup(row: Pick<TransactionRecord, "description" | "category">): { id: string; name: string; nameKey: string } | null {
  const identity = renewalGroupForTransaction(row);
  return identity ? { ...identity, nameKey: identity.name.trim().toLowerCase() } : null;
}

/** One id group after per-row fresh saved-bill exclusion, with bounded ordered evidence. */
export type DisplayRenewalFacts = {
  id: string; name: string; currency: string; firstOrdinal: number; paymentCount: number;
  recentDates: string[]; recentPayments: DisplayRenewalPaymentFact[];
};

/** Full-input oracle; SQL can return <=4 dates/payments per service/name variant. */
export function buildDisplayRenewalFacts(transactions: TransactionRecord[], savedBills: BillRecord[], today: string, currency: string): DisplayRenewalFacts[] {
  const savedNames = new Set(savedBills.map(row => row.name.trim().toLowerCase()));
  const groups = new Map<string, DisplayRenewalFacts>();
  transactions.forEach((row, ordinal) => {
    if (row.status !== "active" || row.type !== "expense" || row.currency !== currency || row.transactionDate > today) return;
    const minor = toMinor(row.amount), identity = displayRenewalGroup(row);
    if (minor <= 0 || !identity || savedNames.has(identity.nameKey)) return;
    const key = identity.id;
    const group = groups.get(key) ?? { id: identity.id, name: identity.name, currency, firstOrdinal: ordinal, paymentCount: 0, recentDates: [], recentPayments: [] };
    group.paymentCount++; group.recentDates.push(row.transactionDate);
    group.recentPayments.push({ date: row.transactionDate, ordinal, minor, amount: row.amount }); groups.set(key, group);
  });
  return [...groups.values()].map(group => ({ ...group,
    recentDates: [...new Set(group.recentDates)].sort().slice(-4),
    recentPayments: group.recentPayments.sort((left, right) => left.date.localeCompare(right.date) || left.ordinal - right.ordinal).slice(-4),
  }));
}

/** Facts must already exclude each source row whose normalized name matches a fresh saved bill. */
export function formatDisplayRenewals(facts: DisplayRenewalFacts[], today: string, currency: string): RenewalSuggestion[] {
  const suggestions: RenewalSuggestion[] = [];
  for (const group of [...facts].sort((left, right) => left.firstOrdinal - right.firstOrdinal)) {
    if (group.currency !== currency) continue;
    const dates = [...new Set(group.recentDates)].sort().slice(-4);
    const payments = [...group.recentPayments].sort((left, right) => left.date.localeCompare(right.date) || left.ordinal - right.ordinal).slice(-4);
    const estimate = estimateRenewalCadence(dates, payments.map(row => row.minor), today), last = payments.at(-1);
    if (!estimate || !last) continue;
    suggestions.push({ id: group.id, name: group.name, paymentCount: group.paymentCount, lastDate: last.date, lastAmount: last.amount, currency,
      expectedDate: estimate.date, cadence: estimate.cadence, expectedAmount: estimate.stable ? last.amount : null, variableAmount: !estimate.stable,
      basis: `${estimate.observations} recent payments suggest a ${estimate.cadence} schedule${estimate.stable ? "" : " · amounts varied"}.`,
    });
  }
  return suggestions.sort((left, right) => left.expectedDate.localeCompare(right.expectedDate) || left.name.localeCompare(right.name));
}
