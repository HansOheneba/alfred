import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { isAccountingRow } from "@/app/dashboard/accounting-row-action";
import { TransactionReceipt, TransactionsTable, transactionDirection } from "@/app/dashboard/transactions-table";
import { withLedgerReceipts } from "@/lib/finance/accounting/receipts";
import { AccountingError, emptyAccountingState, type AccountingState, type CashMovement } from "@/lib/finance/accounting/types";
import { accountingReportRows } from "@/lib/finance/accounting/view";
import type { LedgerRow } from "@/lib/finance/analytics";
import { formatMinor } from "@/lib/finance/money";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
const OWNER = "fictional-receipt-owner";
const AT = "2026-11-04T12:34:00Z";
function movement(id = "purchase", patch: Partial<CashMovement> = {}): CashMovement {
  return { id, ownerId: OWNER, accountId: "wallet", direction: "out", status: "confirmed", sourceStatus: "confirmed", amountMinor: 10000, feeMinor: 200, taxMinor: 50, currency: "GHS", date: "2026-11-04", occurredAt: AT, description: `Sample ${id}`, category: "Shopping", sourceId: `source:${id}`, sourceKind: "bank", sourceFingerprint: `fingerprint:${id}`, legacyTransactionId: `raw:${id}`, feeTransactionId: `fee:${id}`, legacyClassification: null, sourceLabel: "Sample wallet provider", sourceText: "synthetic alert text excluded from overview", reportedBalanceBeforeMinor: 50000, reportedBalanceMinor: 39750, ...patch };
}
function state(movements = [movement()]): AccountingState {
  return { ...emptyAccountingState(OWNER), accounts: [{ id: "wallet", label: "Everyday wallet", provider: "Sample provider", currency: "GHS", includeInCash: true, createdAt: AT }], movements };
}
const row = (id = "manual-lunch", patch: Partial<LedgerRow> = {}): LedgerRow => ({ id, date: "2026-11-04", type: "expense", minor: 1500, amount: "15.00", currency: "GHS", category: "Food", description: "Sample lunch", paymentMethod: "Sample cash", ...patch });
const renderReceipt = (record: LedgerRow, timeZone?: string) => renderToStaticMarkup(createElement(TransactionReceipt, { row: record, timeZone, onEdit: vi.fn(), onDelete: vi.fn() }));

describe("bounded overview receipt projection", () => {
  it("keeps selected payment, fee and tax amounts distinct and includes only compact source facts", () => {
    const original = state();
    const report = accountingReportRows(original);
    const before = structuredClone(report);
    const enriched = withLedgerReceipts(report, original, OWNER);
    expect(enriched.map(({ receipt, ...record }) => { expect(receipt).toBeDefined(); return record; })).toEqual(before);
    expect(report).toEqual(before);
    expect(enriched.find(record => record.id === "accounting:purchase")?.receipt).toMatchObject({ kind: "payment", principalMinor: 10000, feeMinor: 200, taxMinor: 50, accountLabel: "Everyday wallet", occurredAt: AT, status: "confirmed", balanceBeforeMinor: 50000, balanceAfterMinor: 39750 });
    expect(enriched.find(record => record.id === "accounting-fee:purchase")).toMatchObject({ minor: 200, receipt: { kind: "fee", principalMinor: 10000 } });
    expect(enriched.find(record => record.id === "accounting-tax:purchase")).toMatchObject({ minor: 50, receipt: { kind: "tax", principalMinor: 10000 } });
    const serialized = JSON.stringify(enriched);
    for (const excluded of ["sourceText", "sourceFingerprint", "fingerprint:purchase", "synthetic alert text", "ownerId", "audit", "snapshots"]) expect(serialized).not.toContain(excluded);
  });

  it("shows a refunded report amount separately from original principal without recalculating or changing totals", () => {
    const original = state([movement(), movement("return", { direction: "in", amountMinor: 4000, feeMinor: 0, taxMinor: 0, occurredAt: "2026-11-04T13:00:00Z" })]);
    original.settlements = [{ id: "sample-refund", kind: "refund", original: { movementId: "purchase", sourceFingerprint: "fingerprint:purchase" }, returns: [{ movementId: "return", sourceFingerprint: "fingerprint:return", principalMinor: 4000 }], createdAt: "2026-11-04T14:00:00Z" }];
    const report = accountingReportRows(original);
    const selected = withLedgerReceipts(report, original, OWNER).find(record => record.id === "accounting:purchase")!;
    expect(selected).toMatchObject({ minor: 6000, receipt: { principalMinor: 10000, links: ["refund"] } });
    const html = renderReceipt(selected);
    expect(html).toContain(`−${formatMinor(6000, "GHS")}`);
    expect(html).toContain("Original payment");
    expect(html).toContain(formatMinor(10000, "GHS"));
    expect(html).toContain("after linked refunds or repayments");
    expect(original.movements[0].amountMinor).toBe(10000);
  });

  it("preserves missing timestamps rather than using a fabricated projection midnight", () => {
    const original = state([movement("untimed", { occurredAt: null })]);
    const record = withLedgerReceipts(accountingReportRows(original), original, OWNER)[0];
    expect(record.receipt?.occurredAt).toBeNull();
    expect(renderReceipt(record)).toContain("Time not recorded");
    expect(renderReceipt(record)).not.toContain("00:00");
  });

  it("resolves raw principal and fee aliases separately and fails closed for ambiguous aliases", () => {
    const original = state();
    const records = withLedgerReceipts([row("raw:purchase"), row("fee:purchase")], original, OWNER);
    expect(records.map(record => record.receipt?.kind)).toEqual(["payment", "fee"]);
    original.movements.push(movement("collision", { legacyTransactionId: "raw:purchase", feeTransactionId: "fee:purchase" }));
    expect(withLedgerReceipts([row("raw:purchase"), row("fee:purchase")], original, OWNER).every(record => !record.receipt)).toBe(true);
  });

  it("rejects the wrong state owner and never attaches another owner's movements or mismatched-currency account", () => {
    expect(() => withLedgerReceipts([row("accounting:purchase")], state(), "different-owner")).toThrow(AccountingError);
    const foreign = state([movement("foreign", { ownerId: "different-owner" })]);
    expect(withLedgerReceipts([row("accounting:foreign")], foreign, OWNER)[0].receipt).toBeUndefined();
    const wrongCurrency = state();
    wrongCurrency.accounts[0].currency = "USD";
    expect(withLedgerReceipts([row("accounting:purchase")], wrongCurrency, OWNER)[0].receipt?.accountLabel).toBeNull();
  });

  it("does not reuse a missing source's raw alias and keeps retained imported evidence explicit", () => {
    const original = state([movement("old", { sourceMissing: true, importProvenance: { namespace: "sample-import", sourceId: "sample-archive-row" } })]);
    const records = withLedgerReceipts([row("raw:old"), row("accounting:old")], original, OWNER);
    expect(records[0].receipt).toBeUndefined();
    expect(records[1].receipt).toMatchObject({ sourceMissing: true, imported: true });
    const html = renderReceipt(records[1]);
    expect(html).toContain("Imported record");
    expect(html).toContain("original source is no longer available");
    expect(html).not.toContain("sample-archive-row");
  });
});

describe("in-place transaction details", () => {
  it.each([
    ["expense", 1500, "out", "Money out", "−"],
    ["income", 1500, "in", "Money in", "+"],
    ["expense", -1500, "in", "Money in", "+"],
    ["income", -1500, "out", "Money out", "−"],
  ] as const)("keeps %s %d signs, direction words and color classes consistent", (type, minor, direction, label, sign) => {
    const selected = row("native-adjustment", { type, minor, amount: (minor / 100).toFixed(2) });
    expect(transactionDirection(selected)).toBe(direction);
    const html = renderReceipt(selected);
    expect(html).toContain(`alfred-transaction-receiptHero is-${direction}`);
    expect(html).toContain(label);
    expect(html).toContain(`${sign}${formatMinor(1500, "GHS")}`);
    expect(html).not.toContain("−−");
  });

  it("keeps manual edit/delete actions but makes accounting principal, fee and tax rows read-only", () => {
    const manual = renderReceipt(row());
    expect(manual).toContain("Edit transaction");
    expect(manual).toContain("Delete transaction");
    for (const id of ["accounting:purchase", "accounting-fee:purchase", "accounting-tax:purchase"]) {
      expect(isAccountingRow(id)).toBe(true);
      const html = renderReceipt(row(id));
      expect(html).not.toContain("Edit transaction");
      expect(html).not.toContain("Delete transaction");
      expect(html).toContain("managed with its source payment");
    }
    expect(isAccountingRow("accounting-taxonomy:manual")).toBe(false);
    expect(isAccountingRow("manual-fee")).toBe(false);
  });

  it("labels fees and taxes as separate money-out lines rather than as the parent payment", () => {
    const records = withLedgerReceipts(accountingReportRows(state()), state(), OWNER);
    for (const [prefix, label, minor] of [["accounting-fee:", "Fee", 200], ["accounting-tax:", "Tax", 50]] as const) {
      const html = renderReceipt(records.find(record => record.id.startsWith(prefix))!);
      const hero = html.match(/<header[\s\S]*?<\/header>/)?.[0];
      expect(hero).toContain(`Money out · ${label}`);
      expect(hero).toContain(`−${formatMinor(minor, "GHS")}`);
      expect(hero).not.toContain(formatMinor(10000, "GHS"));
      expect(html).toContain("Original payment");
      expect(html).toContain("Payment status");
    }
  });

  it("uses the viewer timezone for actual source time and falls back safely for invalid settings", () => {
    const selected = withLedgerReceipts(accountingReportRows(state()), state(), OWNER)[0];
    expect(renderReceipt(selected, "America/New_York")).toContain("07:34 GMT-5");
    expect(renderReceipt(selected, "invalid-zone")).toContain("12:34 UTC");
  });

  it("keeps source date and time together across midnight while preserving a separately labelled report date", () => {
    const original = state([movement("midnight", { occurredAt: "2026-11-04T00:34:00Z" })]);
    const selected = withLedgerReceipts(accountingReportRows(original), original, OWNER)[0];
    const html = renderReceipt(selected, "America/New_York");
    expect(html).toContain("3 Nov 2026 · 19:34 GMT-5");
    expect(html).not.toContain("4 Nov 2026 · 19:34");
    expect(html).toContain("<dt>Report date</dt><dd>4 Nov 2026</dd>");
    expect(selected.date).toBe("2026-11-04");
  });

  it("opens details with buttons on both layouts and leaves only View all as an Accounts link", () => {
    const records = withLedgerReceipts(accountingReportRows(state()), state(), OWNER);
    const html = renderToStaticMarkup(createElement(TransactionsTable, { rows: [...records, row()], category: null, onClearCategory: vi.fn(), rangeLabel: "this month" }));
    expect(html.match(/aria-label="View details for /g)).toHaveLength(8); // Four desktop buttons and four mobile rows.
    expect(html.match(/href="\/accounts\?tab=activity"/g)).toHaveLength(1);
    expect(html).toContain("View all transactions");
    const actions = html.match(/<div class="alfred-transaction-headerActions">[\s\S]*?<\/div>/)?.[0];
    expect(actions).toContain('aria-label="Filters"');
    expect(actions).toContain('alfred-button--primary');
    expect(actions).toContain("View all transactions");
    expect(html.match(/<div class="alfred-transaction-footer">[\s\S]*?<\/div>/)?.[0]).not.toContain("<a");
    expect(html).not.toContain("Manage in Accounts");
    expect(html).not.toContain("alfred-transaction-desktopFilters");
    expect(html).toContain('aria-label="Filters"');
    expect(html).toContain("Filter transactions");
    expect(html).toContain("Apply filters");
  });
});
