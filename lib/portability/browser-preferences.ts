export const BROWSER_PREFERENCES_DATASET = "alfred.browserPreferences";
export type BrowserPreferences = { schema: 1; appearance: "light" | "dark"; privacy: "visible" | "masked"; home: "chat" | "overview" };
export type BrowserPreferenceField = "appearance" | "privacy" | "home";
export type BrowserPreferenceChange = { field: BrowserPreferenceField; before: string; after: string };
export type BrowserPreferencePlan = {
  status: "ready" | "blocked" | "unchanged" | "preserved";
  current: BrowserPreferences;
  incoming: BrowserPreferences;
  changes: BrowserPreferenceChange[];
  conflicts: string[];
  warnings: string[];
};
export type BrowserPreferenceReceipt = {
  status: "applied" | "unchanged" | "partial" | "unknown" | "undone" | "preserved";
  changes: BrowserPreferenceChange[];
  warnings: string[];
  undoBlocked: boolean;
};
export const DEFAULT_BROWSER_PREFERENCES: BrowserPreferences = { schema: 1, appearance: "light", privacy: "visible", home: "chat" };
export const BROWSER_PREFERENCE_FIELDS = ["appearance", "privacy", "home"] as const;

export function parseBrowserPreferences(value: unknown): BrowserPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The archive's browser preferences are invalid.");
  const item = value as Record<string, unknown>;
  if (Object.keys(item).sort().join(",") !== "appearance,home,privacy,schema" || item.schema !== 1
    || typeof item.appearance !== "string" || !["light", "dark"].includes(item.appearance) || typeof item.privacy !== "string" || !["visible", "masked"].includes(item.privacy) || typeof item.home !== "string" || !["chat", "overview"].includes(item.home)) {
    throw new Error("The archive's browser preferences are invalid.");
  }
  return { schema: 1, appearance: item.appearance as BrowserPreferences["appearance"], privacy: item.privacy as BrowserPreferences["privacy"], home: item.home as BrowserPreferences["home"] };
}

export function planBrowserPreferences(current: BrowserPreferences, incoming: BrowserPreferences): BrowserPreferencePlan {
  const changes: BrowserPreferenceChange[] = [], conflicts: string[] = [];
  for (const field of BROWSER_PREFERENCE_FIELDS) {
    if (current[field] === incoming[field]) continue;
    if (current[field] !== DEFAULT_BROWSER_PREFERENCES[field]) conflicts.push(`${field}: this browser uses ${current[field]}, but the archive uses ${incoming[field]}. Choose your preferred value in Settings, then preview again.`);
    else changes.push({ field, before: current[field], after: incoming[field] });
  }
  return {
    status: conflicts.length ? "blocked" : changes.length ? "ready" : "unchanged", current, incoming, changes, conflicts,
    warnings: ["Device preferences are saved after the finance import. If this device cannot save them, your finance records stay imported and the receipt shows which preferences need attention."],
  };
}

/** These are presentation values, never arbitrary cookies or browser storage. */
export function browserPreferencesFromExportQuery(url: URL, home: BrowserPreferences["home"]): BrowserPreferences | undefined {
  const appearance = url.searchParams.getAll("appearance"), privacy = url.searchParams.getAll("privacy");
  if (!appearance.length && !privacy.length) return undefined;
  if (appearance.length !== 1 || privacy.length !== 1) throw new Error("Export requires one appearance value and one privacy value.");
  return parseBrowserPreferences({ schema: 1, appearance: appearance[0], privacy: privacy[0], home });
}
