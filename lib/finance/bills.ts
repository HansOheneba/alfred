import type { SupabaseSettings } from "@/lib/config";
import { addDays, isRealDate } from "@/lib/finance/dates";
import { toMinor } from "@/lib/finance/money";
import type { TransactionRecord } from "@/lib/finance/types";
import { query } from "@/lib/supabase/connection";

export type BillCadence = "once" | "weekly" | "monthly" | "yearly";

export type BillRecord = {
  id: string;
  ownerId: string;
  name: string;
  nextDate: string;
  /** Expected amount in canonical "123.45" format, or null when the amount varies. */
  amount: string | null;
  currency: string;
  cadence: BillCadence;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type NewBill = {
  id?: string;
  name: string;
  nextDate: string;
  amount: string | null;
  currency: string;
  cadence: BillCadence;
  active?: boolean;
};

export type UpcomingBill = BillRecord & { renewalDate: string };

export type RenewalSuggestion = {
  id: string;
  name: string;
  paymentCount: number;
  lastDate: string;
  lastAmount: string;
  currency: string;
  expectedDate: string;
  cadence: BillCadence;
  expectedAmount: string | null;
  variableAmount: boolean;
  basis: string;
};

export interface BillStore {
  list(ownerId: string): Promise<BillRecord[]>;
  save(ownerId: string, bill: NewBill): Promise<BillRecord>;
  setActive(ownerId: string, id: string, active: boolean): Promise<void>;
  remove(ownerId: string, id: string): Promise<void>;
}

const monthLastDay = (year: number, monthIndex: number) => new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
const calendarDay = (year: number, monthIndex: number, day: number) =>
  new Date(Date.UTC(year, monthIndex, Math.min(day, monthLastDay(year, monthIndex)))).toISOString().slice(0, 10);

/** Next date a confirmed bill falls on, on or after `today` (YYYY-MM-DD). */
export function nextOccurrence(bill: Pick<BillRecord, "active" | "nextDate" | "cadence">, today: string): string | null {
  if (!bill.active || !isRealDate(bill.nextDate) || !isRealDate(today)) return null;
  if (bill.nextDate >= today) return bill.nextDate;
  if (bill.cadence === "once") return null;
  if (bill.cadence === "weekly") {
    const gap = Math.ceil((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${bill.nextDate}T00:00:00Z`)) / 86_400_000 / 7);
    return addDays(bill.nextDate, gap * 7);
  }
  const anchor = new Date(`${bill.nextDate}T00:00:00Z`);
  const target = new Date(`${today}T00:00:00Z`);
  if (bill.cadence === "monthly") {
    let month = target.getUTCMonth();
    let year = target.getUTCFullYear();
    let candidate = calendarDay(year, month, anchor.getUTCDate());
    if (candidate < today) {
      month += 1;
      if (month === 12) {
        month = 0;
        year += 1;
      }
      candidate = calendarDay(year, month, anchor.getUTCDate());
    }
    return candidate;
  }
  if (bill.cadence === "yearly") {
    const year = target.getUTCFullYear();
    let candidate = calendarDay(year, anchor.getUTCMonth(), anchor.getUTCDate());
    if (candidate < today) candidate = calendarDay(year + 1, anchor.getUTCMonth(), anchor.getUTCDate());
    return candidate;
  }
  return null;
}

/** Bills due within `withinDays` of `today`, earliest first. */
export function upcomingBills(bills: BillRecord[], today: string, withinDays = 30): UpcomingBill[] {
  const limit = addDays(today, withinDays);
  return bills
    .map((bill) => {
      const renewalDate = nextOccurrence(bill, today);
      return renewalDate ? { ...bill, renewalDate } : null;
    })
    .filter((item): item is UpcomingBill => item !== null && item.renewalDate <= limit)
    .sort((left, right) => left.renewalDate.localeCompare(right.renewalDate) || left.name.localeCompare(right.name));
}

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

type BillRow = {
  id: string;
  owner_id: string;
  name: string;
  next_date: string | Date;
  amount: string | null;
  currency: string;
  cadence: BillCadence;
  active: boolean;
  created_at: Date;
  updated_at: Date;
};

function toYmd(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function fromRow(row: BillRow): BillRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    nextDate: toYmd(row.next_date),
    amount: row.amount == null ? null : Number(row.amount).toFixed(2),
    currency: row.currency,
    cadence: row.cadence,
    active: row.active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function createSupabaseBillStore(settings: SupabaseSettings): BillStore {
  return {
    async list(ownerId) {
      const rows = await query<BillRow>(
        settings,
        `select id::text, owner_id::text, name, next_date::text, amount::text, currency, cadence, active, created_at, updated_at
         from public.bills
         where owner_id = $1::uuid
         order by active desc, next_date asc, name asc`,
        [ownerId],
      ).catch(() => [] as BillRow[]);
      return rows.map(fromRow);
    },
    async save(ownerId, bill) {
      if (bill.id) {
        const rows = await query<BillRow>(
          settings,
          `update public.bills
           set name = $3, next_date = $4::date, amount = $5::numeric, currency = $6, cadence = $7, active = $8, updated_at = now()
           where owner_id = $1::uuid and id = $2::uuid
           returning id::text, owner_id::text, name, next_date::text, amount::text, currency, cadence, active, created_at, updated_at`,
          [ownerId, bill.id, bill.name.trim(), bill.nextDate, bill.amount, bill.currency, bill.cadence, bill.active ?? true],
        );
        if (rows[0]) return fromRow(rows[0]);
      }
      const rows = await query<BillRow>(
        settings,
        `insert into public.bills (owner_id, name, next_date, amount, currency, cadence, active)
         values ($1::uuid, $2, $3::date, $4::numeric, $5, $6, $7)
         returning id::text, owner_id::text, name, next_date::text, amount::text, currency, cadence, active, created_at, updated_at`,
        [ownerId, bill.name.trim(), bill.nextDate, bill.amount, bill.currency, bill.cadence, bill.active ?? true],
      );
      return fromRow(rows[0]!);
    },
    async setActive(ownerId, id, active) {
      await query(settings, "update public.bills set active = $3, updated_at = now() where owner_id = $1::uuid and id = $2::uuid", [
        ownerId,
        id,
        active,
      ]);
    },
    async remove(ownerId, id) {
      await query(settings, "delete from public.bills where owner_id = $1::uuid and id = $2::uuid", [ownerId, id]);
    },
  };
}

export class MemoryBillStore implements BillStore {
  bills: BillRecord[] = [];

  async list(ownerId: string): Promise<BillRecord[]> {
    return this.bills.filter((item) => item.ownerId === ownerId).map((item) => ({ ...item }));
  }
  async save(ownerId: string, bill: NewBill): Promise<BillRecord> {
    const now = new Date().toISOString();
    const existing = bill.id ? this.bills.find((item) => item.ownerId === ownerId && item.id === bill.id) : undefined;
    if (existing) {
      Object.assign(existing, {
        name: bill.name.trim(),
        nextDate: bill.nextDate,
        amount: bill.amount,
        currency: bill.currency,
        cadence: bill.cadence,
        active: bill.active ?? existing.active,
        updatedAt: now,
      });
      return { ...existing };
    }
    const created: BillRecord = {
      id: bill.id ?? `00000000-0000-4000-8000-${String(this.bills.length + 1).padStart(12, "0")}`,
      ownerId,
      name: bill.name.trim(),
      nextDate: bill.nextDate,
      amount: bill.amount,
      currency: bill.currency,
      cadence: bill.cadence,
      active: bill.active ?? true,
      createdAt: now,
      updatedAt: now,
    };
    this.bills.push(created);
    return { ...created };
  }
  async setActive(ownerId: string, id: string, active: boolean): Promise<void> {
    const bill = this.bills.find((item) => item.ownerId === ownerId && item.id === id);
    if (bill) bill.active = active;
  }
  async remove(ownerId: string, id: string): Promise<void> {
    this.bills = this.bills.filter((item) => !(item.ownerId === ownerId && item.id === id));
  }
}
