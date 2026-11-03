/** Pure renewal detection shared by browser and server reporting. */
import { addDays } from "@/lib/finance/dates";
import { calendarDay, monthLastDay } from "@/lib/finance/bill-schedule";
import { toMinor } from "@/lib/finance/money";
import type { TransactionRecord } from "@/lib/finance/types";
import type { BillCadence, BillRecord, RenewalSuggestion } from "@/lib/finance/bills";

const KNOWN_SERVICES: [string, string, RegExp][] = [
  ["netflix", "Netflix", /netflix/i],
  ["spotify", "Spotify", /spotify/i],
  ["google-one", "Google One", /google[\s_*]+one/i],
  ["figma", "Figma", /figma/i],
  ["claude", "Claude", /anthropic|claude/i],
  ["chatgpt", "ChatGPT", /openai|chatgpt/i],
  ["discord-nitro", "Discord Nitro", /discord.*nitro/i],
  ["runway", "Runway", /runway/i],
  ["apple", "Apple billing", /apple\.com\/bill|itunes\.com|icloud/i],
  ["dstv", "DStv / GOtv", /\bdstv\b|\bgotv\b|multichoice/i],
  ["showmax", "Showmax", /showmax/i],
  ["youtube", "YouTube Premium", /youtube/i],
  ["fibre", "Home internet", /broadband|\bfib(?:re|er)\b|\bwifi\b/i],
  ["electricity", "Electricity", /\becg\b|electricity|\bnedco\b|prepaid power/i],
  ["water", "Water bill", /ghana water|\bgwcl\b/i],
];

const monthIndex = (date: Date) => date.getUTCFullYear() * 12 + date.getUTCMonth();

function estimateCadence(
  dates: string[],
  amountsMinor: number[],
  today: string,
): { date: string; cadence: BillCadence; stable: boolean; observations: number } | null {
  const uniqueDays = [...new Set(dates)].sort();
  const recent = uniqueDays.slice(-4);
  if (recent.length < 2) return null;
  const parsed = recent.map((day) => new Date(`${day}T00:00:00Z`));
  const latest = parsed[parsed.length - 1]!;
  const ageDays = (Date.parse(`${today}T00:00:00Z`) - latest.getTime()) / 86_400_000;
  const gaps = parsed.slice(1).map((date, idx) => (date.getTime() - parsed[idx]!.getTime()) / 86_400_000);
  const anchor = parsed.every((date) => date.getUTCDate() === monthLastDay(date.getUTCFullYear(), date.getUTCMonth()))
    ? 31
    : Math.max(...parsed.map((date) => date.getUTCDate()));
  const nearAnchor = parsed.every(
    (date) => Math.abs(date.getUTCDate() - Math.min(anchor, monthLastDay(date.getUTCFullYear(), date.getUTCMonth()))) <= 3,
  );
  const monthly = nearAnchor && parsed.slice(1).every((date, idx) => monthIndex(date) - monthIndex(parsed[idx]!) === 1);
  const yearly =
    nearAnchor &&
    parsed
      .slice(1)
      .every((date, idx) => date.getUTCFullYear() - parsed[idx]!.getUTCFullYear() === 1 && date.getUTCMonth() === parsed[idx]!.getUTCMonth());
  const weekly = recent.length >= 3 && gaps.every((gap) => gap >= 6 && gap <= 8);

  let cadence: BillCadence;
  let nextDate: string;
  let maxAge: number;
  if (monthly) {
    cadence = "monthly";
    maxAge = 35;
    const month = latest.getUTCMonth() + 1;
    const year = latest.getUTCFullYear();
    nextDate = calendarDay(year, month, anchor);
    if (nextDate < today) nextDate = calendarDay(year, month + 1, anchor);
  } else if (yearly) {
    cadence = "yearly";
    maxAge = 370;
    nextDate = calendarDay(latest.getUTCFullYear() + 1, latest.getUTCMonth(), anchor);
    if (nextDate < today) nextDate = calendarDay(latest.getUTCFullYear() + 2, latest.getUTCMonth(), anchor);
  } else if (weekly) {
    cadence = "weekly";
    maxAge = 10;
    nextDate = addDays(recent[recent.length - 1]!, 7);
    if (nextDate < today) nextDate = addDays(recent[recent.length - 1]!, 14);
  } else {
    return null;
  }
  if (ageDays > maxAge) return null;
  const recentAmounts = amountsMinor.slice(-recent.length);
  const stable = recentAmounts.every((amt) => amt === recentAmounts[0]);
  return { date: nextDate, cadence, stable, observations: recent.length };
}

/**
 * Finds recurring bills and subscriptions from the person's recorded expenses,
 * excluding any already saved in `savedBills`.
 */
export function detectRenewalCandidates(
  transactions: TransactionRecord[],
  savedBills: BillRecord[],
  today: string,
  currency: string,
): RenewalSuggestion[] {
  const savedNames = new Set(savedBills.map((bill) => bill.name.trim().toLowerCase()));
  const groups = new Map<string, { id: string; name: string; records: TransactionRecord[] }>();

  for (const tx of transactions) {
    if (tx.status !== "active" || tx.type !== "expense" || tx.currency !== currency) continue;
    const minor = toMinor(tx.amount);
    if (minor <= 0 || tx.transactionDate > today) continue;
    const matched = KNOWN_SERVICES.find(([, , pattern]) => pattern.test(tx.description));
    const key = matched
      ? matched[0]
      : tx.category === "Subscriptions" || tx.category === "Utilities" || tx.category === "Rent & home"
        ? tx.description.trim().toLowerCase()
        : null;
    if (!key) continue;
    const name = matched ? matched[1] : tx.description.trim();
    if (savedNames.has(name.toLowerCase())) continue;
    const group = groups.get(key) ?? { id: key, name, records: [] };
    group.records.push(tx);
    groups.set(key, group);
  }

  const suggestions: RenewalSuggestion[] = [];
  for (const group of groups.values()) {
    const sorted = [...group.records].sort((a, b) => a.transactionDate.localeCompare(b.transactionDate));
    const estimate = estimateCadence(
      sorted.map((item) => item.transactionDate),
      sorted.map((item) => toMinor(item.amount)),
      today,
    );
    if (!estimate) continue;
    const last = sorted[sorted.length - 1]!;
    suggestions.push({
      id: group.id,
      name: group.name,
      paymentCount: sorted.length,
      lastDate: last.transactionDate,
      lastAmount: last.amount,
      currency,
      expectedDate: estimate.date,
      cadence: estimate.cadence,
      expectedAmount: estimate.stable ? last.amount : null,
      variableAmount: !estimate.stable,
      basis: `${estimate.observations} recent payments suggest a ${estimate.cadence} schedule${estimate.stable ? "" : " · amounts varied"}.`,
    });
  }
  return suggestions.sort((a, b) => a.expectedDate.localeCompare(b.expectedDate) || a.name.localeCompare(b.name));
}
