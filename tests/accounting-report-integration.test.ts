import { beforeEach, describe, expect, it, vi } from "vitest";
import { ingestBankText } from "@/lib/bank/ingest";
import { MemoryBankStore } from "@/lib/bank/store";
import type { SupabaseSettings, UserProfile } from "@/lib/config";
import { executeConfirmed, handleAction, type ActionContext } from "@/lib/finance/action-router";
import { MemoryFinanceStore } from "@/lib/finance/memory-store";
import { readReportingTransactions, type FinanceStore } from "@/lib/finance/store";
import { AccountingError, emptyAccountingState, type AccountingState } from "@/lib/finance/accounting/types";
import { sourceMovements } from "@/lib/finance/accounting/sources";
import type { TransactionRecord } from "@/lib/finance/types";
import { createSupabaseFinanceStore } from "@/lib/supabase/finance-store";

const mocks = vi.hoisted(() => ({ query: vi.fn(), loadAccountingState: vi.fn() }));
vi.mock("@/lib/supabase/connection", () => ({ query: mocks.query }));
vi.mock("@/lib/finance/accounting/persisted-store", () => ({ loadAccountingState: mocks.loadAccountingState }));

const OWNER = "00000000-0000-4000-8000-000000000001";
const RAW_ID = "00000000-0000-4000-8000-000000000010";
const NOW = new Date("2026-11-02T12:00:00Z");
const profile: UserProfile = {
  profileId: OWNER, telegramUserId: null, spreadsheetId: "synthetic", currency: "GHS",
  timezone: "Africa/Accra", preferredName: "Alex", communicationPreference: "concise",
};
function transaction(id = RAW_ID, amount = "18.50"): TransactionRecord {
  return {
    transactionId: id, createdAt: NOW.toISOString(), transactionDate: "2026-11-02", userId: OWNER,
    type: "expense", amount, currency: "GHS", category: "Food", description: "Synthetic lunch",
    paymentMethod: "MoMo", notes: "", status: "active", updatedAt: NOW.toISOString(), sourceUpdateId: id, rowNumber: 1,
  };
}
function databaseRow(row: TransactionRecord) {
  return {
    id: String(row.rowNumber), transaction_id: row.transactionId, created_at: new Date(row.createdAt),
    transaction_date: row.transactionDate, user_id: row.userId, type: row.type, amount: row.amount,
    currency: row.currency, category: row.category, description: row.description, payment_method: row.paymentMethod,
    notes: row.notes, status: row.status, updated_at: new Date(row.updatedAt), source_update_id: row.sourceUpdateId,
  };
}
function context(store: FinanceStore): ActionContext {
  return {
    profile, store, now: NOW, updateId: 1, chatId: 1, confirmTransactions: "auto", pendingTtlMs: 60_000,
    createId: () => "00000000-0000-4000-8000-000000000099", createActionId: () => "synthetic-action",
  };
}

describe("raw source access versus financial reporting integration", () => {
  beforeEach(() => { mocks.query.mockReset(); mocks.loadAccountingState.mockReset(); });

  it("uses an optional reporting getter and preserves backwards compatibility for stores without one", async () => {
    const store: FinanceStore = new MemoryFinanceStore();
    await store.appendTransaction(transaction());
    expect((await readReportingTransactions(store, OWNER))[0].transactionId).toBe(RAW_ID);
    const report = [{ ...transaction("accounting:purchase", "8.50") }];
    store.listReportTransactions = vi.fn(async () => report);
    expect(await readReportingTransactions(store, OWNER)).toBe(report);
    expect(store.listReportTransactions).toHaveBeenCalledWith(OWNER);
    expect((await store.listTransactions(OWNER))[0]).toMatchObject({ transactionId: RAW_ID, amount: "18.50" });
  });

  it("keeps summaries derived while correction and bank matching use original IDs and gross source amounts", async () => {
    const store: FinanceStore = new MemoryFinanceStore();
    await store.appendTransaction(transaction());
    const reportGetter = vi.fn(async () => [transaction("accounting:purchase", "8.50")]);
    store.listReportTransactions = reportGetter;
    const update = vi.spyOn(store, "updateTransaction");
    const summary = await handleAction({ type: "get_spending_summary", period: "this_month", detail: "total" }, context(store));
    expect(summary.kind).toBe("text");
    expect(summary.text).toContain("GH₵8.50");
    expect(summary.text).not.toContain("GH₵18.50");
    expect(reportGetter).toHaveBeenCalledWith(OWNER);
    const reportReads = reportGetter.mock.calls.length;

    const correction = await executeConfirmed({
      type: "correct_transaction", originUpdateId: "1", transactionId: RAW_ID, changes: { description: "Corrected synthetic lunch" },
    }, context(store));
    expect(correction.text).toContain("GH₵18.50");
    expect(update).toHaveBeenCalledWith(OWNER, RAW_ID, expect.objectContaining({ description: "Corrected synthetic lunch" }));
    expect(reportGetter).toHaveBeenCalledTimes(reportReads);

    const bank = new MemoryBankStore();
    const ingested = await ingestBankText({ bank, ledger: store, now: NOW,
      createId: () => "00000000-0000-4000-8000-000000000098",
    }, profile, "Payment made for GHS 18.50 to SYNTHETIC MERCHANT Current Balance: GHS 610.40. Available Balance: GHS 610.40. Transaction ID: 900000001. Fee charged: GHS0.00 Tax charged: 0.", { channel: "manual" });
    expect(ingested.outcomes[0]).toMatchObject({ outcome: "matched", message: { transactionId: RAW_ID } });
    expect(reportGetter).toHaveBeenCalledTimes(reportReads);
    expect((await store.listTransactions(OWNER))).toHaveLength(1);
    expect((await store.listTransactions(OWNER))[0]).toMatchObject({ transactionId: RAW_ID, amount: "18.50" });
  });

  it("Supabase raw access stays raw while report projection uses the accounting read's coherent refreshed rows", async () => {
    const stale = transaction("stale-original", "90.00");
    mocks.query.mockResolvedValue([databaseRow(stale)]);
    const fresh = transaction("fresh-original", "100.00");
    const repayment = { ...transaction("fresh-refund", "40.00"), type: "income" as const, category: "Other income" };
    const raw = [fresh, repayment];
    const movements = sourceMovements(OWNER, raw, []);
    const state: AccountingState = {
      ...emptyAccountingState(OWNER), movements,
      settlements: [{
        id: "refund", kind: "refund", createdAt: NOW.toISOString(),
        original: { movementId: movements[0].id, sourceFingerprint: movements[0].sourceFingerprint },
        returns: [{ movementId: movements[1].id, sourceFingerprint: movements[1].sourceFingerprint, principalMinor: 4_000 }],
      }],
    };
    mocks.loadAccountingState.mockResolvedValue({ availability: "ready", state, rawTransactions: raw });
    // query is mocked; no configuration, network connection or password is used.
    const store = createSupabaseFinanceStore({} as SupabaseSettings);
    expect(await store.listTransactions(OWNER)).toEqual([stale]);
    expect(mocks.loadAccountingState).not.toHaveBeenCalled();
    const report = await readReportingTransactions(store, OWNER);
    expect(mocks.loadAccountingState).toHaveBeenCalledWith({}, OWNER);
    expect(mocks.query).toHaveBeenCalledTimes(1); // Only the explicit raw read above; reporting does not prefetch it.
    expect(report).toHaveLength(1);
    expect(report[0]).toMatchObject({ transactionId: "accounting:transaction:fresh-original", amount: "60.00", type: "expense" });
    expect(report.some((row) => row.transactionId === "stale-original" || row.transactionId === "fresh-refund")).toBe(false);
    expect(await store.listTransactions(OWNER)).toEqual([stale]);
  });

  it("propagates a failed coherent read without falling back to an independently fetched source snapshot", async () => {
    const stale = new AccountingError("Source records changed while loading.", "stale");
    mocks.loadAccountingState.mockRejectedValue(stale);
    const store = createSupabaseFinanceStore({} as SupabaseSettings);
    await expect(readReportingTransactions(store, OWNER)).rejects.toBe(stale);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("returns legacy raw records unchanged when the accounting schema is unavailable", async () => {
    const raw = transaction();
    mocks.query.mockResolvedValue([databaseRow(raw)]);
    mocks.loadAccountingState.mockResolvedValue({ availability: "migration-required", rawTransactions: [raw] });
    const store = createSupabaseFinanceStore({} as SupabaseSettings);
    expect(await readReportingTransactions(store, OWNER)).toEqual([raw]);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.loadAccountingState).toHaveBeenCalledWith({}, OWNER);
  });
});
