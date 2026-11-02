import { addDays, isRealDate } from "@/lib/finance/dates";
import type { BillCadence, BillRecord, UpcomingBill } from "@/lib/finance/bills";

/** Billing commands shared by the existing API workflow and local synthetic adapters. */
export type BillAction =
  | { action: "save"; id?: string; name: string; nextDate: string; amount: string | null; cadence: BillCadence; active?: boolean }
  | { action: "pause" | "resume" | "delete"; id: string };

export const monthLastDay = (year: number, monthIndex: number) => new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
export const calendarDay = (year: number, monthIndex: number, day: number) =>
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
