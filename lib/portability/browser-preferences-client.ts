import { readArchive } from "../../portability/archive.mjs";
import { BROWSER_PREFERENCES_DATASET, DEFAULT_BROWSER_PREFERENCES, parseBrowserPreferences, planBrowserPreferences, type BrowserPreferences, type BrowserPreferenceChange, type BrowserPreferencePlan, type BrowserPreferenceReceipt } from "./browser-preferences";
import { browserPreferenceLocksAvailable, serializeBrowserPreferenceWrite } from "./browser-preferences-lock";

const APPEARANCE_KEY = "alfred-appearance", PRIVACY_KEY = "alfred-privacy";
export const DEVICE_IMPORT_RECEIPTS_KEY = "alfred-portability-browser-receipts-v1";
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type DeviceState = { preferences: BrowserPreferences; appearanceRaw: string | null; privacyRaw: string | null };
type Entry = {
  previewId: string; archiveId: string; receiptId?: string; preparedAt: string;
  phase: "prepared" | "applying" | "applied" | "unchanged" | "undoing" | "undone" | "partial" | "preserved";
  before: DeviceState; after?: DeviceState; changes: BrowserPreferenceChange[]; warnings: string[];
};
export type BrowserPreferenceEnvironment = {
  storage: () => StorageLike;
  readHome: () => Promise<BrowserPreferences["home"]>;
  writeHome: (home: BrowserPreferences["home"], expectedHome: BrowserPreferences["home"]) => Promise<void>;
  present: (preferences: BrowserPreferences) => void;
  now: () => string;
  lockingAvailable: () => boolean;
  withLock: <T>(operation: () => Promise<T>) => Promise<T>;
  visiblePreferences?: () => Pick<BrowserPreferences, "appearance" | "privacy">;
};
type ServerReceipt = { id: string; archiveId: string; importedAt: string; undoAvailable: boolean; undoneAt?: string | null; browserPreferences?: BrowserPreferenceReceipt };
type ServerPreview = { id: string; archiveId: string; canConfirm: boolean; coverage: { dataset: string; status: string; reason: string; count?: number }[]; browserPreferences?: BrowserPreferencePlan };
type ServerUndo = { id: string; undoneAt: string; undoAvailable: false; browserPreferences?: BrowserPreferenceReceipt };
type Transport<P, R, U> = { exportArchive: () => Promise<Blob>; preview: (file: File) => Promise<P>; confirm: (id: string) => Promise<R>; undo: (id: string) => Promise<U>; receipts: () => Promise<R[]> };
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const text = (value: unknown, max = 1000): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const warn = (cause: unknown) => cause instanceof Error ? cause.message : "A browser preference step could not be confirmed.";

function localState(storage: StorageLike) {
  const appearanceRaw = storage.getItem(APPEARANCE_KEY), privacyRaw = storage.getItem(PRIVACY_KEY);
  if (appearanceRaw !== null && !["light", "dark"].includes(appearanceRaw) || privacyRaw !== null && !["visible", "masked"].includes(privacyRaw)) throw new Error("This browser has an unrecognised appearance or privacy setting. Choose a value in Settings, then preview again.");
  return { appearanceRaw, privacyRaw, appearance: appearanceRaw === "dark" ? "dark" as const : "light" as const, privacy: privacyRaw === "masked" ? "masked" as const : "visible" as const };
}

/** Read only these two non-secret presentation values; never serialize arbitrary localStorage. */
export function browserPreferenceExportQuery(storage: StorageLike = window.localStorage): string {
  const current = localState(storage);
  return new URLSearchParams({ appearance: current.appearance, privacy: current.privacy }).toString();
}
export function availableBrowserPreferenceExportQuery(storage: () => StorageLike = () => window.localStorage): string {
  try { return browserPreferenceExportQuery(storage()); }
  catch { return ""; } // The server records this dataset as unavailable; finance export still works.
}

async function homeRequest(method: "GET" | "POST", body?: unknown): Promise<BrowserPreferences["home"]> {
  const response = await fetch("/api/portability/browser-preferences", { method, cache: "no-store", ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
  const payload = await response.json().catch(() => ({})) as { ok?: boolean; text?: string; home?: unknown };
  if (!response.ok || !payload.ok || typeof payload.home !== "string" || !["chat", "overview"].includes(payload.home)) throw new Error(payload.text || "This browser's home-screen preference could not be checked.");
  return payload.home as BrowserPreferences["home"];
}

const defaultEnvironment: BrowserPreferenceEnvironment = {
  storage: () => window.localStorage,
  readHome: () => homeRequest("GET"),
  async writeHome(home, expectedHome) { if (await homeRequest("POST", { home, expectedHome }) !== home) throw new Error("The home-screen preference update could not be confirmed."); },
  present(preferences) {
    if (preferences.appearance === "dark") document.documentElement.dataset.theme = "dark";
    else delete document.documentElement.dataset.theme;
    if (preferences.privacy === "masked") document.documentElement.dataset.privacy = "masked";
    else delete document.documentElement.dataset.privacy;
  },
  now: () => new Date().toISOString(),
  lockingAvailable: browserPreferenceLocksAvailable,
  withLock: serializeBrowserPreferenceWrite,
  visiblePreferences: () => ({ appearance: document.documentElement.dataset.theme === "dark" ? "dark" : "light", privacy: document.documentElement.dataset.privacy === "masked" ? "masked" : "visible" }),
};

function validateState(value: unknown): DeviceState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Device import history is invalid.");
  const state = value as DeviceState, preferences = parseBrowserPreferences(state.preferences);
  if (state.appearanceRaw !== null && !["light", "dark"].includes(state.appearanceRaw) || state.privacyRaw !== null && !["visible", "masked"].includes(state.privacyRaw)) throw new Error("Device import history is invalid.");
  if ((state.appearanceRaw === "dark" ? "dark" : "light") !== preferences.appearance || (state.privacyRaw === "masked" ? "masked" : "visible") !== preferences.privacy) throw new Error("Device import history is inconsistent.");
  return { preferences, appearanceRaw: state.appearanceRaw, privacyRaw: state.privacyRaw };
}

function publicEntry(entry: Entry, serverUndone = false): BrowserPreferenceReceipt {
  const completed = ["applied", "unchanged", "undone", "preserved"].includes(entry.phase);
  const remotelyUndone = serverUndone && !["undone", "preserved"].includes(entry.phase);
  return {
    status: remotelyUndone ? "partial" : entry.phase === "applied" || entry.phase === "unchanged" || entry.phase === "undone" || entry.phase === "preserved" ? entry.phase : entry.phase === "prepared" ? "unknown" : "partial",
    changes: entry.changes,
    warnings: [...entry.warnings, ...(remotelyUndone ? ["The finance import was undone separately. This device's preferences were not automatically restored; later browser edits are never overwritten."] : !completed && !entry.warnings.length ? ["The browser preference outcome is incomplete or uncertain. Financial history remains in this receipt; automatic undo is blocked on this device."] : [])],
    undoBlocked: !completed || remotelyUndone,
  };
}

/**
 * Finance commits first. A persisted device journal makes the separate browser
 * steps explicit and idempotent. Any uncertain outcome blocks automatic undo;
 * this does not claim a transaction across PostgreSQL, cookies and localStorage.
 */
export function withBrowserPreferences<P extends ServerPreview, R extends ServerReceipt, U extends ServerUndo>(base: Transport<P, R, U>, env: BrowserPreferenceEnvironment = defaultEnvironment) {
  const plans = new Map<string, { archiveId: string; plan: BrowserPreferencePlan; before: DeviceState }>();
  const memory = new Map<string, Entry>();
  const knownServerReceipts = new Map<string, R>();

  async function state(): Promise<DeviceState> {
    const home = await env.readHome(), local = localState(env.storage());
    const visible = env.visiblePreferences?.();
    if (visible && (visible.appearance !== local.appearance || visible.privacy !== local.privacy)) throw new Error("The visible device preferences differ from their saved values. Reload or save your preferred appearance and privacy settings, then preview again.");
    return { preferences: parseBrowserPreferences({ schema: 1, appearance: local.appearance, privacy: local.privacy, home }), appearanceRaw: local.appearanceRaw, privacyRaw: local.privacyRaw };
  }
  function entries(): Entry[] {
    const raw = env.storage().getItem(DEVICE_IMPORT_RECEIPTS_KEY);
    if (raw === null) return [];
    if (raw.length > 500_000) throw new Error("Device import history exceeds its limit. Automatic preference changes are blocked.");
    let parsed: unknown; try { parsed = JSON.parse(raw); } catch { throw new Error("Device import history could not be read. Automatic preference changes are blocked."); }
    if (!parsed || typeof parsed !== "object" || (parsed as {schema?:unknown}).schema !== 1 || !Array.isArray((parsed as {entries?:unknown}).entries)) throw new Error("Device import history is invalid.");
    const list = (parsed as { entries: Entry[] }).entries;
    if (list.length > 200) throw new Error("Device import history exceeds its limit.");
    return list.map((entry) => {
      if (!entry || !text(entry.previewId, 200) || !text(entry.archiveId, 200) || entry.receiptId !== undefined && !text(entry.receiptId, 200)
        || !text(entry.preparedAt, 60) || !Number.isFinite(Date.parse(entry.preparedAt)) || !["prepared", "applying", "applied", "unchanged", "undoing", "undone", "partial", "preserved"].includes(entry.phase)
        || !Array.isArray(entry.changes) || entry.changes.length > 3 || !Array.isArray(entry.warnings) || entry.warnings.length > 20 || entry.warnings.some((item) => !text(item, 2000))) throw new Error("Device import history is invalid.");
      for (const change of entry.changes) if (!change || !["appearance", "privacy", "home"].includes(change.field) || !text(change.before, 20) || !text(change.after, 20)) throw new Error("Device import history is invalid.");
      return { ...entry, before: validateState(entry.before), ...(entry.after ? { after: validateState(entry.after) } : {}) };
    });
  }
  function save(entry: Entry) {
    memory.set(entry.previewId, structuredClone(entry));
    const current = entries(), next = [...current.filter((item) => item.previewId !== entry.previewId && (!entry.receiptId || item.receiptId !== entry.receiptId)), entry];
    if (next.length > 200) throw new Error("Device import history is full. No preference changes were started.");
    const encoded = JSON.stringify({ schema: 1, entries: next });
    env.storage().setItem(DEVICE_IMPORT_RECEIPTS_KEY, encoded);
    if (env.storage().getItem(DEVICE_IMPORT_RECEIPTS_KEY) !== encoded) throw new Error("Device import history could not be saved.");
  }
  function bestEffort(entry: Entry) { memory.set(entry.previewId, structuredClone(entry)); try { save(entry); } catch { /* Return this uncertain state with its authoritative finance receipt. */ } }
  function allEntries(): Entry[] {
    const current = new Map(entries().map((entry) => [entry.previewId, entry]));
    for (const entry of memory.values()) current.set(entry.previewId, entry);
    return [...current.values()];
  }
  function attach<T extends ServerReceipt>(receipt: T): T & { browserPreferences?: BrowserPreferenceReceipt } {
    knownServerReceipts.set(receipt.id, receipt as unknown as R);
    let entry: Entry | undefined;
    try {
      const list = allEntries();
      entry = list.find((item) => item.receiptId === receipt.id && item.archiveId === receipt.archiveId)
        ?? list.find((item) => !item.receiptId && item.archiveId === receipt.archiveId);
    } catch (cause) {
      return { ...receipt, undoAvailable: false, browserPreferences: { status: "unknown", changes: [], undoBlocked: true, warnings: [`Device preference history is unavailable: ${warn(cause)} Financial records are unchanged by this check. Automatic undo is blocked on this device.`] } };
    }
    if (!entry) return receipt;
    const browserPreferences = publicEntry(entry, Boolean(receipt.undoneAt));
    return { ...receipt, undoAvailable: receipt.undoAvailable && !browserPreferences.undoBlocked, browserPreferences };
  }
  async function unchanged(expected: DeviceState) {
    if (!same(await state(), expected)) throw new Error("Browser preferences changed after preview or import. No later preference will be overwritten. Preview again before importing; automatic undo is blocked after later browser edits.");
  }
  function writeLocal(key: string, raw: string | null) { if (raw === null) env.storage().removeItem(key); else env.storage().setItem(key, raw); }
  async function movePreferences(from: DeviceState, to: DeviceState) {
    await unchanged(from);
    // Local writes are synchronous. Re-check both keys immediately before writing.
    const expectedLocal = localState(env.storage());
    if (expectedLocal.appearanceRaw !== from.appearanceRaw || expectedLocal.privacyRaw !== from.privacyRaw) throw new Error("Browser preferences changed during import. No later preference was overwritten.");
    if (from.appearanceRaw !== to.appearanceRaw) writeLocal(APPEARANCE_KEY, to.appearanceRaw);
    if (from.privacyRaw !== to.privacyRaw) writeLocal(PRIVACY_KEY, to.privacyRaw);
    env.present(to.preferences);
    if (from.preferences.home !== to.preferences.home) await env.writeHome(to.preferences.home, from.preferences.home);
    if (!same(await state(), to)) throw new Error("The browser preference update could not be fully confirmed. No automatic overwrite or retry will be attempted.");
  }
  return {
    ...base,
    async preview(file: File): Promise<P & { browserPreferences?: BrowserPreferencePlan }> {
      const archive = await readArchive(await file.arrayBuffer());
      const value = archive.datasets[BROWSER_PREFERENCES_DATASET];
      const incoming = value === undefined ? undefined : parseBrowserPreferences(value);
      const locksAvailable = env.lockingAvailable();
      let before: DeviceState | undefined;
      if (incoming) {
        if (locksAvailable) before = await state();
        else {
          try { before = await state(); } catch { before = { preferences: { ...DEFAULT_BROWSER_PREFERENCES }, appearanceRaw: null, privacyRaw: null }; }
        }
      }
      const plan: BrowserPreferencePlan | undefined = before && incoming ? locksAvailable ? planBrowserPreferences(before.preferences, incoming) : {
        status: "preserved", current: before.preferences, incoming, changes: [], conflicts: [],
        warnings: ["This browser cannot safely coordinate preference changes across tabs. These preferences will stay in the archive for re-export and will not be applied. Your finance records can still be imported."],
      } : undefined;
      const preview = await base.preview(file);
      if (!plan || !before) return preview;
      plans.set(preview.id, { archiveId: archive.archiveId, plan, before });
      return { ...preview, canConfirm: preview.canConfirm && !plan.conflicts.length, browserPreferences: plan,
        coverage: [...preview.coverage.filter((item) => item.dataset !== BROWSER_PREFERENCES_DATASET), { dataset: BROWSER_PREFERENCES_DATASET, status: plan.conflicts.length || plan.status === "preserved" ? "preserved" : "supported", count: 3, reason: plan.status === "preserved" ? "Browser preferences are preserved for re-export; this browser cannot coordinate their safe automatic restoration." : plan.conflicts.length ? "Browser preference conflicts block confirmation; existing values are not overwritten." : "Default-only appearance, privacy and home-screen changes apply separately on this browser after financial confirmation." }] };
    },
    async confirm(previewId: string): Promise<R & { browserPreferences?: BrowserPreferenceReceipt }> {
      const staged = plans.get(previewId);
      if (!staged) return attach(await base.confirm(previewId));
      if (staged.plan.status === "preserved") {
        const receipt = await base.confirm(previewId);
        const entry: Entry = { previewId, archiveId: staged.archiveId, receiptId: receipt.id, preparedAt: env.now(), phase: "preserved", before: staged.before, changes: [], warnings: staged.plan.warnings };
        bestEffort(entry); knownServerReceipts.set(receipt.id, receipt);
        return { ...receipt, browserPreferences: publicEntry(entry) };
      }
      if (!env.lockingAvailable()) throw new Error("This browser can no longer coordinate preference changes. Preview the archive again to import finance records with preferences preserved only.");
      return env.withLock(async () => {
      // A retry for a finance receipt already observed on this device must not
      // reapply preferences, even if the person has since changed the browser.
      const completedAttempt = allEntries().find((item) => item.previewId === previewId && item.receiptId);
      if (completedAttempt) return attach(await base.confirm(previewId));
      if (staged.plan.conflicts.length) throw new Error("Resolve the browser preference conflicts before importing.");
      await unchanged(staged.before);
      const entry: Entry = { previewId, archiveId: staged.archiveId, preparedAt: env.now(), phase: "prepared", before: staged.before, changes: staged.plan.changes, warnings: [] };
      // Fail before finance commits if device history cannot be written.
      save(entry);
      const receipt = await base.confirm(previewId);
      knownServerReceipts.set(receipt.id, receipt);
      entry.receiptId = receipt.id;
      if (receipt.undoneAt) { entry.phase = "undone"; entry.after = entry.before; bestEffort(entry); return attach(receipt); }
      try {
        const previous = allEntries().find((item) => item.receiptId === receipt.id && item.archiveId === receipt.archiveId);
        if (previous) return attach(receipt); // An idempotent finance retry never reapplies preferences.
        entry.phase = "applying"; save(entry);
        const target: DeviceState = { preferences: { ...entry.before.preferences }, appearanceRaw: entry.before.appearanceRaw, privacyRaw: entry.before.privacyRaw };
        for (const change of entry.changes) {
          if (change.field === "appearance") { target.preferences.appearance = staged.plan.incoming.appearance; target.appearanceRaw = staged.plan.incoming.appearance; }
          if (change.field === "privacy") { target.preferences.privacy = staged.plan.incoming.privacy; target.privacyRaw = staged.plan.incoming.privacy === "visible" ? null : "masked"; }
          if (change.field === "home") target.preferences.home = staged.plan.incoming.home;
        }
        await movePreferences(entry.before, target);
        entry.after = target; entry.phase = entry.changes.length ? "applied" : "unchanged"; save(entry);
      } catch (cause) {
        entry.phase = "partial"; entry.warnings = [`Finance import succeeded, but browser preferences were not fully confirmed: ${warn(cause)} This receipt is retained. Automatic preference retry and undo are blocked on this device.`]; bestEffort(entry);
      }
      return attach(receipt);
      });
    },
    async undo(receiptId: string): Promise<U & { browserPreferences?: BrowserPreferenceReceipt }> {
      const preserved = [...memory.values()].find((item) => item.receiptId === receiptId && item.phase === "preserved");
      if (preserved) return { ...await base.undo(receiptId), browserPreferences: publicEntry(preserved) };
      // Check persisted history before choosing whether this operation needs the
      // preference lock. Imports performed on another device have no local change.
      const current = allEntries();
      const known = knownServerReceipts.get(receiptId);
      const entry = current.find((item) => item.receiptId === receiptId && (!known || item.archiveId === known.archiveId));
      if (!entry) {
        if (known && current.some((item) => !item.receiptId && item.archiveId === known.archiveId)) throw new Error("The browser preference outcome for this import is uncertain. Automatic undo is blocked on this device.");
        return base.undo(receiptId);
      }
      if (entry.phase === "preserved") return { ...await base.undo(receiptId), browserPreferences: publicEntry(entry) };
      if (!env.lockingAvailable()) throw new Error("This browser cannot safely coordinate preference restoration. Automatic undo is blocked on this device.");
      return env.withLock(async () => {
      if (!["applied", "unchanged", "undone"].includes(entry.phase) || !entry.after) throw new Error("The browser preference outcome is incomplete or uncertain. Automatic undo is blocked on this device.");
      if (entry.phase === "undone") return base.undo(receiptId);
      await unchanged(entry.after);
      entry.phase = "undoing"; save(entry);
      const result = await base.undo(receiptId);
      try {
        await movePreferences(entry.after, entry.before);
        entry.phase = "undone"; entry.warnings = []; save(entry);
      } catch (cause) {
        entry.phase = "partial"; entry.warnings = [`Finance import was undone, but this device's preference restoration was not fully confirmed: ${warn(cause)} No automatic retry will overwrite later browser edits.`]; bestEffort(entry);
      }
      return { ...result, browserPreferences: publicEntry(entry) };
      });
    },
    async receipts(): Promise<(R & { browserPreferences?: BrowserPreferenceReceipt })[]> { return (await base.receipts()).map((receipt) => attach(receipt)); },
  };
}
