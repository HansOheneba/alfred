import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DashboardClient } from "@/app/dashboard/dashboard-client";
import { buildAccountingView } from "@/lib/finance/accounting/view";
import { emptyAccountingState } from "@/lib/finance/accounting/types";
import type { Ledger } from "@/lib/web/ledger";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const unavailableCopy = "Account setup is temporarily unavailable. Start with a transaction or a budget.";
const transactionHref = "/chat?question=" + encodeURIComponent("Help me record my first transaction.");
const network = vi.fn(() => { throw new Error("Dashboard markup must not request network data"); });

beforeEach(() => { network.mockClear(); vi.stubGlobal("fetch", network); });
afterEach(() => { expect(network).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

function freshLedger(availability: "ready" | "migration-required" = "ready"): Ledger {
  const view = buildAccountingView(emptyAccountingState("synthetic-ui-reviewer"), "GHS");
  return {
    today: "2026-11-02", currency: "GHS", rows: [], budgets: [], goals: [], insights: [], owed: [], owe: [], bills: [], upcomingBills: [], renewalSuggestions: [],
    bank: { connected: false, lastUsedAt: null, lastEmptyAt: null, accountNames: [], needsLabel: [], balances: [] },
    accounting: { availability, revision: 0, balances: view.balances, loans: [], issues: [] },
  };
}

function savedAccount(ledger: Ledger, balanceMinor?: number) {
  const state = emptyAccountingState("synthetic-ui-reviewer");
  state.accounts.push({ id: "synthetic-cash", label: "Fictional cash", provider: "Cash", currency: "GHS", includeInCash: true, createdAt: "2026-11-02T10:00:00Z" });
  if (balanceMinor !== undefined) state.snapshots.push({ id: "synthetic-balance", accountId: "synthetic-cash", balanceMinor, occurredAt: "2026-11-02T10:00:00Z", sourceId: "synthetic-opening-balance", sourceMovementId: null });
  ledger.accounting!.balances = buildAccountingView(state, ledger.currency).balances;
}

function savedBudget(ledger: Ledger) {
  ledger.budgets.push({ budgetId: "synthetic-food", period: "2026-11", category: "Food", amount: "100.00", currency: "GHS", budgetMinor: 10000, spentMinor: 0, remainingMinor: 10000 });
}

const render = (ledger: Ledger) => renderToStaticMarkup(createElement(DashboardClient, { ledger, name: "Fictional reviewer", timeZone: "Africa/Accra" }));
function anchor(markup: string, text: string): string {
  const match = [...markup.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].find((item) => item[2].includes(text));
  expect(match, `Expected a link labelled ${text}`).toBeDefined();
  return match![1];
}

describe("first-use dashboard markup", () => {
  it("offers usable transaction and budget actions while empty account storage is blocked", () => {
    const markup = render(freshLedger("migration-required"));
    expect(markup).toContain("<h1>Get Started</h1>");
    expect(markup).toContain(unavailableCopy);
    expect(markup).toContain('id="account-setup-unavailable"');
    const accountButton = [...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].find((item) => item[2].includes("Add account"));
    expect(accountButton).toBeDefined();
    expect(accountButton![1]).toContain('type="button"'); expect(accountButton![1]).toContain("disabled");
    expect(accountButton![1]).toContain('aria-describedby="account-setup-unavailable"'); expect(accountButton![1]).not.toContain("href=");
    expect(markup).not.toContain('href="/accounts');
    expect(anchor(markup, "Record a transaction")).toContain(`href="${transactionHref}"`);
    expect(anchor(markup, "Record a transaction")).toContain("alfred-button--primary");
    expect(anchor(markup, "Set a budget")).toContain('href="/settings#budgets"');
    expect(anchor(markup, "Set a budget")).not.toContain("disabled");
    expect(markup).not.toContain("Total account balance"); expect(markup).not.toContain("GH₵0.00");
    expect(markup).not.toContain("Add an account and its balance when you’re ready.");
  });

  it("keeps the ready first-account action primary with a genuine account-editor link", () => {
    const markup = render(freshLedger());
    expect(markup).toContain("<h1>Get Started</h1>");
    expect(anchor(markup, "Add account")).toContain('href="/accounts?add=1"');
    expect(anchor(markup, "Add account")).toContain("alfred-button--primary");
    expect(anchor(markup, "Record a transaction")).toContain("alfred-button--secondary");
    expect(markup).toContain('aria-valuenow="0"');
    expect(markup).not.toContain(unavailableCopy); expect(markup).not.toContain("account-setup-unavailable");
    expect(markup).not.toContain("Total account balance"); expect(markup).not.toContain("GH₵0.00");
  });

  it.each([undefined, 12345])("keeps partial ready progress and uses only recorded balances (%s minor)", (balanceMinor) => {
    const ledger = freshLedger(); savedAccount(ledger, balanceMinor); savedBudget(ledger);
    const markup = render(ledger);
    expect(markup).toContain("<h1>Get Started</h1>"); expect(markup).toContain('aria-valuenow="2"');
    expect(anchor(markup, "View accounts")).toContain('href="/accounts"');
    expect(anchor(markup, "View budgets")).toContain('href="/settings#budgets"');
    expect(anchor(markup, "Record a transaction")).toContain("alfred-button--primary");
    expect(markup).toContain("Total account balance"); expect(markup).toContain("Fictional cash");
    if (balanceMinor === undefined) expect(markup).toContain("Reported balance needed");
    else expect(markup).toContain("GH₵123.45");
    expect(markup).not.toContain("GH₵0.00"); expect(markup).not.toContain(unavailableCopy);
  });

  it.each([
    ["a quiet month", (ledger: Ledger) => { ledger.rows.push({ id: "synthetic-old", date: "2025-01-01", type: "expense", minor: 100, amount: "1.00", currency: "GHS", category: "Food", description: "Fictional earlier expense", paymentMethod: "Cash" }); }],
    ["another currency", (ledger: Ledger) => { ledger.rows.push({ id: "synthetic-usd", date: "2025-01-01", type: "expense", minor: 100, amount: "1.00", currency: "USD", category: "Food", description: "Fictional dollar expense", paymentMethod: "Cash" }); }],
    ["a saved account", (ledger: Ledger) => savedAccount(ledger)],
    ["a saved budget", (ledger: Ledger) => savedBudget(ledger)],
    ["an unclassified bank payment", (ledger: Ledger) => { ledger.bank.needsLabel.push({ id: "synthetic-pending", direction: "out", amount: "20.00", currency: "GHS", counterparty: "Fictional shop", occurredAt: "2026-11-02T10:00:00Z", question: "Choose a category" }); }],
  ] as const)("keeps the overview and unavailable-storage message for %s", (_label, populate) => {
    const ledger = freshLedger("migration-required"); populate(ledger);
    const markup = render(ledger);
    expect(markup).not.toContain("<h1>Get Started</h1>"); expect(markup).not.toContain(unavailableCopy);
    expect(markup).toContain("Fictional reviewer&#x27;s finances");
    expect(markup).toContain("Account storage must be set up before saving accounts.");
    expect(markup).toContain("Total account balance");
  });

  it("keeps unknown accounting availability distinct from known empty blocked storage", () => {
    const ledger = freshLedger(); ledger.accounting = undefined;
    const markup = render(ledger);
    expect(markup).not.toContain("<h1>Get Started</h1>"); expect(markup).not.toContain(unavailableCopy);
    expect(markup).toContain("Account balances are unavailable."); expect(markup).toContain("Fictional reviewer&#x27;s finances");
  });
});
