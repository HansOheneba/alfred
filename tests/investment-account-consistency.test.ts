import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardAccountBalance } from "@/app/dashboard/account-balance";
import { InvestmentAssetsSummary } from "@/app/investments/investments-client";
import { accountBalances } from "@/lib/finance/accounting/accounts";
import { includedAccountCash } from "@/lib/finance/accounting/cash-summary";
import { emptyAccountingState, type AccountingState } from "@/lib/finance/accounting/types";
import { buildAccountingView } from "@/lib/finance/accounting/view";
import { trackedAssets } from "@/lib/investments/tracked-assets";
import { valuePortfolio } from "@/lib/investments/value";
import type { Investment } from "@/lib/investments/store";
import { formatMinor } from "@/lib/finance/money";
import { loadIncludedAccountCash } from "@/lib/web/included-account-cash";
import type { SupabaseSettings } from "@/lib/config";

const mocks = vi.hoisted(() => ({ loadAccountingReadModel: vi.fn(), logError: vi.fn() }));
vi.mock("@/lib/finance/accounting/persisted-store", () => ({ loadAccountingReadModel: mocks.loadAccountingReadModel }));
vi.mock("@/lib/log", () => ({ logError: mocks.logError }));

const OWNER = "synthetic-asset-owner";
const AT = "2026-11-05T10:00:00Z";
function state(): AccountingState {
  const result = emptyAccountingState(OWNER);
  result.accounts = [
    { id: "current", label: "Current account", provider: "Same provider", currency: "GHS", includeInCash: true, createdAt: AT },
    { id: "reserve", label: "Reserve account", provider: "Same provider", currency: "GHS", includeInCash: true, createdAt: AT },
    { id: "dollars", label: "Dollar account", provider: "Same provider", currency: "USD", includeInCash: true, createdAt: AT },
    { id: "excluded", label: "Excluded account", provider: "Same provider", currency: "GHS", includeInCash: false, createdAt: AT },
  ];
  result.snapshots = result.accounts.map((account, index) => ({ id: `snapshot:${account.id}`, accountId: account.id, balanceMinor: (index + 1) * 10000, occurredAt: AT, sourceId: `statement:${account.id}`, sourceMovementId: null }));
  return result;
}
function basis(s = state(), currency = "GHS") { return { availability: "ready" as const, revision: s.revision, balances: accountBalances(s, currency), loans: [], issues: [] }; }
function portfolio(unknown = false) {
  const investment: Investment = { id: "fund", ownerId: OWNER, name: "Fictional fund", kind: "mutual_fund", provider: "Sample", currency: "GHS", investedBefore: "800.00", principal: null, rate: null, startedOn: null, maturesOn: null, remindedAt: null, payeeKey: null, status: "active" };
  return valuePortfolio({ investments: [{ ...investment, ...(unknown ? { investedBefore: "0.00", importCostBasisUnknown: true } : {}) }], holdings: [], values: unknown ? [] : [{ investmentId: "fund", value: "1000.00", asOf: AT, source: "reported" }], contributions: [], prices: [], today: "2026-11-05" });
}
function markup(s = state()) { return renderToStaticMarkup(createElement(InvestmentAssetsSummary, { cash: includedAccountCash(basis(s), "GHS"), portfolio: portfolio(), timeZone: "Africa/Accra" })); }

describe("the same cash basis across Accounts, Overview and Investments", () => {
  it("retains same-provider accounts and excludes foreign-currency and opted-out balances", () => {
    const s = state();
    const accounts = buildAccountingView(s, "GHS").balances;
    const cash = includedAccountCash(basis(s), "GHS");
    expect(cash).toMatchObject({ totalMinor: accounts.totalMinor, knownSubtotalMinor: 30000, count: 2, missingCount: 0, excludedCount: 2 });
    expect(cash.accounts.map((account) => account.label)).toEqual(["Current account", "Reserve account"]);
    const overview = renderToStaticMarkup(createElement(DashboardAccountBalance, { accounting: basis(s), currency: "GHS" }));
    const investments = markup(s);
    for (const html of [overview, investments]) expect(html).toContain(formatMinor(accounts.totalMinor!, "GHS"));
    expect(trackedAssets(cash, portfolio()).totalMinorGhs).toBe(130000);
    expect(investments).toContain("Tracked assets");
    expect(investments).toContain("not your complete net worth");
    expect(investments).toContain("Debts, loans and assets you haven");
    expect(investments).not.toContain("Dollar account");
  });

  it("keeps incomplete cash and combined assets unknown while showing only the known subtotal", () => {
    const s = state(); s.snapshots = s.snapshots.filter((snapshot) => snapshot.accountId !== "reserve");
    const cash = includedAccountCash(basis(s), "GHS");
    expect(cash).toMatchObject({ totalMinor: null, knownSubtotalMinor: 10000, count: 2, missingCount: 1 });
    expect(trackedAssets(cash, portfolio())).toMatchObject({ totalMinorGhs: null, reason: "cash-unavailable" });
    const html = markup(s);
    expect(html).toContain("Total unavailable");
    expect(html).toContain("Known balances:");
    expect(html).toContain("Partial total");
    expect(html).toContain("1 of 2 included accounts need a current reported balance");
  });

  it("does not reuse a snapshot whose source fingerprint has changed", () => {
    const s = state();
    s.movements.push({ id: "changed-source", ownerId: OWNER, accountId: "current", direction: "out", status: "confirmed", sourceStatus: "confirmed", amountMinor: 1000, feeMinor: 0, currency: "GHS", date: "2026-11-05", occurredAt: AT, description: "Synthetic payment", category: "Food", sourceId: "statement:current", sourceKind: "bank", sourceFingerprint: "new-evidence", legacyTransactionId: null, feeTransactionId: null, legacyClassification: null, reportedBalanceMinor: 10000 });
    s.snapshots[0] = { ...s.snapshots[0], sourceMovementId: "changed-source", sourceFingerprint: "old-evidence" };
    const cash = includedAccountCash(basis(s), "GHS");
    expect(cash.totalMinor).toBeNull();
    expect(cash.accounts[0]).toMatchObject({ balanceMinor: null, reportedAt: null });
    expect(cash.totalMinor).toBe(buildAccountingView(s, "GHS").balances.totalMinor);
  });

  it("preserves valid old reports with their exact dates instead of implying live freshness", () => {
    const s = state(); s.snapshots[0].occurredAt = "2025-10-01T09:00:00Z";
    const cash = includedAccountCash(basis(s), "GHS");
    expect(cash).toMatchObject({ totalMinor: 30000, oldestReportedAt: "2025-10-01T09:00:00Z", latestReportedAt: AT });
    const html = markup(s);
    expect(html).toContain("Oldest included report:");
    expect(html).toContain('dateTime="2025-10-01T09:00:00Z"');
    expect(html).toContain("Reported balances, not live");
  });

  it("distinguishes an evidenced zero from no included accounts or unavailable accounting", () => {
    const s = state(); for (const snapshot of s.snapshots) snapshot.balanceMinor = 0;
    expect(trackedAssets(includedAccountCash(basis(s), "GHS"), portfolio()).totalMinorGhs).toBe(100000);
    for (const account of s.accounts) account.includeInCash = false;
    expect(includedAccountCash(basis(s), "GHS").totalMinor).toBeNull();
    expect(includedAccountCash(null, "GHS")).toMatchObject({ availability: "unavailable", totalMinor: null });
    expect(includedAccountCash({ ...basis(), availability: "migration-required" }, "GHS")).toMatchObject({ availability: "migration-required", totalMinor: null, accounts: [] });
  });

  it("never combines currencies without a known conversion or treats unknown investments as zero", () => {
    const cash = includedAccountCash(basis(state(), "USD"), "USD");
    expect(cash.totalMinor).toBe(30000);
    expect(trackedAssets(cash, portfolio())).toMatchObject({ totalMinorGhs: null, reason: "currency-unavailable" });
    expect(trackedAssets(cash, { ...portfolio(), usdGhs: 10 })).toMatchObject({ cashMinorGhs: 300000, totalMinorGhs: 400000 });
    expect(trackedAssets({ ...cash, currency: "EUR" }, { ...portfolio(), usdGhs: 10 }).totalMinorGhs).toBeNull();
    expect(trackedAssets(includedAccountCash(basis(), "GHS"), portfolio(true))).toMatchObject({ totalMinorGhs: null, unknownInvestmentCount: 1, reason: "investment-unavailable" });
  });

  it("does not render a zero cost basis or known gain when the only active fund has no value or basis", () => {
    const cash = includedAccountCash(basis(), "GHS"), unknown = portfolio(true);
    expect(unknown.investedGhs).toBe(0); // The valuation aggregate has no valued items.
    expect(trackedAssets(cash, unknown)).toMatchObject({ investedGhs: null, gainGhs: null, unknownBasisCount: 1 });
    const html = renderToStaticMarkup(createElement(InvestmentAssetsSummary, { cash, portfolio: unknown }));
    expect(html).toMatch(/You put in<\/dt><dd[^>]*>Unknown cost basis<\/dd>/);
    expect(html).toMatch(/Gain so far<\/dt><dd[^>]*>Unknown gain<\/dd>/);
    expect(html).toContain("Complete contribution history or currency conversion is missing");
  });

  it("keeps aggregate basis and gain unknown when a known fund is mixed with an unvalued imported fund", () => {
    const cash = includedAccountCash(basis(), "GHS"), known = portfolio();
    const unknown = portfolio(true).items[0];
    const mixed = { ...known, items: [...known.items, { ...unknown, investment: { ...unknown.investment, id: "unvalued-import" } }] };
    expect(mixed.investedGhs).toBe(800);
    expect(mixed.gainGhs).toBe(200);
    expect(trackedAssets(cash, mixed)).toMatchObject({ investedGhs: null, gainGhs: null, unknownBasisCount: 1 });
    const html = renderToStaticMarkup(createElement(InvestmentAssetsSummary, { cash, portfolio: mixed }));
    expect(html).toMatch(/You put in<\/dt><dd[^>]*>Unknown cost basis<\/dd>/);
    expect(html).toMatch(/Gain so far<\/dt><dd[^>]*>Unknown gain<\/dd>/);
  });

  it.each(["USD", "EUR"])("does not display a zero GHS basis for a %s investment whose currency conversion is unknown", currency => {
    const item = portfolio().items[0].investment;
    const foreign = valuePortfolio({ investments: [{ ...item, currency }], holdings: [], values: [{ investmentId: item.id, value: "1000.00", asOf: AT, source: "reported" }], contributions: [], prices: [], today: "2026-11-05" });
    expect(foreign.items[0].valueGhs).toBeNull();
    expect(foreign.items[0].investedGhs).toBe(0);
    const cash = includedAccountCash(basis(), "GHS");
    expect(trackedAssets(cash, foreign)).toMatchObject({ investedGhs: null, gainGhs: null, unknownBasisCount: 1 });
    const html = renderToStaticMarkup(createElement(InvestmentAssetsSummary, { cash, portfolio: foreign }));
    expect(html).toMatch(/You put in<\/dt><dd[^>]*>Unknown cost basis<\/dd>/);
    expect(html).toMatch(/Gain so far<\/dt><dd[^>]*>Unknown gain<\/dd>/);
  });

  it("preserves complete investment basis and gain when all active items have values and known conversion", () => {
    expect(trackedAssets(includedAccountCash(basis(), "GHS"), portfolio())).toMatchObject({ investedGhs: 800, gainGhs: 200, unknownBasisCount: 0 });
  });
});

describe("loading canonical account cash for Investments", () => {
  const settings = {} as SupabaseSettings;
  beforeEach(() => { mocks.loadAccountingReadModel.mockReset(); mocks.logError.mockReset(); });
  it("uses one current accounting load without rewriting source or account data", async () => {
    const s = state(), before = structuredClone(s);
    mocks.loadAccountingReadModel.mockResolvedValue({ state: s, availability: "ready" });
    const cash = await loadIncludedAccountCash(settings, OWNER, "GHS");
    expect(cash.totalMinor).toBe(accountBalances(s, "GHS").totalMinor);
    expect(mocks.loadAccountingReadModel).toHaveBeenCalledExactlyOnceWith(settings, OWNER);
    expect(s).toEqual(before);
  });
  it("keeps cash unavailable if the evidence read fails while allowing the investment view to load", async () => {
    mocks.loadAccountingReadModel.mockRejectedValue(new Error("Synthetic database failure"));
    expect(await loadIncludedAccountCash(settings, OWNER, "GHS")).toMatchObject({ availability: "unavailable", totalMinor: null, knownSubtotalMinor: null });
    expect(mocks.logError).toHaveBeenCalledOnce();
  });
});
