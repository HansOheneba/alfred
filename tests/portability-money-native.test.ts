import { describe, expect, it } from "vitest";
import { moneyNativeSupplement } from "@/lib/portability/money-native";
import type { ImportArchive } from "@/lib/portability/model";
import { planNativeRestoration } from "@/lib/portability/native-restoration";
import type { AccountRule } from "@/lib/account-rules/types";
const at = "2026-01-15T10:00:00.000Z";
function archive(): ImportArchive { return { archiveId: "a".repeat(64), manifest: { namespace: "synthetic-money", sourceApp: "money-tracker", exportedAt: at, coverage: [] }, datasets: { "moneyTracker.native": { planning: { plans: { "2026-01": { month: "2026-01", limit: 20000, categoryLimits: { Food: 1250 }, repeat: true }, "2026-02": { month: "2026-02", mode: "income-plan", expectedIncome: 10000, keepAside: 1000, investmentTarget: 2000, focus: "Fictional goal", repeat: false } }, overrides: { source: { note: "Synthetic note", purpose: "Fictional purpose" } }, rules: [{ id: "rule", account: "bank", description: "Example merchant", category: "Food", active: true }], thirdPartyGroups: [{ id: "custody" }], preferences: { paymentPrompts: true } }, bills: { bills: [{ id: "rent", name: "Synthetic rent", nextDate: "2026-02-01", amount: 120000, cadence: "monthly", active: true, confirmedAt: at }], preferences: { reminders: true } } } } }; }
describe("Money Tracker native feature supplement", () => {
  it("maps exact category budgets, bills and notes without inventing financial goals or future rules", () => {
    const result = moneyNativeSupplement(archive())!;
    expect(result.native.tables.budgets).toEqual([{ budget_id: "money-plan:2026-01:Food", period: "2026-01", category: "Food", amount: "12.50", currency: "GHS", created_at: at, updated_at: at }]);
    expect(result.native.tables.bills[0]).toMatchObject({ name: "Synthetic rent", amount: "1200.00", currency: "GHS", cadence: "monthly" });
    expect(result.native.tables.savingsGoals).toBeUndefined(); expect(result.native.tables.payeeRules).toBeUndefined();
    const notes = result.native.tables.aboutMe.map((row) => row.note).join("");
    expect(notes).toContain("expectedIncome"); expect(notes).toContain("Synthetic note"); expect(notes).toContain("Example merchant");
    expect(result.coverage?.find((row) => row.dataset.endsWith("thirdPartyGroups"))?.status).toBe("preserved");
    expect(result.warnings).toContain("Imported Money Tracker bills start paused. Resume them explicitly in Bills when ready.");
  });
  it("retains unrepresentable values in bounded notes and leaves zero-price bills out of active records", () => {
    const input = archive(); const native = input.datasets["moneyTracker.native"] as { planning: { plans: Record<string, { categoryLimits: Record<string, number> }>; overrides: { source: { note: string } } }; bills: { bills: { amount: number }[] } };
    native.planning.plans["2026-01"].categoryLimits.Food = 100_000_000_000;
    native.bills.bills[0].amount = 0; native.planning.overrides.source.note = "x".repeat(700);
    const result = moneyNativeSupplement(input)!;
    expect(result.native.tables.budgets).toHaveLength(0); expect(result.native.tables.bills).toHaveLength(0);
    expect(result.native.tables.aboutMe.every((row) => String(row.note).length <= 300)).toBe(true);
    expect(result.native.tables.aboutMe.map((row) => row.note).join("")).toContain("x".repeat(700));
    expect(result.coverage?.filter((row) => row.dataset.includes("unrepresentable"))).toHaveLength(2);
  });
  it("is deterministic and never changes source input", () => {
    const input = archive(), before = JSON.stringify(input);
    expect(moneyNativeSupplement(input)).toEqual(moneyNativeSupplement(input)); expect(JSON.stringify(input)).toBe(before);
    input.manifest.sourceApp = "alfred"; expect(moneyNativeSupplement(input)).toBeNull();
  });
  it("passes the actual native planner and makes imported bills paused without broadening merchant rules", () => {
    const input = archive(), source = moneyNativeSupplement(input)!;
    const result = planNativeRestoration({ schema: 1, tables: {}, settings: { profile: null, reminderPreferences: null }, retainedArchives: [] }, [source], "synthetic-destination", at);
    expect(result.summary.conflicts).toEqual([]);
    expect(result.plan.tables.budgets).toHaveLength(1); expect(result.plan.tables.bills).toHaveLength(1);
    expect(result.plan.tables.bills[0].active).toBe(false); expect(result.plan.tables.payee_rules).toHaveLength(0);
    expect(result.plan.tables.about_me.length).toBeGreaterThanOrEqual(4);
  });
  it("maps only dated portfolio values and known quantities, preserving unknown basis and positions", () => {
    const input = archive(); input.datasets["moneyTracker.portfolios"] = { portfolios: [{ id: "us", name: "Synthetic portfolio", currency: "USD", market: "US stocks", reportedValue: 125000, marketAsOf: "2026-01-01", holdings: [{ symbol: "ABC", quantity: "2.5", costBasis: 10000 }, { symbol: "UNKNOWN", quantity: null, reportedValue: 9999 }] }, { id: "undated", name: "Undated portfolio", currency: "GHS", reportedValue: 50000, receivedOn: null, marketAsOf: null, holdings: [] }] };
    const source = moneyNativeSupplement(input)!;
    expect(source.native.tables.investments).toHaveLength(2); expect(source.native.tables.investmentValues).toHaveLength(1);
    expect(source.native.tables.investmentValues[0]).toMatchObject({ value: "1250.00", as_of: "2026-01-01T00:00:00.000Z" });
    expect(source.native.tables.investmentHoldings).toHaveLength(1); expect(source.native.tables.investmentHoldings[0]).toMatchObject({ quantity: "2.5", cost: "100.00" });
    expect(source.native.tables.investments.every((row) => row.import_cost_basis_unknown === true)).toBe(true);
    expect(source.coverage?.some((row) => row.dataset.endsWith("undatedValue"))).toBe(true);
    const result = planNativeRestoration({ schema: 1, tables: {}, settings: { profile: null, reminderPreferences: null }, retainedArchives: [] }, [source], "synthetic-destination", at);
    expect(result.summary.conflicts).toEqual([]); expect(result.plan.tables.investments).toHaveLength(2);
  });
  it("activates uniquely mapped exact account rules with original direction/start date/order", () => {
    const input = archive();
    input.datasets.accounts = [{ id: "bank" }];
    const native = input.datasets["moneyTracker.native"] as { planning: { rules: Record<string, unknown>[] }; snapshot?: unknown };
    native.snapshot = { accounts: [{ account: "bank", label: "Fictional bank" }] };
    native.planning.rules = [{ id: "first", account: " BANK ", description: "  Example   Merchant ", category: "Food", active: true, createdAt: at }, { id: "second", account: "bank", description: "Example Merchant", category: "Shopping", direction: "in", active: false, createdAt: at }];
    const result = moneyNativeSupplement(input)!;
    const state = (result.native as unknown as { accountRules: { rules: AccountRule[] } }).accountRules;
    expect(state.rules).toHaveLength(2);
    expect(state.rules[0]).toMatchObject({ accountId: "bank", merchantExact: "example merchant", matchMode: "exact", direction: "out", priority: 1000, effectiveFrom: at });
    expect(state.rules[1]).toMatchObject({ active: false, direction: "in", priority: 999 });
    expect(result.native.tables.payeeRules).toBeUndefined();
    expect(result.coverage?.find((row) => row.dataset === "moneyTracker.native.planning.rules")?.status).toBe("supported");
  });
  it("preserves ambiguous or missing account rule mappings without broadening to provider activity", () => {
    const input = archive(); input.datasets.accounts = [{ id: "bank" }, { id: "BANK" }];
    const native = input.datasets["moneyTracker.native"] as { planning: { rules: Record<string, unknown>[] }; snapshot?: unknown };
    native.snapshot = { accounts: [{ account: "bank" }, { account: "BANK" }] };
    native.planning.rules = [{ id: "rule", account: "bank", description: "merchant", category: "Food", active: true, createdAt: at }];
    const result = moneyNativeSupplement(input)!;
    expect((result.native as unknown as { accountRules: { rules: unknown[] } }).accountRules.rules).toHaveLength(0);
    expect(result.coverage?.find((row) => row.dataset.includes("awaitingAccountMapping"))?.count).toBe(1);
    expect(result.native.tables.aboutMe.map((row) => row.note).join("")).toContain("merchant");
  });
});
