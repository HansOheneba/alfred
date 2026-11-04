import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DataSection } from "@/app/settings/data-section";
import { SettingsView } from "@/app/settings/settings-view";
import type { AccountSettings } from "@/lib/accounts/settings-store";
import type { Ledger } from "@/lib/web/ledger";

const initial: AccountSettings = { preferredName: "Fictional reviewer", currency: "GHS", timezone: "Africa/Accra", communicationPreference: "concise", financialGoals: "", telegramUserId: "", telegramLocked: false, morningEnabled: false, commuteEnabled: false, eveningEnabled: false, morningTime: "08:00", commuteTime: "09:00", eveningTime: "19:00" };
const ledger: Ledger = { today: "2026-11-02", currency: "GHS", rows: [], budgets: [], goals: [], insights: [], bank: { connected: false, lastUsedAt: null, lastEmptyAt: null, accountNames: [], needsLabel: [], balances: [] }, owed: [], owe: [] };

afterEach(() => vi.unstubAllGlobals());

describe("portability in normal Settings", () => {
  it("keeps Data & privacy discoverable in the actual Settings navigation", () => {
    const fetch = vi.fn(() => { throw new Error("No network is expected during rendering"); });
    vi.stubGlobal("fetch", fetch);
    const markup = renderToStaticMarkup(createElement(SettingsView, { initial, ledger, botUsername: null, home: "chat" }));
    expect(markup).toMatch(/<nav[^>]*aria-label="Settings sections"/);
    const dataButton = /<button\b[^>]*data-section="data"[^>]*>([\s\S]*?)<\/button>/.exec(markup);
    expect(dataButton).not.toBeNull();
    expect(dataButton![0]).toContain('aria-label="Data &amp; privacy"');
    expect(dataButton![1].replace(/<[^>]+>/g, "")).toContain("Data &amp; privacy");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("puts the real finance transfer controls before spreadsheet and password options", () => {
    const fetch = vi.fn(() => { throw new Error("No network is expected during rendering"); });
    vi.stubGlobal("fetch", fetch);
    const markup = renderToStaticMarkup(createElement(DataSection));
    const download = markup.indexOf("Download my data"), review = markup.indexOf("Review import");
    const spreadsheet = markup.indexOf("Download spreadsheet");
    const passwordControl = /<button\b[^>]*type="button"[^>]*>Manage password<\/button>/.exec(markup);
    expect(passwordControl).not.toBeNull();
    const password = passwordControl!.index;
    expect(download).toBeGreaterThan(-1); expect(review).toBeGreaterThan(download);
    expect(spreadsheet).toBeGreaterThan(review); expect(password).toBeGreaterThan(spreadsheet);
    expect(markup).toContain('href="/api/export"');
    expect(fetch).not.toHaveBeenCalled();
  });
});
