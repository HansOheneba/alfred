import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SettingsView } from "@/app/settings/settings-view";
import { DataSection } from "@/app/settings/data-section";
import { AccountRulesSection } from "@/app/settings/account-rules-section";
import { EMPTY_NOTIFICATION_PREFERENCES, NotificationsSection } from "@/app/settings/notifications-section";
import { BankSection } from "@/app/settings/bank-section";
import type { AccountSettings } from "@/lib/accounts/settings-store";
import type { LedgerBank } from "@/lib/web/ledger";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
const initial: AccountSettings = { preferredName: "Fictional", currency: "GHS", timezone: "Africa/Accra", communicationPreference: "concise", financialGoals: "", telegramUserId: "", telegramLocked: false, morningEnabled: false, commuteEnabled: false, eveningEnabled: false, morningTime: "08:00", commuteTime: "09:00", eveningTime: "19:00" };
const bank: LedgerBank = { connected: false, lastUsedAt: null, lastEmptyAt: null, accountNames: [], needsLabel: [], balances: [] };
function button(markup: string, label: string) {
  const match = [...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].find(item => item[1].includes(`aria-label="${label}"`) || item[2].replace(/<[^>]+>/g, "").trim() === label);
  expect(match, `Button ${label}`).toBeDefined();
  return match![1];
}

describe("explicit mobile Settings action sizing", () => {
  it("opts profile saving in while leaving navigation compact", () => {
    const markup = renderToStaticMarkup(createElement(SettingsView, { initial, home: "chat" }));
    expect(button(markup, "Save changes")).toContain("alfred-button--mobileFull");
    expect(button(markup, "Back to settings")).not.toContain("alfred-button--mobileFull");
    expect(button(markup, "Profile")).not.toContain("alfred-button--mobileFull");
  });

  it("gives download/import their own full-width actions without stretching auxiliary account controls", () => {
    const markup = renderToStaticMarkup(createElement(DataSection));
    for (const label of ["Download my data", "Review import"]) expect(button(markup, label)).toContain("alfred-button--mobileFull");
    for (const label of ["Manage password", "Clear history"]) expect(button(markup, label)).not.toContain("alfred-button--mobileFull");
  });

  it("keeps the rule refresh compact and marks rule review as a form action", () => {
    const markup = renderToStaticMarkup(createElement(AccountRulesSection));
    expect(button(markup, "Refresh rules")).not.toContain("alfred-button--mobileFull");
    for (const label of ["Review rule", "Review account link", "Confirm rule"]) expect(button(markup, label)).toContain("alfred-button--mobileFull");
  });

  it("opts notification setup in and leaves its switches compact", () => {
    const markup = renderToStaticMarkup(createElement(NotificationsSection, { preview: true, initial: { ownerId: "synthetic-owner", preferences: EMPTY_NOTIFICATION_PREFERENCES, push: { configured: false, publicKey: null, deliveryEnabled: false, schedulesEnabled: false }, devices: [] } }));
    expect(button(markup, "Enable notifications")).toContain("alfred-button--mobileFull");
    const switches = [...markup.matchAll(/<button\b[^>]*role="switch"[^>]*>/g)];
    expect(switches.length).toBeGreaterThan(0);
    expect(switches.every(item => !item[0].includes("alfred-button--mobileFull"))).toBe(true);
  });

  it("marks forwarding setup and saving without changing connected-key row actions", () => {
    const empty = renderToStaticMarkup(createElement(BankSection, { bank, currency: "GHS" }));
    for (const label of ["Create forwarding key", "Save names"]) expect(button(empty, label)).toContain("alfred-button--mobileFull");
    const connected = renderToStaticMarkup(createElement(BankSection, { bank: { ...bank, connected: true }, currency: "GHS" }));
    for (const label of ["Reset key", "Turn off"]) expect(button(connected, label)).not.toContain("alfred-button--mobileFull");
  });
});
