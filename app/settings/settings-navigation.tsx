"use client";

import type { ReactNode } from "react";
import type { AccountSettings } from "@/lib/accounts/settings-store";
import type { LedgerBank } from "@/lib/web/ledger";
import "./settings-navigation.css";

export const SETTINGS_SECTIONS = [
  { id: "profile", label: "Profile" },
  { id: "replies", label: "Alfred's replies" },
  { id: "budgets", label: "Budgets" },
  { id: "goals", label: "Savings goals" },
  { id: "reminders", label: "Reminders" },
  { id: "automations", label: "Automations" },
  { id: "telegram", label: "Telegram" },
  { id: "bank", label: "Bank messages" },
  { id: "rules", label: "Categorisation rules" },
  { id: "app", label: "App & look" },
  { id: "data", label: "Data & privacy" },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

export const SETTINGS_GROUPS = [
  { id: "personal", label: "Personal", sections: ["profile", "replies", "app"] },
  { id: "money", label: "Money", sections: ["budgets", "goals", "reminders", "rules"] },
  { id: "connections", label: "Connections", sections: ["automations", "telegram", "bank"] },
  { id: "data", label: "Data", sections: ["data"] },
] as const satisfies readonly { id: string; label: string; sections: readonly SettingsSectionId[] }[];

export type SettingsNavigationStatus = { text: string; tone?: "positive" };
export type SettingsNavigationStatuses = Partial<Record<SettingsSectionId, SettingsNavigationStatus>>;

/** Describe saved settings and already-loaded bank facts without starting another read. */
export function settingsNavigationStatuses(
  saved: Pick<AccountSettings, "telegramLocked" | "telegramUserId" | "morningEnabled" | "commuteEnabled" | "eveningEnabled" | "timezone">,
  bank?: Pick<LedgerBank, "connected" | "lastUsedAt">,
): SettingsNavigationStatuses {
  const checkIns = [saved.morningEnabled, saved.commuteEnabled, saved.eveningEnabled].filter(Boolean).length;
  const statuses: SettingsNavigationStatuses = {
    telegram: saved.telegramLocked
      ? { text: "Connected", tone: "positive" }
      : { text: saved.telegramUserId.trim() ? "ID saved · finish connecting" : "Not connected" },
    reminders: { text: checkIns ? `${checkIns} check-in${checkIns === 1 ? "" : "s"} enabled` : "Check-ins off" },
  };
  if (bank) {
    if (!bank.connected) statuses.bank = { text: "Not set up" };
    else {
      let lastUsed = "";
      if (bank.lastUsedAt && Number.isFinite(Date.parse(bank.lastUsedAt))) {
        try {
          lastUsed = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: saved.timezone }).format(new Date(bank.lastUsedAt));
        } catch { /* Keep the known setup state if a stored timezone cannot be formatted. */ }
      }
      statuses.bank = { text: `Forwarding key ready${lastUsed ? ` · used ${lastUsed}` : ""}` };
    }
  }
  return statuses;
}

export const SETTINGS_SECTION_DESCRIPTIONS: Record<SettingsSectionId, string> = {
  profile: "Your name, currency and preferences",
  replies: "How Alfred talks with you",
  budgets: "Plan your spending",
  goals: "What you’re saving towards",
  reminders: "Your daily check-ins",
  automations: "Sync, payment alerts and notifications",
  telegram: "Chat with Alfred in Telegram",
  bank: "Connected alerts and bank messages",
  rules: "How future payments are categorised",
  app: "Appearance and your home screen",
  data: "Download, import and manage your data",
};

const sectionIcons: Record<SettingsSectionId, ReactNode> = {
  profile: <><circle cx="12" cy="8" r="3.5" /><path d="M5 21v-1a7 7 0 0 1 14 0v1" /></>,
  replies: <path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-8l-6 4v-4H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm3 5h8m-8 4h5" />,
  budgets: <><path d="M12 3v9h9A9 9 0 0 0 12 3Z" /><path d="M8.5 3.7A9 9 0 1 0 20.3 15.5" /></>,
  goals: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1" /></>,
  reminders: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /><path d="M12 2V1" /></>,
  automations: <path d="m13 2-9 12h7l-1 8 10-13h-8l1-7Z" />,
  telegram: <path d="m22 3-7 18-4-8-9-4L22 3ZM11 13l6-6" />,
  bank: <><rect x="3" y="6" width="18" height="15" rx="3" /><path d="M3 10h18M7 6V3h11v3m-2 9h5" /></>,
  rules: <><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="8" cy="6" r="2" fill="var(--surface)" /><circle cx="16" cy="12" r="2" fill="var(--surface)" /><circle cx="10" cy="18" r="2" fill="var(--surface)" /></>,
  app: <><rect x="4" y="3" width="16" height="18" rx="3" /><path d="M4 8h16M10 8v13" /></>,
  data: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" /><path d="M12 8v7m-3-3 3 3 3-3" /></>,
};

function SettingsIcon({ section }: { section: SettingsSectionId }) {
  return <span className="alfred-settings-navigationIcon" aria-hidden="true"><svg className="alfred-settings-navigationSymbol" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" focusable="false">{sectionIcons[section]}</svg></span>;
}

/** Preserve existing notification links while keeping one Settings destination. */
export function resolveSettingsSection(hash: string): SettingsSectionId | null {
  const id = hash.startsWith("#") ? hash.slice(1) : hash;
  if (id === "notifications" || id === "automations-notifications") return "automations";
  return SETTINGS_SECTIONS.find((item) => item.id === id)?.id ?? null;
}

export function SettingsNavigation({ section, onChoose, statuses = {} }: {
  section: SettingsSectionId;
  onChoose: (section: SettingsSectionId) => void;
  statuses?: SettingsNavigationStatuses;
}) {
  return (
    <nav
      aria-label="Settings sections"
      className="alfred-settings-navigation"
    >
      {SETTINGS_GROUPS.map((group) => <div key={group.id} role="group" aria-labelledby={`alfred-settings-group-${group.id}`} className="alfred-settings-navigationGroup">
        <h2 id={`alfred-settings-group-${group.id}`} className="alfred-settings-navigationGroupTitle">{group.label}</h2>
        <div className="alfred-settings-navigationGroupItems">
      {group.sections.map((id) => {
        const item = SETTINGS_SECTIONS.find((item) => item.id === id)!;
        const active = item.id === section;
        const status = statuses[item.id];
        const statusId = `alfred-settings-nav-status-${item.id}`;
        return (
          <button
            key={item.id}
            type="button"
            data-section={item.id}
            onClick={() => onChoose(item.id)}
            aria-current={active ? "page" : undefined}
            aria-label={item.label}
            aria-controls="alfred-settings-detail"
            aria-describedby={status ? statusId : undefined}
            data-has-status={status ? "true" : undefined}
            className="alfred-settings-navigationItem"
          >
            <SettingsIcon section={item.id} />
            <span className="alfred-settings-navigationCopy"><span className="alfred-settings-navigationLabel">{item.label}</span><span className="alfred-settings-navigationDescription" aria-hidden="true">{SETTINGS_SECTION_DESCRIPTIONS[item.id]}</span>{status ? <span id={statusId} className={`alfred-settings-navigationStatus${status.tone === "positive" ? " is-positive" : ""}`}>{status.text}</span> : null}</span>
            <svg className="alfred-settings-navigationChevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
          </button>
        );
      })}
        </div>
      </div>)}
    </nav>
  );
}
