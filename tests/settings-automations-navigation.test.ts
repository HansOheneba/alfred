import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SETTINGS_GROUPS, SETTINGS_SECTIONS, SettingsNavigation, resolveSettingsSection, settingsNavigationStatuses } from "@/app/settings/settings-navigation";

describe("Automations in Settings navigation", () => {
  it("keeps unrelated sections in their existing order with Automations after Reminders", () => {
    expect(SETTINGS_SECTIONS.map((item) => item.label)).toEqual([
      "Profile", "Alfred's replies", "Budgets", "Savings goals", "Reminders", "Automations",
      "Telegram", "Bank messages", "Categorisation rules", "App & look", "Data & privacy",
    ]);
    expect(SETTINGS_SECTIONS.filter((item) => item.id === "automations")).toHaveLength(1);
  });

  it.each(SETTINGS_SECTIONS)("opens the existing #$id destination", ({ id }) => {
    expect(resolveSettingsSection(`#${id}`)).toBe(id);
    expect(resolveSettingsSection(id)).toBe(id);
  });

  it("keeps previous notification deep links pointing to Automations", () => {
    expect(resolveSettingsSection("#notifications")).toBe("automations");
    expect(resolveSettingsSection("notifications")).toBe("automations");
    expect(resolveSettingsSection("#automations-notifications")).toBe("automations");
  });

  it.each(["", "#", "#unknown", "#Automations", "#notifications/other", "https://example.invalid/#automations"])("does not select a section for %s", (hash) => {
    expect(resolveSettingsSection(hash)).toBeNull();
  });

  it.each(["automations", "bank", "profile"] as const)("marks only %s active without creating a duplicate notification entry", (section) => {
    const choose = vi.fn();
    const html = renderToStaticMarkup(createElement(SettingsNavigation, { section, onChoose: choose }));
    expect(html).toContain('aria-label="Settings sections"');
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toContain(`data-section="${section}" aria-current="page"`);
    expect(html).not.toContain('data-section="notifications"');
    expect(html).toContain('data-section="bank"');
    expect(html).toContain('data-section="automations"');
    expect(html.match(/type="button"/g)).toHaveLength(SETTINGS_SECTIONS.length);
    expect(html.match(/aria-controls="alfred-settings-detail"/g)).toHaveLength(SETTINGS_SECTIONS.length);
    expect(choose).not.toHaveBeenCalled();
  });

  it("gives every existing destination a decorative icon while preserving its accessible label", () => {
    const html = renderToStaticMarkup(createElement(SettingsNavigation, { section: "profile", onChoose: vi.fn() }));
    const icons: string[] = [];
    for (const section of SETTINGS_SECTIONS) {
      const button = new RegExp(`<button\\b[^>]*data-section="${section.id}"[^>]*>([\\s\\S]*?)<\\/button>`).exec(html);
      expect(button).not.toBeNull();
      expect(button![0]).toContain(`aria-label="${section.label.replaceAll("&", "&amp;").replaceAll("'", "&#x27;")}"`);
      expect(button![1]).toMatch(/<span class="alfred-settings-navigationIcon" aria-hidden="true">/);
      expect(button![1]).toMatch(/class="alfred-settings-navigationDescription"[^>]*>[^<]+<\/span>/);
      const icon = /<svg class="alfred-settings-navigationSymbol"[^>]*focusable="false"[^>]*>([\s\S]*?)<\/svg>/.exec(button![1]);
      expect(icon).not.toBeNull();
      expect(icon![1]).toMatch(/<(?:path|circle|rect)\b/);
      icons.push(icon![1]);
    }
    expect(new Set(icons).size).toBe(SETTINGS_SECTIONS.length);
  });
});

describe("grouped Settings destinations", () => {
  it("keeps every existing destination exactly once in four named groups", () => {
    expect(SETTINGS_GROUPS.map(group => group.label)).toEqual(["Personal", "Money", "Connections", "Data"]);
    const destinations = SETTINGS_GROUPS.flatMap(group => [...group.sections]);
    expect(new Set(destinations).size).toBe(SETTINGS_SECTIONS.length);
    expect([...destinations].sort()).toEqual(SETTINGS_SECTIONS.map(section => section.id).sort());
    const html = renderToStaticMarkup(createElement(SettingsNavigation, { section: "data", onChoose: vi.fn() }));
    for (const group of SETTINGS_GROUPS) {
      expect(html).toContain(`role="group" aria-labelledby="alfred-settings-group-${group.id}"`);
      expect(html).toContain(`id="alfred-settings-group-${group.id}"`);
    }
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html.match(/aria-controls="alfred-settings-detail"/g)).toHaveLength(11);
  });

  it("exposes saved connection facts as descriptions while retaining short button names", () => {
    const html = renderToStaticMarkup(createElement(SettingsNavigation, { section: "telegram", onChoose: vi.fn(), statuses: { telegram: { text: "Connected", tone: "positive" } } }));
    const telegram = /<button\b[^>]*data-section="telegram"[^>]*>[\s\S]*?<\/button>/.exec(html)![0];
    expect(telegram).toContain('aria-label="Telegram"');
    expect(telegram).toContain('aria-describedby="alfred-settings-nav-status-telegram"');
    expect(telegram).toContain('id="alfred-settings-nav-status-telegram"');
    expect(telegram).toContain('alfred-settings-navigationStatus is-positive">Connected</span>');
    expect(html).not.toContain('alfred-settings-nav-status-bank');
  });
});

describe("Settings status facts", () => {
  const saved = { telegramLocked: false, telegramUserId: "", morningEnabled: false, commuteEnabled: false, eveningEnabled: false, timezone: "Africa/Accra" };

  it("does not infer a link from an entered ID or infer bank setup before its data is loaded", () => {
    expect(settingsNavigationStatuses(saved)).toEqual({ telegram: { text: "Not connected" }, reminders: { text: "Check-ins off" } });
    expect(settingsNavigationStatuses({ ...saved, telegramUserId: "123456" }).telegram).toEqual({ text: "ID saved · finish connecting" });
    expect(settingsNavigationStatuses({ ...saved, telegramUserId: "123456", telegramLocked: true }).telegram).toEqual({ text: "Connected", tone: "positive" });
  });

  it("counts only the saved daily check-ins", () => {
    expect(settingsNavigationStatuses({ ...saved, morningEnabled: true }).reminders?.text).toBe("1 check-in enabled");
    expect(settingsNavigationStatuses({ ...saved, morningEnabled: true, eveningEnabled: true }).reminders?.text).toBe("2 check-ins enabled");
  });

  it("reports forwarding setup and last use in the account timezone without claiming successful delivery", () => {
    expect(settingsNavigationStatuses(saved, { connected: false, lastUsedAt: "2026-11-05T01:00:00Z" }).bank?.text).toBe("Not set up");
    expect(settingsNavigationStatuses(saved, { connected: true, lastUsedAt: null }).bank?.text).toBe("Forwarding key ready");
    const status = settingsNavigationStatuses({ ...saved, timezone: "America/Los_Angeles" }, { connected: true, lastUsedAt: "2026-11-05T01:00:00Z" }).bank;
    expect(status).toEqual({ text: "Forwarding key ready · used 4 Nov 2026" });
    expect(status?.text).not.toMatch(/synced|delivered|Mac connected/i);
  });

  it("keeps the known setup state when a stored date or timezone cannot be formatted", () => {
    expect(settingsNavigationStatuses(saved, { connected: true, lastUsedAt: "not a date" }).bank?.text).toBe("Forwarding key ready");
    expect(settingsNavigationStatuses({ ...saved, timezone: "Invalid/Timezone" }, { connected: true, lastUsedAt: "2026-11-05T01:00:00Z" }).bank?.text).toBe("Forwarding key ready");
  });
});
