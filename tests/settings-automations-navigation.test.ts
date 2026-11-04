import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SETTINGS_SECTIONS, SettingsNavigation, resolveSettingsSection } from "@/app/settings/settings-navigation";

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
      const icon = /<svg class="alfred-settings-navigationSymbol"[^>]*focusable="false"[^>]*>([\s\S]*?)<\/svg>/.exec(button![1]);
      expect(icon).not.toBeNull();
      expect(icon![1]).toMatch(/<(?:path|circle|rect)\b/);
      icons.push(icon![1]);
    }
    expect(new Set(icons).size).toBe(SETTINGS_SECTIONS.length);
  });
});
