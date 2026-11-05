"use client";

import { MovementList } from "@/app/accounts/accounts-workspace";
import type { CashMovement } from "@/lib/finance/accounting/types";
import { formatMinor } from "@/lib/finance/money";
import "@/app/accounts/accounts.css";

/** Fictional rows, to see how counted and set-aside payments read side by side. */
const row = (id: string, description: string, category: string, amountMinor: number, status: CashMovement["status"]): CashMovement => ({
  id, ownerId: "sample", accountId: null, direction: "out", status, amountMinor, feeMinor: 0, currency: "GHS", date: "2026-11-05", occurredAt: null,
  description, category, sourceId: id, sourceKind: "transaction", sourceFingerprint: id, legacyTransactionId: null, feeTransactionId: null, legacyClassification: null,
});
const rows = [row("a", "Uber ride to work", "Transport", 7000, "confirmed"), row("b", "Lunch", "Food", 2800, "confirmed"), row("c", "Snack", "Food", 2000, "excluded"), row("d", "Data bundle", "Utilities", 1500, "duplicate"), row("e", "Class donation", "People", 5000, "confirmed")];

export function RowsPreview() {
  return <main className="alfred-accounts mx-auto max-w-3xl px-4 py-8"><MovementList rows={rows} accounts={[]} money={(value, currency = "GHS") => formatMinor(value, currency)} open={() => undefined} /></main>;
}
