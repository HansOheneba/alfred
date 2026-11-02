export const BROWSER_PREFERENCES_LOCK = "alfred-browser-preferences";

export function browserPreferenceLocksAvailable(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.locks?.request === "function";
}

/** All normal appearance/privacy/home writers use this same origin-scoped lock. */
export async function serializeBrowserPreferenceWrite<T>(operation: () => Promise<T> | T): Promise<T> {
  if (browserPreferenceLocksAvailable()) return await navigator.locks.request(BROWSER_PREFERENCES_LOCK, async () => await operation());
  // Normal app controls remain usable in older browsers. The importer separately
  // disables automatic preference restoration when coordination is unavailable.
  return await operation();
}
