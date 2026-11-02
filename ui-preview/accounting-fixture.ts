import type { AccountingState, CashMovement } from "@/lib/finance/accounting/types";
import { previewLedger } from "./fixture";
import { previewOccurrenceFor } from "./transaction-times";

/** Entirely invented records. These fixtures never belong in a real account. */
export const PREVIEW_ACCOUNTING_NOW = "2026-10-24T10:00:00Z";
const ownerId = "00000000-0000-4000-8000-000000000001";
const account = (method: string) => method === "GCB card" ? "demo-account-gcb" : method === "MoMo" ? "demo-account-momo" : null;
const movements: CashMovement[] = previewLedger.rows.map((row) => ({
  id: row.id, ownerId, accountId: account(row.paymentMethod), direction: row.type === "income" ? "in" : "out",
  status: "confirmed", amountMinor: row.minor, feeMinor: 0, currency: row.currency,
  date: row.date, occurredAt: previewOccurrenceFor(row), description: row.description, category: row.category,
  sourceId: `synthetic-record:${row.id}`, sourceKind: "transaction", sourceFingerprint: `synthetic-v1:${row.id}`,
  legacyTransactionId: row.id, feeTransactionId: null, legacyClassification: null,
}));
function example(id: string, direction: "in" | "out", amountMinor: number, description: string, accountId: string, status: CashMovement["status"] = "confirmed"): CashMovement {
  return { id, ownerId, accountId, direction, amountMinor, feeMinor: 0, currency: "GHS", date: "2026-09-25", occurredAt: "2026-09-25T12:00:00Z", description, category: "Personal", status, sourceId: `synthetic-alert:${id}`, sourceKind: "bank", sourceFingerprint: `synthetic-v1:${id}`, legacyTransactionId: null, feeTransactionId: null, legacyClassification: null };
}
movements.push(
  example("demo-refund-original", "out", 40000, "Headphones purchase", "demo-account-gcb"),
  example("demo-refund-return", "in", 12000, "Headphones partial refund", "demo-account-gcb"),
  example("demo-loan-original", "out", 60000, "Loan to Sam", "demo-account-momo"),
  example("demo-loan-return", "in", 15000, "Sam returned part of loan", "demo-account-momo"),
  { ...example("demo-loan-return-2", "in", 10000, "Sam second loan repayment", "demo-account-momo"), date: "2026-09-27", occurredAt: "2026-09-27T12:00:00Z" },
  example("demo-transfer-out", "out", 50000, "Move to my MoMo", "demo-account-gcb"),
  example("demo-transfer-in", "in", 50000, "From my GCB account", "demo-account-momo"),
);
movements.push(...previewLedger.bank.needsLabel.map((item): CashMovement => ({
  id: item.id, ownerId, accountId: null, direction: item.direction, amountMinor: Math.round(Number(item.amount) * 100), feeMinor: 0, currency: item.currency,
  date: item.occurredAt.slice(0, 10), occurredAt: item.occurredAt, description: item.counterparty, category: "Uncategorised", status: "review",
  sourceId: `synthetic-alert:${item.id}`, sourceKind: "bank", sourceFingerprint: `synthetic-v1:${item.id}`, legacyTransactionId: null, feeTransactionId: null, legacyClassification: null,
  sourceLabel: "Synthetic payment alert",
  sourceText: `DEMO RECORD — ${item.amount} ${item.currency} sent to ${item.counterparty}. Reference ${item.id}. This is invented preview evidence.`,
  ...(item.id === "demo-review-1" ? { reportedBalanceBeforeMinor: 191740, reportedBalanceMinor: 183240 } : {}),
})));

export const previewAccountingFixture: AccountingState = {
  ownerId, revision: 0, audit: [], transfers: [], settlements: [], movements,
  accounts: [
    { id: "demo-account-gcb", label: "GCB card", provider: "GCB Bank", currency: "GHS", includeInCash: true, createdAt: "2026-01-01T00:00:00Z" },
    { id: "demo-account-momo", label: "MoMo", provider: "MTN Mobile Money", currency: "GHS", includeInCash: true, createdAt: "2026-01-01T00:00:00Z" },
  ],
  snapshots: [
    { id: "demo-gcb-before", accountId: "demo-account-gcb", balanceMinor: 1255975, occurredAt: "2026-10-23T00:00:00Z", sourceId: "synthetic-gcb-previous-alert", sourceMovementId: null },
    { id: "demo-gcb-latest", accountId: "demo-account-gcb", balanceMinor: 1248575, occurredAt: "2026-10-24T09:42:00Z", sourceId: "synthetic-gcb-latest-alert", sourceMovementId: null },
    { id: "demo-momo-before", accountId: "demo-account-momo", balanceMinor: 188265, occurredAt: "2026-10-23T00:00:00Z", sourceId: "synthetic-momo-previous-alert", sourceMovementId: null },
    { id: "demo-momo-latest", accountId: "demo-account-momo", balanceMinor: 183240, occurredAt: "2026-10-24T08:16:00Z", sourceId: "synthetic-momo-latest-alert", sourceMovementId: null },
  ],
};
