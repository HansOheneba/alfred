import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DatasetCoverageList, NativeFeatureSummary, datasetLabel, nativeSummaryBlocksImport, type NativeImportSummary } from "@/app/settings/native-import-summary";
import { syntheticArchive } from "./fixtures/portability/finance-archive";
import { readArchive } from "@/portability/archive.mjs";
import { planNativeRestoration } from "@/lib/portability/native-restoration";
import type { AlfredNativeExport } from "@/lib/portability/export";
import { BrowserPreferenceReceiptView, BrowserPreferenceReview } from "@/app/settings/browser-preference-summary";
import { DEFAULT_BROWSER_PREFERENCES, planBrowserPreferences } from "@/lib/portability/browser-preferences";
import { InvestmentsClient } from "@/app/investments/investments-client";
import { valuePortfolio } from "@/lib/investments/value";
import type { Investment } from "@/lib/investments/store";
import { includedAccountCash } from "@/lib/finance/accounting/cash-summary";

function summary(): NativeImportSummary {
  return {
    counts: { bills: 3, savings_goals: 2, investment_holdings: 4 },
    additions: { bills: 1, savings_goals: 2, investment_holdings: 3 },
    duplicates: 3,
    duplicateCounts: { bills: 2, savings_goals: 0, investment_holdings: 1 },
    conflicts: [],
    coverage: [{ dataset: "alfred.native.bills", status: "supported", count: 3, reason: "Restored paused; resume in Bills." }],
    settings: { applied: ["profile.timezone"], preserved: ["profile.account_names: does not change future SMS collection."], conflicts: [] },
  };
}

describe("native finance import review", () => {
  it("attributes incoming records, additions and skips to their feature and separates settings", () => {
    const markup = renderToStaticMarkup(createElement(NativeFeatureSummary, { summary: summary() }));
    const billRow = markup.match(/<tr><th[^>]*>Bills and renewals<\/th>(.*?)<\/tr>/)?.[1];
    expect(billRow).toBeDefined();
    const values = [...billRow!.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((match) => match[1]);
    expect(values).toEqual(["3", "1", "2"]);
    expect(markup).toContain("Savings goals");
    expect(markup).toContain("Investment holdings");
    expect(markup).toContain("Preferences");
    expect(markup).toContain("Update default preferences");
    expect(markup).toContain("Timezone");
    expect(markup).toContain("Bank message matching stays unchanged");
  });

  it("blocks feature or settings conflicts even when the other conflict list is empty", () => {
    expect(nativeSummaryBlocksImport()).toBe(false);
    expect(nativeSummaryBlocksImport(summary())).toBe(false);
    const featureConflict = summary(); featureConflict.conflicts = ["Bills: name already exists with different amounts."];
    expect(nativeSummaryBlocksImport(featureConflict)).toBe(true);
    const settingsConflict = summary(); settingsConflict.settings.conflicts = ["profile.timezone: a non-default setting differs."];
    expect(nativeSummaryBlocksImport(settingsConflict)).toBe(true);
    const markup = renderToStaticMarkup(createElement(NativeFeatureSummary, { summary: settingsConflict }));
    expect(markup).toContain("Preferences need review");
    expect(markup).toContain("Timezone needs review.");
  });

  it("labels preserved and unknown domains without presenting them as restored features", () => {
    const markup = renderToStaticMarkup(createElement(DatasetCoverageList, { coverage: [
      { dataset: "alfred.native.aboutMe.account-exclusions", status: "preserved", reason: "Source control is evidence only." },
      { dataset: "new-app.futureDomain", status: "unavailable", reason: "A future adapter is required." },
    ] }));
    expect(markup).toContain("Bank message filters · Saved for later");
    expect(markup).toContain("Other saved data · Unavailable");
    expect(markup).not.toContain("Ready to add");
    expect(markup).not.toContain("new-app.futureDomain");
    expect(markup).not.toContain("alfred.native");
    expect(datasetLabel("profile.currency")).toBe("Main currency");
  });

  it("generates a native UI fixture accepted by the real archive and native feature planners", async () => {
    const archive = await readArchive(await syntheticArchive("alfred"));
    const current = {
      schema: 1, tables: {}, retainedArchives: [],
      settings: {
        profile: { preferred_name: "", currency: "GHS", timezone: "Africa/Accra", communication_preference: "concise", financial_goals: "", account_names: "", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" },
        reminderPreferences: { morning_enabled: false, morning_minute: 480, commute_enabled: false, commute_minute: 510, evening_enabled: false, evening_minute: 1200 },
      },
    } as AlfredNativeExport;
    const planned = planNativeRestoration(current, [{ namespace: archive.manifest.namespace, native: archive.datasets["alfred.native"] as never }], "synthetic-destination", "2026-11-02T00:00:00.000Z");
    expect(planned.summary.conflicts).toEqual([]);
    expect(planned.summary.additions).toMatchObject({ bills: 1, budgets: 1, savings_goals: 1, about_me: 1, investments: 1, investment_holdings: 1, investment_values: 1, investment_contributions: 1, loans: 1, messages: 1 });
    expect(planned.plan.tables.bills[0].active).toBe(false);
    expect(planned.plan.tables.investments[0].import_notifications_paused).toBe(true);
    expect(planned.plan.reminderChanges).not.toHaveProperty("morning_enabled");
  });
});

describe("imported device preferences and investment presentation", () => {
  it("shows exact preference changes and preserves the finance receipt warning on partial application", () => {
    const plan = planBrowserPreferences(DEFAULT_BROWSER_PREFERENCES, { schema: 1, appearance: "dark", privacy: "masked", home: "overview" });
    const preview = renderToStaticMarkup(createElement(BrowserPreferenceReview, { plan }));
    expect(preview).toContain("Light → Dark");
    expect(preview).toContain("Show amounts → Hide amounts");
    expect(preview).toContain("Chat → Overview");
    const partial = renderToStaticMarkup(createElement(BrowserPreferenceReceiptView, { receipt: { status: "partial", changes: plan.changes, warnings: ["Device storage was unavailable."], undoBlocked: true } }));
    expect(partial).toContain("Your finance records were imported");
    expect(partial).toContain("Some device preferences still need attention");
    expect(partial).toContain("Undo is unavailable while device settings need attention");
    expect(partial).toContain("Device storage was unavailable");
    const preserved = renderToStaticMarkup(createElement(BrowserPreferenceReview, { plan: { ...plan, status: "preserved", changes: [], conflicts: [] } }));
    expect(preserved).toContain("Your finance records can still be imported");
    expect(preserved).toContain("No device preference changes will be applied");
    expect(preserved).not.toContain("can replace default preferences");
  });
  it("keeps empty and preserved-only feature tables out of the import review", () => {
    const empty = { counts: { about_me: 2 }, additions: { about_me: 0 }, duplicates: 0, duplicateCounts: { about_me: 0 }, conflicts: [], coverage: [{ dataset: "alfred.native.aboutMe", status: "preserved" as const, reason: "Original notes stay saved." }], settings: { applied: [], preserved: [], conflicts: [] } };
    expect(renderToStaticMarkup(createElement(NativeFeatureSummary, { summary: empty }))).toBe("");
    expect(datasetLabel("moneyTracker.native.planning.preferences")).toBe("Planning preferences");
    expect(datasetLabel("future-app.opaque.internalKey")).toBe("Other saved data");
  });
  it("keeps technical backend paths, IDs and browser mechanics out of visible preferences", () => {
    const data = summary(); data.conflicts = ["alfred.native.bills: record 00000000-0000-4000-8000-000000000123 differs from an existing destination record."];
    const markup = renderToStaticMarkup(createElement(NativeFeatureSummary, { summary: data }));
    const browser = renderToStaticMarkup(createElement(BrowserPreferenceReceiptView, { receipt: { status: "partial", changes: [], warnings: ["localStorage cookie device journal could not be saved safely."], undoBlocked: true } }));
    for (const technical of ["alfred.native", "profile.account_names", "profile.timezone", "00000000-0000", "localStorage", "cookie", "journal", "JSON", "schema"]) expect(markup + browser).not.toContain(technical);
    expect(browser).toContain("Your later changes are kept");
  });

  it("keeps reported investment value visible without inventing a cost basis or gain", () => {
    const investment: Investment = { id: "00000000-0000-4000-8000-000000000001", ownerId: "synthetic", name: "Fictional imported fund", kind: "mutual_fund", provider: "Synthetic", currency: "GHS", investedBefore: "0.00", importCostBasisUnknown: true, importNotificationsPaused: true, principal: null, rate: null, startedOn: null, maturesOn: null, remindedAt: null, payeeKey: null, status: "active" };
    const portfolio = valuePortfolio({ investments: [investment], holdings: [], contributions: [], prices: [], today: "2026-11-02", values: [{ investmentId: investment.id, value: "1120.00", asOf: "2026-11-01T00:00:00.000Z", source: "reported" }] });
    expect(portfolio.investedGhs).toBeNull();
    expect(portfolio.gainGhs).toBeNull();
    const markup = renderToStaticMarkup(createElement(InvestmentsClient, { initial: { portfolio, cash: includedAccountCash(null, "GHS"), contributions: [] } }));
    expect(markup).toContain("1,120");
    expect(markup).toContain("Unknown cost basis");
    expect(markup).toContain("Their cost basis and gains stay unknown");
    expect(markup).toContain("Notices paused after import");
    expect(markup).toContain("Review import receipt");
    expect(markup).not.toContain("NaN");
    expect(markup).not.toContain("Infinity");
  });
});
