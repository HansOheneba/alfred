import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AccountsSkeleton, DashboardSkeleton, InvestmentsSkeleton, SettingsSectionSkeleton, SettingsSkeleton } from "@/app/components/page-skeletons";

describe("financial page loading states", () => {
  it.each([
    ["overview", DashboardSkeleton],
    ["accounts", AccountsSkeleton],
    ["settings", SettingsSkeleton],
    ["investments", InvestmentsSkeleton],
  ] as const)("keeps %s loading distinct from saved financial data or an actionable form", (_name, Component) => {
    const markup = renderToStaticMarkup(createElement(Component));
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toMatch(/<(?:button|input|select|textarea|a)\b/);
    expect(markup).not.toMatch(/GH[₵¢]|GHS|\$\d|No (?:accounts|investments|transactions)|all caught up/i);
  });

  it("follows collapsed accounts and activity instead of the removed account-card grid", () => {
    const markup = renderToStaticMarkup(createElement(AccountsSkeleton));
    expect(markup).toContain("alfred-loading-balance");
    expect(markup).toContain("alfred-loading-scopes");
    expect(markup).toContain("alfred-loading-activity");
    expect(markup).not.toContain("alfred-accounts-summary");
    expect(markup).not.toContain("alfred-accounts-loadingTabs");
    expect(markup).not.toContain("alfred-account-card");
  });

  it("follows Overview's daily activity and plans before the collapsed Insights section", () => {
    const markup = renderToStaticMarkup(createElement(DashboardSkeleton));
    expect(markup.indexOf("alfred-loading-overviewTransactions")).toBeGreaterThan(markup.indexOf("alfred-loading-weekly"));
    expect(markup.indexOf("alfred-loading-overviewPlans")).toBeGreaterThan(markup.indexOf("alfred-loading-overviewTransactions"));
    expect(markup.indexOf("alfred-loading-overviewInsights")).toBeGreaterThan(markup.indexOf("alfred-loading-overviewPlans"));
    expect(markup).not.toContain("alfred-loading-charts");
  });

  it.each(["Budgets", "Savings goals", "Telegram", "Bank messages"])("announces deferred %s loading without implying an error or empty state", title => {
    const markup = renderToStaticMarkup(createElement(SettingsSectionSkeleton, { title }));
    expect(markup).toContain(`Loading ${title.toLowerCase()}`);
    expect(markup).toContain(`>${title}</h2>`);
    expect(markup).not.toContain('role="alert"');
    expect(markup).not.toContain("Try again");
  });
});
