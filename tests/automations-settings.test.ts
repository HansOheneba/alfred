import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomationsSection } from "@/app/settings/automations-section";
import { SettingsView } from "@/app/settings/settings-view";
import { AutomationsSettingsPreview } from "@/app/preview/automations/preview";
import { EMPTY_NOTIFICATION_PREFERENCES, type NotificationSettingsData } from "@/app/settings/notifications-section";
import type { AccountSettings } from "@/lib/accounts/settings-store";

const sample: NotificationSettingsData = { ownerId: "00000000-0000-4000-8000-000000000001", preferences: { ...EMPTY_NOTIFICATION_PREFERENCES }, push: { configured: false, publicKey: null, deliveryEnabled: false, schedulesEnabled: false }, devices: [] };
afterEach(() => vi.unstubAllGlobals());

describe("Automations settings placement", () => {
  it("groups SMS capture and inactive notification choices without starting anything", () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const html = renderToStaticMarkup(createElement(AutomationsSection, { preview: true, initialNotifications: sample }));
    expect(html).toContain(">Automations</h2>");
    expect(html).toContain("Automatic sync");
    expect(html).toContain("Alfred in chat");
    expect(html).toContain("Device notifications");
    expect(html).toContain('href="#automations-notifications"');
    expect(html.match(/aria-checked="false"/g)).toHaveLength(7);
    expect(html).toContain("Manage sync");
    expect(html).not.toContain("Scheduled push recovery");
    expect(html).not.toContain("Create forwarding key");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("renders loading rather than claiming saved settings before an account read", () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const html = renderToStaticMarkup(createElement(AutomationsSection, { ownerId: sample.ownerId }));
    expect(html).toContain("Loading your choices…");
    expect(html).toContain("Checking this device…");
    expect(html).toContain('href="/settings#bank"');
    expect(html).not.toContain('aria-checked="true"');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("uses the same navigation in actual Settings and the safe local placement preview", () => {
    const initial: AccountSettings = { preferredName: "Fictional", currency: "GHS", timezone: "Africa/Accra", communicationPreference: "concise", financialGoals: "", telegramUserId: "", telegramLocked: false, morningEnabled: false, commuteEnabled: false, eveningEnabled: false, morningTime: "08:00", commuteTime: "09:00", eveningTime: "19:00" };
    const actual = renderToStaticMarkup(createElement(SettingsView, { initial, home: "chat" }));
    const preview = renderToStaticMarkup(createElement(AutomationsSettingsPreview));
    for (const html of [actual, preview]) {
      expect(html).toContain('data-section="automations"');
      expect(html).toContain('data-section="reminders"');
      expect(html).toContain('data-section="bank"');
      expect(html).toContain('data-section="data"');
      expect(html).not.toContain('data-section="notifications"');
    }
    expect(preview).toContain("fictional choices only");
    expect(preview).toContain("no account changes");
  });
});
