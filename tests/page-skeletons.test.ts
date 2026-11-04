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

  it.each(["Budgets", "Savings goals", "Telegram", "Bank messages"])("announces deferred %s loading without implying an error or empty state", title => {
    const markup = renderToStaticMarkup(createElement(SettingsSectionSkeleton, { title }));
    expect(markup).toContain(`Loading ${title.toLowerCase()}`);
    expect(markup).toContain(`>${title}</h2>`);
    expect(markup).not.toContain('role="alert"');
    expect(markup).not.toContain("Try again");
  });
});
