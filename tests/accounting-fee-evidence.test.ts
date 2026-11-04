import { describe, expect, it } from "vitest";
import { validateAccountData } from "@/lib/finance/accounting/accounts";
import { accountingReportRows } from "@/lib/finance/accounting/view";
import { emptyAccountingState, type CashMovement } from "@/lib/finance/accounting/types";

const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const movement: CashMovement = { id: "bank:fixture", ownerId, sourceId: "fixture", sourceKind: "bank", sourceFingerprint: "fixture",
  accountId: null, direction: "out", status: "review", sourceStatus: "transfer", amountMinor: 100, feeMinor: 38, confirmedFeeMinor: 38,
  currency: "GHS", date: "2026-11-04", occurredAt: "2026-11-04T11:09:00Z", description: "Fictional transfer", category: "Uncategorized",
  legacyTransactionId: null, feeTransactionId: "fixture-fee", legacyClassification: null, automaticTransferStale: true };
const state = (patch: Partial<CashMovement> = {}) => ({ ...emptyAccountingState(ownerId), movements: [{ ...movement, ...patch }] });

describe("confirmed fee evidence boundary", () => {
  it("keeps a confirmed native fee once while the transfer principal needs review", () => {
    expect(() => validateAccountData(state())).not.toThrow();
    expect(accountingReportRows(state()).map(row => [row.type, row.minor, row.category])).toEqual([["expense", 38, "Fees"]]);
  });
  it.each([NaN, Infinity, -1, 38.5, 39])("rejects invalid or inflated confirmed fees: %s", confirmedFeeMinor => {
    expect(() => validateAccountData(state({ confirmedFeeMinor }))).toThrow();
    expect(accountingReportRows(state({ confirmedFeeMinor }))).toEqual([]);
  });
  it("does not treat portable or manual metadata as proof of an active native bank fee", () => {
    expect(accountingReportRows(state({ sourceKind: "manual", importProvenance: { namespace: "sample", sourceId: "fixture" } }))).toEqual([]);
    expect(accountingReportRows(state({ sourceKind: "transaction" }))).toEqual([]);
    expect(accountingReportRows(state({ feeTransactionId: null }))).toEqual([]);
    expect(accountingReportRows(state({ sourceMissing: true }))).toEqual([]);
  });
});
