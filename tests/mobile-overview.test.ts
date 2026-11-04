import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { DashboardAccountBalance } from "@/app/dashboard/account-balance";
import { DashboardClient } from "@/app/dashboard/dashboard-client";
import { buildAccountingView } from "@/lib/finance/accounting/view";
import { emptyAccountingState } from "@/lib/finance/accounting/types";
import { RANGE_LABELS } from "@/lib/finance/analytics";
import { formatMinor } from "@/lib/finance/money";
import type { Ledger } from "@/lib/web/ledger";
import { previewLedger } from "@/ui-preview/fixture";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

function balances(count: number, missing = false): NonNullable<Ledger["accounting"]> {
  const state = emptyAccountingState("synthetic-mobile-reviewer");
  for (let index = 0; index < count; index++) {
    const id = `fictional-account-${index}`;
    state.accounts.push({ id, label: `Fictional account ${index + 1}`, provider: "Sample cash", currency: "GHS", includeInCash: true, createdAt: "2026-11-01T10:00:00Z" });
    if (!missing) state.snapshots.push({ id: `fictional-snapshot-${index}`, accountId: id, balanceMinor: 10000, occurredAt: "2026-11-01T10:00:00Z", sourceId: `fictional-statement-${index}`, sourceMovementId: null });
  }
  state.accounts.push({ id: "fictional-excluded", label: "Excluded account", provider: "Sample cash", currency: "GHS", includeInCash: false, createdAt: "2026-11-01T10:00:00Z" });
  state.snapshots.push({ id: "fictional-excluded-balance", accountId: "fictional-excluded", balanceMinor: 99999999, occurredAt: "2026-11-01T10:00:00Z", sourceId: "fictional-excluded-statement", sourceMovementId: null });
  return { availability: "ready", revision: 0, balances: buildAccountingView(state, "GHS").balances, loans: [], issues: [] };
}

describe("responsive overview controls", () => {
  it("keeps a large account total correct with a closed, labelled native disclosure", () => {
    const accounting = balances(100);
    const html = renderToStaticMarkup(createElement(DashboardAccountBalance, { accounting, currency: "GHS" }));
    expect(html).toContain(formatMinor(1000000, "GHS"));
    expect(html).toContain("100 included accounts");
    expect(html).toMatch(/<details class="alfred-ui-balanceAccounts">/);
    expect(html).not.toMatch(/<details[^>]*\bopen(?:=|\s|>)/);
    expect(html).toMatch(/<summary[^>]*>[\s\S]*100 included accounts[\s\S]*<\/summary>/);
    expect(html.match(/<summary[^>]*>[\s\S]*?<\/summary>/)?.[0]).toContain("Show accounts");
    expect(html.match(/<summary[^>]*>[\s\S]*?<\/summary>/)?.[0]).toContain("Hide accounts");
    expect(html.match(/<summary[^>]*>[\s\S]*?<\/summary>/)?.[0]).not.toContain(">GHS<");
    expect(html).toContain('aria-label="Accounts contributing to total"');
    expect(html).toContain("Fictional account 100");
    expect(html).not.toContain("Excluded account");
    expect(html).toContain('class="alfred-ui-totalValue tabular-nums"');
  });

  it("explains a missing reported balance outside the collapsed details", () => {
    const html = renderToStaticMarkup(createElement(DashboardAccountBalance, { accounting: balances(1, true), currency: "GHS" }));
    const summary = html.slice(0, html.indexOf("<details"));
    expect(summary).toContain("1 included account needs a reported balance");
    expect(summary).toContain("—");
    expect(summary).not.toContain(formatMinor(0, "GHS"));
  });

  it("omits the separate provider-balance disclosure while retaining the included account total", () => {
    const ledger: Ledger = { ...previewLedger, accounting: balances(2), bank: { ...previewLedger.bank, balances: [{ source: "gcb", label: "Fictional provider-only balance", balance: "999999.99", at: "2026-11-01T10:00:00Z" }] } };
    const html = renderToStaticMarkup(createElement(DashboardClient, { ledger, name: "Sample reviewer" }));
    expect(html).not.toContain("Latest balances from bank messages");
    expect(html).not.toContain("Provider reports are shown separately");
    expect(html).not.toContain("Fictional provider-only balance");
    const accountTotal = html.match(/<section[^>]*aria-label="Total account balance"[\s\S]*?<\/section>/)?.[0];
    expect(accountTotal).toContain(formatMinor(20000, "GHS"));
    expect(accountTotal).toContain("2 included accounts");
    expect(accountTotal).not.toContain(formatMinor(99999999, "GHS"));
    expect(ledger.bank.balances[0].balance).toBe("999999.99");
  });

  it("offers one compact period picker across screen sizes, every dialog choice, and both chart views", () => {
    const html = renderToStaticMarkup(createElement(DashboardClient, { ledger: previewLedger, name: "Sample reviewer" }));
    const trigger = html.match(/<button[^>]*aria-label="Date range: This month"[^>]*>/)?.[0];
    expect(trigger).toContain('aria-haspopup="dialog"');
    expect(trigger).toContain('aria-expanded="false"');
    expect([...html.matchAll(/aria-label="Date range: /g)]).toHaveLength(1);
    expect(html).not.toContain('class="alfred-ui-ranges"');
    expect(html).not.toContain('role="group" aria-label="Date range"');
    expect(html).toContain("Choose a period");
    expect(html).toContain('role="radiogroup" aria-label="Date range"');
    for (const label of Object.values(RANGE_LABELS)) expect(html).toContain(label);
    const choices = [...html.matchAll(/<input[^>]*type="radio"[^>]*>/g)].map(([input]) => input);
    expect(choices).toHaveLength(Object.keys(RANGE_LABELS).length);
    expect(choices.find(input => input.includes('value="this_month"'))).toContain('checked=""');
    expect(choices.filter(input => input.includes('checked=""'))).toHaveLength(1);
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>Daily<\/button>/);
    expect(html).toMatch(/<button[^>]*aria-pressed="false"[^>]*>Running total<\/button>/);
    expect(html).not.toMatch(/<select[^>]*aria-label="(?:Chart mode|Date range)"/);
    expect(html).not.toContain("Talk to Alfred");
  });

  it("labels spent and income with the selected month while retaining month totals rather than today totals", () => {
    const rows: Ledger["rows"] = [
      { id: "fictional-earlier-expense", date: "2026-10-02", type: "expense", amount: "30.00", minor: 3000, currency: "GHS", category: "Food", description: "Sample groceries", paymentMethod: "Sample cash" },
      { id: "fictional-today-expense", date: "2026-10-24", type: "expense", amount: "12.00", minor: 1200, currency: "GHS", category: "Food", description: "Sample lunch", paymentMethod: "Sample cash" },
      { id: "fictional-earlier-income", date: "2026-10-15", type: "income", amount: "200.00", minor: 20000, currency: "GHS", category: "Salary", description: "Sample work", paymentMethod: "Sample cash" },
    ];
    const html = renderToStaticMarkup(createElement(DashboardClient, { ledger: { ...previewLedger, today: "2026-10-24", rows }, name: "Sample reviewer" }));
    const expense = html.match(/<article[^>]*data-kind="expense"[\s\S]*?<\/article>/)?.[0];
    const income = html.match(/<article[^>]*data-kind="income"[\s\S]*?<\/article>/)?.[0];
    expect(expense).toContain(formatMinor(4200, "GHS"));
    expect(income).toContain(formatMinor(20000, "GHS"));
    for (const metric of [expense, income]) {
      expect(metric).toContain("This month · ");
      expect(metric).not.toContain(">Today<");
    }
  });
});
