"use client";

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

/** Preserve existing notification links while keeping one Settings destination. */
export function resolveSettingsSection(hash: string): SettingsSectionId | null {
  const id = hash.startsWith("#") ? hash.slice(1) : hash;
  if (id === "notifications" || id === "automations-notifications") return "automations";
  return SETTINGS_SECTIONS.find((item) => item.id === id)?.id ?? null;
}

export function SettingsNavigation({ section, onChoose }: {
  section: SettingsSectionId;
  onChoose: (section: SettingsSectionId) => void;
}) {
  return (
    <nav
      aria-label="Settings sections"
      className="-mx-4 flex gap-1 overflow-x-auto px-4 py-2 md:sticky md:top-6 md:mx-0 md:w-52 md:shrink-0 md:flex-col md:overflow-visible md:px-0 md:py-0"
    >
      {SETTINGS_SECTIONS.map((item) => {
        const active = item.id === section;
        return (
          <button
            key={item.id}
            type="button"
            data-section={item.id}
            onClick={() => onChoose(item.id)}
            aria-current={active ? "page" : undefined}
            className={`min-h-11 shrink-0 whitespace-nowrap rounded-xl px-3 py-2 text-left text-sm font-medium leading-5 transition focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent ${
              active ? "bg-surface-2 text-ink" : "text-muted hover:bg-surface-2 hover:text-ink"
            }`}
          >
            {active ? <span className="mr-2 inline-block size-1.5 rounded-full bg-accent align-middle" aria-hidden="true" /> : null}
            {item.label}
          </button>
        );
      })}
    </nav>
  );
}
