"use client";

import { useSyncExternalStore } from "react";
import { applyAccountingAction } from "@/lib/finance/accounting/reducer";
import { validateAccountData } from "@/lib/finance/accounting/accounts";
import type { AccountingAction, AccountingState } from "@/lib/finance/accounting/types";
import { PREVIEW_ACCOUNTING_NOW, previewAccountingFixture } from "./accounting-fixture";

const KEY = "alfred-synthetic-accounting-v1";
const EVENT = "alfred-synthetic-accounting-changed";
let cachedRaw: string | null | undefined;
let cachedState: AccountingState = previewAccountingFixture;
let memoryOnly = false;
function subscribe(callback: () => void) {
  window.addEventListener(EVENT, callback);
  window.addEventListener("storage", callback);
  return () => { window.removeEventListener(EVENT, callback); window.removeEventListener("storage", callback); };
}
export function getPreviewAccountingState(): AccountingState {
  if (typeof window === "undefined") return previewAccountingFixture;
  if (memoryOnly) return cachedState;
  let raw: string | null;
  try { raw = window.localStorage.getItem(KEY); } catch { memoryOnly = true; return cachedState; }
  if (raw === cachedRaw) return cachedState;
  cachedRaw = raw;
  try {
    const parsed = raw ? JSON.parse(raw) as AccountingState : previewAccountingFixture;
    if (parsed.ownerId !== previewAccountingFixture.ownerId || !Number.isSafeInteger(parsed.revision) || !Array.isArray(parsed.audit)) throw new Error("Invalid synthetic accounting state.");
    validateAccountData(parsed);
    cachedState = parsed;
  } catch { cachedState = previewAccountingFixture; }
  return cachedState;
}
export function usePreviewAccounting() { return useSyncExternalStore(subscribe, getPreviewAccountingState, () => previewAccountingFixture); }
export async function dispatchPreviewAccounting(action: AccountingAction): Promise<AccountingState> {
  const next = applyAccountingAction(getPreviewAccountingState(), action, PREVIEW_ACCOUNTING_NOW);
  cachedState = next;
  cachedRaw = JSON.stringify(next);
  try { window.localStorage.setItem(KEY, cachedRaw); } catch { memoryOnly = true; }
  window.dispatchEvent(new Event(EVENT));
  return next;
}
export function resetPreviewAccounting() {
  cachedState = previewAccountingFixture; cachedRaw = null;
  try { window.localStorage.removeItem(KEY); } catch { /* Memory reset remains available. */ }
  window.dispatchEvent(new Event(EVENT));
}
