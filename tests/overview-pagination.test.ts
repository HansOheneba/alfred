import { describe, expect, it, vi } from "vitest";
import type { StudioSettings, UserProfile } from "@/lib/config";
import { emptyAccountingState, type AccountingState, type CashMovement } from "@/lib/finance/accounting/types";
import type { AccountingResult } from "@/lib/finance/accounting/persisted-store";
import { accountingReportRows } from "@/lib/finance/accounting/view";
import type { Ledger } from "@/lib/web/ledger";
import type { LedgerRow } from "@/lib/finance/analytics";
import { buildOverviewSummary } from "@/lib/web/overview-summary";
import { InvalidOverviewPage, loadOverview, loadOverviewTransactionPage, OverviewChanged, overviewTransactionPage, parseOverviewTransactionQuery } from "@/lib/web/overview";
import { filterOverviewTransactions, overviewTransactionQueryKey, type OverviewTransactionQuery } from "@/lib/web/overview-transactions";

const mocks = vi.hoisted(() => ({ snapshot: vi.fn(), accounting: vi.fn() }));
vi.mock("@/lib/web/ledger", () => ({ loadLedgerSnapshot: mocks.snapshot }));
vi.mock("@/lib/finance/accounting/persisted-store", () => ({ loadAccountingReadModel: mocks.accounting }));
const OWNER = "fictional-overview-owner", AT = "2026-11-05T12:00:00Z";
const profile = { profileId: OWNER, currency: "GHS", timezone: "Africa/Accra" } as UserProfile;
const query: OverviewTransactionQuery = { preset: "this_month", category: null, filters: { search: "", type: "all", category: "all", sort: "date-desc" } };
const movement = (id: string, patch: Partial<CashMovement> = {}): CashMovement => ({ id, ownerId: OWNER, accountId: "cash", direction: "out", status: "confirmed", sourceStatus: "confirmed", amountMinor: 100, feeMinor: 0, currency: "GHS", date: "2026-11-04", occurredAt: AT, category: "Food", description: `Fictional purchase ${id}`, sourceId: `source:${id}`, sourceKind: "bank", sourceFingerprint: `fingerprint:${id}`, legacyTransactionId: null, feeTransactionId: null, legacyClassification: null, importProvenance: { namespace: "fictional-import", sourceId: id }, ...patch });
function fixture() {
  const state: AccountingState = { ...emptyAccountingState(OWNER), accounts: [{ id: "cash", label: "Fictional cash", provider: "Fictional provider", currency: "GHS", includeInCash: true, createdAt: AT }, { id: "reserve", label: "Fictional reserve", provider: "Fictional provider", currency: "GHS", includeInCash: true, createdAt: AT }], movements: [
    ...Array.from({ length: 36 }, (_, n) => movement(`purchase:${String(n).padStart(2, "0")}`)),
    movement("original", { date: "2026-11-01", amountMinor: 10000, feeMinor: 200, taxMinor: 50, category: "Shopping" }),
    movement("return", { direction: "in", date: "2026-11-02", amountMinor: 4000, category: "Shopping" }),
    movement("transfer-out", { status: "transfer", amountMinor: 20000, feeMinor: 50 }),
    movement("transfer-in", { status: "transfer", accountId: "reserve", direction: "in", amountMinor: 20000 }),
    movement("signed-adjustment", { date: "2026-11-02", amountMinor: 500, legacyClassification: "refund" }),
    movement("old", { date: "2025-01-02", amountMinor: 700 }),
    movement("salary", { direction: "in", amountMinor: 90000, category: "Salary" }),
    movement("foreign-currency", { currency: "USD", amountMinor: 99999 }),
    movement("foreign-owner", { ownerId: "other-fictional-owner", amountMinor: 88888 }),
  ], transfers: [{ id: "fictional-transfer", outgoing: { movementId: "transfer-out", sourceFingerprint: "fingerprint:transfer-out" }, incoming: { movementId: "transfer-in", sourceFingerprint: "fingerprint:transfer-in" }, createdAt: AT }], settlements: [{ id: "fictional-refund", kind: "refund", original: { movementId: "original", sourceFingerprint: "fingerprint:original" }, returns: [{ movementId: "return", sourceFingerprint: "fingerprint:return", principalMinor: 4000 }], createdAt: AT }] };
  const rows = accountingReportRows(state), accounting: AccountingResult = { state, availability: "ready", sourceVersion: "fictional-version", rawTransactions: [] };
  const ledger: Ledger = { today: "2026-11-05", currency: "GHS", rows, budgets: [], goals: [], insights: [], owed: [], owe: [], bank: { connected: false, lastUsedAt: null, lastEmptyAt: null, accountNames: [], needsLabel: [], balances: [] } };
  return { state, rows, accounting, ledger };
}

describe("Overview full-history summaries and bounded transaction pages", () => {
  it("retains complete totals for all six period controls independently of the visible page", () => {
    const { ledger } = fixture();
    const dates = ["2026-11-01", "2026-10-15", "2026-09-01", "2026-06-15", "2026-01-01", "2025-12-01"];
    const rows: LedgerRow[] = dates.map((date, index) => ({ id: `fictional-period:${index}`, date, type: "expense", minor: (index + 1) * 100, amount: String(index + 1), currency: "GHS", category: "Food", description: "Fictional period sample", paymentMethod: "Cash" }));
    const summary = buildOverviewSummary({ ...ledger, rows });
    expect(Object.fromEntries(Object.entries(summary.reports).map(([key, report]) => [key, report.spent]))).toEqual({ this_month: 100, last_month: 200, last_3_months: 600, last_6_months: 1000, this_year: 1500, all: 2100 });
    expect(summary.reports.this_month.previousSpent).toBe(200);
    expect(summary.monthly.reduce((sum, month) => sum + month.spent, 0)).toBe(2100);
    expect(summary.reports.all.range.start).toBe("2025-12-01");
  });

  it("keeps refunds whose counterpart lies outside the first page, transfer fees, signed adjustments and other currencies correct", () => {
    const { ledger } = fixture(), summary = buildOverviewSummary(ledger);
    expect(summary.reports.this_month).toMatchObject({ spent: 9400, earned: 90000, categories: expect.arrayContaining([{ category: "Shopping", minor: 6000, count: 1 }, { category: "Fees", minor: 250, count: 2 }, { category: "Taxes", minor: 50, count: 1 }]) });
    expect(summary.reports.all.spent).toBe(10100);
    expect(summary.reports.last_month.spent).toBe(0);
    expect(summary.reports.this_year.spent).toBe(9400);
    expect(summary.otherCurrencyCount).toBe(1);
    expect(summary.reports.this_month.categoryDetails.Shopping).toMatchObject({ minor: 6000, count: 1 });
    expect(summary.reports.this_month.daily.at(-1)?.spent).toBeDefined();
    expect(summary.setup.hasTransaction).toBe(true);
  });

  it("loads every matching detail in stable pages of at most 15, preserving full totals and compact receipts", () => {
    const { rows, accounting, ledger } = fixture(), before = structuredClone(accounting.state);
    const seen: LedgerRow[] = []; let cursor: string | null = null;
    do {
      const page = overviewTransactionPage(profile, accounting, rows, ledger.today, query, cursor);
      expect(page.rows.length).toBeLessThanOrEqual(15); expect(page.total).toBe(42);
      expect(page.rows.every(row => row.currency === "GHS" && row.receipt)).toBe(true);
      seen.push(...page.rows); cursor = page.nextCursor;
    } while (cursor);
    const candidates = [...rows.filter(row => row.currency === "GHS" && row.date.startsWith("2026-11") && row.type === "expense"), ...rows.filter(row => row.currency === "GHS" && row.date.startsWith("2026-11") && row.type === "income")];
    expect(seen.map(row => row.id)).toEqual(filterOverviewTransactions(candidates, query.filters).map(row => row.id));
    expect(new Set(seen.map(row => row.id)).size).toBe(42);
    expect(seen.find(row => row.id === "accounting:original")).toMatchObject({ minor: 6000, receipt: { principalMinor: 10000, links: ["refund"] } });
    expect(seen.some(row => row.id === "accounting:transfer-out" || row.id === "accounting:transfer-in")).toBe(false);
    expect(JSON.stringify(seen)).not.toMatch(/sourceFingerprint|sourceText|fictional-overview-owner/);
    expect(accounting.state).toEqual(before);
  });

  it("applies range, search, category, type and signed amount sorting to the complete history before paging", () => {
    const { rows, accounting, ledger } = fixture();
    const selected = overviewTransactionPage(profile, accounting, rows, ledger.today, { ...query, category: "Shopping", filters: { ...query.filters, search: " ORIGINAL ", type: "expense", sort: "amount-asc" } });
    expect(selected.total).toBe(1); expect(selected.rows[0].minor).toBe(6000);
    const all = overviewTransactionPage(profile, accounting, rows, ledger.today, { ...query, preset: "all", filters: { ...query.filters, sort: "date-asc" } });
    expect(all.rows[0].id).toBe("accounting:old");
    const signed = overviewTransactionPage(profile, accounting, rows, ledger.today, { ...query, filters: { ...query.filters, sort: "amount-asc" } });
    expect(signed.rows[0]).toMatchObject({ id: "accounting:signed-adjustment", minor: -500 });
    expect(selected.categories).toContain("Salary");
  });

  it("keeps linked loan principal and repayments outside spending/income while retaining the separate fee", () => {
    const { state, accounting, ledger } = fixture();
    state.movements.push(movement("loan", { amountMinor: 7000, feeMinor: 75, date: "2026-11-01" }), movement("repayment", { direction: "in", amountMinor: 2000, date: "2026-11-02" }));
    state.settlements.push({ id: "fictional-loan", kind: "loan", original: { movementId: "loan", sourceFingerprint: "fingerprint:loan" }, returns: [{ movementId: "repayment", sourceFingerprint: "fingerprint:repayment", principalMinor: 2000 }], createdAt: AT });
    const rows = accountingReportRows(state), summary = buildOverviewSummary({ ...ledger, rows });
    expect(summary.reports.this_month).toMatchObject({ spent: 9475, earned: 90000 });
    const selected = overviewTransactionPage(profile, accounting, rows, ledger.today, { ...query, filters: { ...query.filters, search: "loan" } });
    expect(selected.rows).toHaveLength(1); expect(selected.rows[0]).toMatchObject({ id: "accounting-fee:loan", minor: 75, receipt: { links: ["loan"] } });
  });

  it("refuses to combine pages after an owner, currency, date, revision, source or query change", () => {
    const { rows, accounting, ledger } = fixture();
    const cursor = overviewTransactionPage(profile, accounting, rows, ledger.today, query).nextCursor!;
    for (const changed of [
      () => overviewTransactionPage({ ...profile, profileId: "other-fictional-owner" }, accounting, rows, ledger.today, query, cursor),
      () => overviewTransactionPage({ ...profile, currency: "USD" }, accounting, rows, ledger.today, query, cursor),
      () => overviewTransactionPage(profile, accounting, rows, "2026-11-06", query, cursor),
      () => overviewTransactionPage(profile, { ...accounting, state: { ...accounting.state, revision: 1 } }, rows, ledger.today, query, cursor),
      () => overviewTransactionPage(profile, { ...accounting, sourceVersion: "changed-source" }, rows, ledger.today, query, cursor),
      () => overviewTransactionPage(profile, accounting, rows, ledger.today, { ...query, filters: { ...query.filters, sort: "date-asc" } }, cursor),
    ]) expect(changed).toThrow(OverviewChanged);
    const legacy = { ...accounting, sourceVersion: null };
    const legacyCursor = overviewTransactionPage(profile, legacy, rows, ledger.today, query).nextCursor!;
    expect(() => overviewTransactionPage(profile, legacy, rows.slice(1), ledger.today, query, legacyCursor)).toThrow(OverviewChanged);
  });

  it.each(["!", "a", Buffer.from("{}").toString("base64url"), "a".repeat(1201)])("rejects malformed cursors (%s)", cursor => {
    const { rows, accounting, ledger } = fixture();
    expect(() => overviewTransactionPage(profile, accounting, rows, ledger.today, query, cursor)).toThrow(InvalidOverviewPage);
  });

  it("bounds cursor size even with a maximum Unicode search and validates URL input", () => {
    const { rows, accounting, ledger } = fixture();
    const search = "😀".repeat(100), unicodeRows = rows.map(row => ({ ...row, description: search }));
    const unicodeQuery = { ...query, filters: { ...query.filters, search } };
    const page = overviewTransactionPage(profile, accounting, unicodeRows, ledger.today, unicodeQuery);
    expect(page.nextCursor!.length).toBeLessThan(400);
    expect(overviewTransactionPage(profile, accounting, unicodeRows, ledger.today, unicodeQuery, page.nextCursor).rows.length).toBe(15);
    expect(parseOverviewTransactionQuery(new URLSearchParams())).toEqual(query);
    for (const search of ["range=unknown", "range=all&range=this_month", "ownerId=other", "tx_sort=wrong", `tx_q=${"x".repeat(201)}`]) expect(() => parseOverviewTransactionQuery(new URLSearchParams(search))).toThrow();
  });

  it("sends one 15-row page separately from complete summaries and preserves all-time onboarding readiness", async () => {
    const { ledger, accounting } = fixture(); mocks.snapshot.mockResolvedValue({ ledger, accounting });
    const result = await loadOverview(profile, {} as StudioSettings, query);
    expect(mocks.snapshot).toHaveBeenCalledWith(profile, {}, { receipts: false });
    expect(result.ledger.rows).toEqual([]); expect(result.firstPage.rows).toHaveLength(15);
    expect(result.summary.reports.this_month.spent).toBe(9400);
    const quiet = await loadOverview(profile, {} as StudioSettings, { ...query, preset: "last_month" });
    expect(quiet.firstPage.rows).toEqual([]); expect(quiet.summary.setup.hasTransaction).toBe(true);
    expect(quiet.summary.setup.canShowSetup).toBe(false);
    expect(result.firstPage.queryKey).toBe(overviewTransactionQueryKey(query));
  });

  it("projects complete imported accounting on subsequent reads before slicing without reloading unrelated planning services", async () => {
    const { accounting } = fixture(); mocks.accounting.mockResolvedValue(accounting); mocks.snapshot.mockClear();
    vi.useFakeTimers(); vi.setSystemTime(new Date(AT));
    try {
      const settings = { supabase: {} } as StudioSettings;
      const first = await loadOverviewTransactionPage(profile, settings, query, null);
      const second = await loadOverviewTransactionPage(profile, settings, query, first.nextCursor);
      expect(first.total).toBe(42); expect(second.total).toBe(42);
      expect(first.rows).toHaveLength(15); expect(second.rows).toHaveLength(15);
      expect(new Set([...first.rows, ...second.rows].map(row => row.id)).size).toBe(30);
      expect(mocks.accounting).toHaveBeenLastCalledWith(settings.supabase, OWNER);
      expect(mocks.snapshot).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
