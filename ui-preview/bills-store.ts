"use client";

import { useSyncExternalStore } from "react";
import type { BillAction } from "@/app/dashboard/bills-card";
import type { BillRecord, RenewalSuggestion } from "@/lib/finance/bills";
import { isRealDate } from "@/lib/finance/dates";
import { canonicalizeAmount } from "@/lib/finance/money";
import { nextOccurrence } from "@/lib/finance/bill-schedule";
import { previewLedger } from "./fixture";
import { PREVIEW_ACCOUNTING_NOW } from "./accounting-fixture";

const KEY = "alfred-synthetic-bills-v1";
const EVENT = "alfred-synthetic-bills-changed";
const initialBills = previewLedger.bills ?? [];
let cachedRaw: string | null | undefined;
let cachedBills: BillRecord[] = initialBills;
let memoryOnly = false;
const subscriptionHistory = previewLedger.rows.filter((row) => row.type === "expense" && row.description === "Digital subscriptions").sort((a,b) => a.date.localeCompare(b.date));
const lastSubscription = subscriptionHistory.at(-1);
export const previewBillSuggestions: RenewalSuggestion[] = lastSubscription ? [{
  id: "demo-digital-subscriptions-suggestion", name: lastSubscription.description, paymentCount: subscriptionHistory.length,
  lastDate: lastSubscription.date, lastAmount: lastSubscription.amount, currency: lastSubscription.currency,
  expectedDate: nextOccurrence({ active: true, nextDate: lastSubscription.date, cadence: "monthly" }, previewLedger.today)!,
  cadence: "monthly", expectedAmount: lastSubscription.amount, variableAmount: false, basis: "Four recent payments suggest a monthly schedule in the synthetic history.",
}] : [];
function subscribe(callback: () => void) {
  window.addEventListener(EVENT, callback); window.addEventListener("storage", callback);
  return () => { window.removeEventListener(EVENT, callback); window.removeEventListener("storage", callback); };
}
export function getPreviewBills(): BillRecord[] {
  if (typeof window === "undefined") return initialBills;
  if (memoryOnly) return cachedBills;
  let raw: string | null;
  try { raw = localStorage.getItem(KEY); } catch { memoryOnly = true; return cachedBills; }
  if (raw === cachedRaw) return cachedBills;
  cachedRaw = raw;
  try {
    const value = raw ? JSON.parse(raw) : initialBills;
    if (!Array.isArray(value) || !value.every((bill) => typeof bill.id === "string" && typeof bill.name === "string" && isRealDate(bill.nextDate) && ["once","weekly","monthly","yearly"].includes(bill.cadence) && typeof bill.active === "boolean" && (bill.amount === null || typeof bill.amount === "string" && canonicalizeAmount(bill.amount) === bill.amount) && bill.ownerId === previewLedger.bills?.[0]?.ownerId)) throw new Error("Invalid synthetic bills.");
    cachedBills = value;
  } catch { cachedBills = initialBills; }
  return cachedBills;
}
export function usePreviewBills() { return useSyncExternalStore(subscribe, getPreviewBills, () => initialBills); }
function write(bills: BillRecord[]) {
  cachedBills = bills; cachedRaw = JSON.stringify(bills);
  try { localStorage.setItem(KEY, cachedRaw); } catch { memoryOnly = true; }
  window.dispatchEvent(new Event(EVENT));
}
/** Same supported bill commands, applied only to invented browser-local records. */
export async function dispatchPreviewBill(action: BillAction) {
  const bills = getPreviewBills();
  if (action.action === "save") {
    const name = action.name.trim();
    if (!name || name.length > 80) throw new Error("Enter a bill name of 80 characters or fewer.");
    if (!isRealDate(action.nextDate)) throw new Error("Enter a valid next payment date.");
    if (!["once","weekly","monthly","yearly"].includes(action.cadence)) throw new Error("Choose how often the bill repeats.");
    const amount = action.amount == null || !action.amount.trim() ? null : canonicalizeAmount(action.amount);
    if (action.amount != null && action.amount.trim() && amount === null) throw new Error("Enter a positive amount with up to two decimals, or use a variable bill.");
    const existing = action.id ? bills.find((bill) => bill.id === action.id) : null;
    if (action.id && !existing) throw new Error("That synthetic bill no longer exists. Reopen the list.");
    const bill: BillRecord = { id: action.id ?? crypto.randomUUID(), ownerId: initialBills[0].ownerId, name, nextDate: action.nextDate, amount, cadence: action.cadence, currency: previewLedger.currency, active: action.active ?? true, createdAt: existing?.createdAt ?? PREVIEW_ACCOUNTING_NOW, updatedAt: PREVIEW_ACCOUNTING_NOW };
    write(existing ? bills.map((item) => item.id === bill.id ? bill : item) : [...bills,bill]);
  } else {
    if (!bills.some((bill) => bill.id === action.id)) throw new Error("That synthetic bill no longer exists. Reopen the list.");
    write(action.action === "delete" ? bills.filter((bill) => bill.id !== action.id) : bills.map((bill) => bill.id === action.id ? { ...bill, active: action.action === "resume", updatedAt: PREVIEW_ACCOUNTING_NOW } : bill));
  }
}
export function resetPreviewBills() {
  cachedBills = initialBills; cachedRaw = null;
  try { localStorage.removeItem(KEY); } catch { memoryOnly = true; }
  window.dispatchEvent(new Event(EVENT));
}
