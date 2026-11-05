import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StatsPanel } from "@/app/chat/stats-panel";
import { buildChatContext, chatContextSchema } from "@/lib/web/chat-context";
import { loadChatContext, loadSettingsBank, loadSettingsBudgets, loadSettingsGoals } from "@/lib/web/secondary-read-models";
import type { Ledger } from "@/lib/web/ledger";
import { emptyAccountingState } from "@/lib/finance/accounting/types";
import type { StudioSettings } from "@/lib/config";
import { expense, profile } from "./helpers";

const mocks = vi.hoisted(() => ({ snapshot: vi.fn(), accounting: vi.fn(), budgets: vi.fn(), goals: vi.fn(), messages: vi.fn(), metadata: vi.fn() }));
vi.mock("@/lib/web/ledger", () => ({ loadLedgerSnapshot: mocks.snapshot }));
vi.mock("@/lib/finance/accounting/persisted-store", () => ({ loadAccountingReadModel: mocks.accounting }));
vi.mock("@/lib/supabase/finance-store", () => ({ createSupabaseFinanceStore: () => ({ listBudgets: mocks.budgets, listSavingsGoals: mocks.goals }) }));
vi.mock("@/lib/bank/store", async original => ({ ...await original<typeof import("@/lib/bank/store")>(), listAccountingBankMessages: (_settings: unknown, ownerId: string) => mocks.messages(ownerId), createSupabaseBankStore: () => ({ listMessages: mocks.messages }) }));
vi.mock("@/lib/web/ledger-bank-metadata", () => ({ loadLedgerBankMetadata: mocks.metadata }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const OWNER = "42";
const settings = { supabase: {} } as StudioSettings;
const owner = profile(42);
const empty = (): Ledger => ({ today: "2026-11-05", currency: "GHS", rows: [], budgets: [], goals: [], insights: [], owed: [], owe: [], bank: { connected: false, lastUsedAt: null, lastEmptyAt: null, accountNames: [], needsLabel: [], balances: [] } });
beforeEach(() => vi.clearAllMocks());

describe("compact Chat context", () => {
  it("aggregates every current-month report row, preserves adjustments and omits all historical details", () => {
    const ledger = empty();
    ledger.rows = Array.from({ length: 3000 }, (_, index) => ({ id: `fictional-${index}`, date: index < 100 ? "2026-11-03" : "2025-01-01", type: "expense" as const, minor: 100, amount: "1.00", currency: "GHS", category: index % 2 ? "Food" : "Transport", description: "Fictional historical purchase with receipt details", paymentMethod: "Cash" }));
    ledger.rows.push({ id: "fictional-refund", date: "2026-11-03", type: "expense", minor: -1000, amount: "-10.00", currency: "GHS", category: "Food", description: "Fictional refund", paymentMethod: "Cash" });
    ledger.rows.push({ id: "fictional-income", date: "2026-11-04", type: "income", minor: 20000, amount: "200.00", currency: "GHS", category: "Salary", description: "Fictional income", paymentMethod: "Cash" });
    const context = buildChatContext(ledger);
    expect(context.month).toMatchObject({ spentMinor: 9000, incomeMinor: 20000, categories: [{ category: "Transport", minor: 5000 }, { category: "Food", minor: 4000 }] });
    expect(context.month.days.at(-1)?.cumulative).toBe(9000); expect(context.setup.hasTransaction).toBe(true); expect(context.setup.isEmpty).toBe(false);
    expect(chatContextSchema.safeParse(context).success).toBe(true);
    const serialized = JSON.stringify(context);
    for (const excluded of ["fictional-2999", "receipt", "Fictional historical purchase", "paymentMethod", '"rows"']) expect(serialized).not.toContain(excluded);
    expect(Buffer.byteLength(serialized)).toBeLessThan(Buffer.byteLength(JSON.stringify(ledger)) / 20);
  });
  it("keeps all-time activity from looking empty during a quiet month and preserves unknown balances", () => {
    const ledger = empty(); ledger.rows = [{ id: "old", date: "2020-01-01", type: "expense", minor: 100, amount: "1.00", currency: "GHS", category: "Food", description: "Old fixture", paymentMethod: "Cash" }];
    const context = buildChatContext(ledger);
    expect(context.month.spentMinor).toBe(0); expect(context.setup.isEmpty).toBe(false); expect(context.balances.totalMinor).toBeNull();
    const html = renderToStaticMarkup(createElement(StatsPanel, { context }));
    expect(html).not.toContain("Give Alfred a starting point"); expect(html).toContain("Account balances are unavailable.");
  });
  it("sends only three waiting previews while preserving the existing count and Review all link", () => {
    const ledger = empty(); ledger.bank.needsLabel = Array.from({ length: 20 }, (_, index) => ({ id: `held-${index}`, direction: "out" as const, amount: "1.00", currency: "GHS", counterparty: "Sample store", occurredAt: "2026-11-05T12:00:00Z", question: `Sample waiting item ${index}` }));
    const context = buildChatContext(ledger);
    expect(context.bank.needsLabel).toHaveLength(3); expect(context.bank.needsLabelCount).toBe(20);
    const html = renderToStaticMarkup(createElement(StatsPanel, { context }));
    expect(html).toContain("Needs a label (20)"); expect(html).toContain("Review all 20"); expect(html).not.toContain("Sample waiting item 3");
  });
  it("loads a coherent server snapshot without generating unused receipts", async () => {
    mocks.snapshot.mockResolvedValue({ ledger: empty(), accounting: {} });
    await loadChatContext(owner, settings);
    expect(mocks.snapshot).toHaveBeenCalledExactlyOnceWith(owner, settings, { receipts: false });
  });
});

describe("section-specific Settings source reads", () => {
  it("reads goals directly without hydrating accounting or unrelated finance", async () => {
    mocks.goals.mockResolvedValue([{ goalId: "active", name: "Sample goal", targetAmount: "100.00", currentAmount: "10.00", currency: "GHS", targetDate: "", status: "active" }, { goalId: "removed", status: "deleted" }]);
    expect(await loadSettingsGoals(owner, settings)).toMatchObject({ currency: "GHS", goals: [{ goalId: "active", currentAmount: "10.00" }] });
    expect(mocks.goals).toHaveBeenCalledExactlyOnceWith(OWNER);
    for (const unused of [mocks.accounting, mocks.budgets, mocks.messages, mocks.metadata, mocks.snapshot]) expect(unused).not.toHaveBeenCalled();
  });
  it("keeps all budget months and authoritative spending from more than fifteen rows", async () => {
    const transactions = Array.from({ length: 40 }, (_, index) => expense({ transactionId: `fixture-${index}`, transactionDate: index < 20 ? "2026-11-03" : "2026-10-03", amount: "2.00" }));
    mocks.accounting.mockResolvedValue({ availability: "migration-required", rawTransactions: transactions, state: emptyAccountingState(OWNER) });
    mocks.budgets.mockResolvedValue(["2026-10", "2026-11"].map(period => ({ budgetId: `budget-${period}`, userId: OWNER, period, category: "Food", amount: "100.00", currency: "GHS" })));
    const resource = await loadSettingsBudgets(owner, settings);
    expect(resource.budgets.map(item => [item.period, item.spentMinor])).toEqual([["2026-11", 4000], ["2026-10", 4000]]);
    expect(mocks.budgets).toHaveBeenCalledExactlyOnceWith(OWNER); expect(mocks.accounting).toHaveBeenCalledExactlyOnceWith(settings.supabase, OWNER);
    expect(mocks.goals).not.toHaveBeenCalled(); expect(mocks.messages).not.toHaveBeenCalled(); expect(mocks.metadata).not.toHaveBeenCalled();
  });
  it("preserves the existing first-twenty waiting selection and canonical review filter", async () => {
    const state = emptyAccountingState(OWNER);
    state.movements = [{ id: "bank:held-0", status: "review" }, { id: "bank:held-20", status: "review" }] as typeof state.movements;
    mocks.accounting.mockResolvedValue({ state });
    mocks.messages.mockResolvedValue(Array.from({ length: 21 }, (_, index) => ({ id: `held-${index}`, direction: "out", amount: "1.00", currency: "GHS", counterparty: "Sample shop", occurredAt: "2026-11-05T12:00:00Z", raw: "Fictional raw source excluded", kind: "payment" })));
    mocks.metadata.mockResolvedValue(empty().bank);
    const resource = await loadSettingsBank(owner, settings);
    expect(resource.bank.needsLabel.map(item => item.id)).toEqual(["held-0"]);
    expect(JSON.stringify(resource)).not.toContain("Fictional raw source excluded");
    expect(mocks.messages).toHaveBeenCalledExactlyOnceWith(OWNER, "needs_label"); expect(mocks.goals).not.toHaveBeenCalled(); expect(mocks.budgets).not.toHaveBeenCalled();
  });
  it("propagates failed source reads instead of publishing invented empty resources", async () => {
    mocks.goals.mockRejectedValue(new Error("Synthetic source unavailable"));
    await expect(loadSettingsGoals(owner, settings)).rejects.toThrow("unavailable");
  });
});
