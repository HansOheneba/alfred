import { afterEach, describe, expect, it, vi } from "vitest";
import { createArchive, readArchive } from "../portability/archive.mjs";
import { BROWSER_PREFERENCES_DATASET, browserPreferencesFromExportQuery, DEFAULT_BROWSER_PREFERENCES, parseBrowserPreferences, planBrowserPreferences, type BrowserPreferences } from "@/lib/portability/browser-preferences";
import { availableBrowserPreferenceExportQuery, browserPreferenceExportQuery, DEVICE_IMPORT_RECEIPTS_KEY, withBrowserPreferences, type BrowserPreferenceEnvironment } from "@/lib/portability/browser-preferences-client";
import { browserPreferenceLocksAvailable, BROWSER_PREFERENCES_LOCK, serializeBrowserPreferenceWrite } from "@/lib/portability/browser-preferences-lock";

const NOW = "2026-11-02T12:00:00.000Z";
const incoming: BrowserPreferences = { schema: 1, appearance: "dark", privacy: "masked", home: "overview" };
afterEach(() => vi.unstubAllGlobals());
function installQueuedLocks() {
  let tail = Promise.resolve(); const names: string[] = [];
  vi.stubGlobal("navigator", { locks: { request: <T>(name: string, operation: () => Promise<T> | T) => {
    names.push(name); const running = tail.then(operation); tail = running.then(() => undefined, () => undefined); return running;
  } } });
  return names;
}
class MemoryStorage {
  values = new Map<string, string>();
  blocked = false;
  failKey: string | null = null;
  getItem(key: string) { if (this.blocked) throw new Error("Storage is blocked"); return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { if (this.blocked || this.failKey === key) throw new Error("Storage write failed"); this.values.set(key, value); }
  removeItem(key: string) { if (this.blocked || this.failKey === key) throw new Error("Storage write failed"); this.values.delete(key); }
}
async function harness(prefs: unknown = incoming) {
  const datasets = { accounts: [], movements: [], snapshots: [], transfers: [], settlements: [], ...(prefs === undefined ? {} : { [BROWSER_PREFERENCES_DATASET]: prefs as Record<string, unknown> }) };
  const bytes = await createArchive({ sourceApp: "alfred", namespace: "synthetic:browser", timezone: "UTC", currency: "GHS", exportedAt: NOW, datasets, coverage: [] });
  const archive = await readArchive(bytes);
  const storage = new MemoryStorage();
  let home: BrowserPreferences["home"] = "chat";
  let homeFailure: "none" | "before" | "after" = "none";
  const presented: BrowserPreferences[] = [];
  const env: BrowserPreferenceEnvironment = {
    storage: () => storage,
    async readHome() { return home; },
    async writeHome(next, expected) { if (homeFailure === "before") throw new Error("Home response lost"); if (home !== expected) throw new Error("Stale home"); home = next; if (homeFailure === "after") throw new Error("Home response lost"); },
    present(p) { presented.push(structuredClone(p)); }, now: () => NOW,
    lockingAvailable: () => true, withLock: async (operation) => operation(),
  };
  const receipt = { id: "synthetic-receipt", archiveId: archive.archiveId, importedAt: NOW, undoAvailable: true, undoneAt: undefined as string | undefined };
  const base = {
    exportArchive: vi.fn(async () => new Blob([new Uint8Array(bytes)])),
    preview: vi.fn(async () => ({ id: "synthetic-preview", archiveId: archive.archiveId, canConfirm: true, coverage: [] as {dataset:string;status:string;reason:string}[] })),
    confirm: vi.fn(async () => ({ ...receipt })),
    undo: vi.fn(async () => { receipt.undoneAt = NOW; receipt.undoAvailable = false; return { id: receipt.id, undoneAt: NOW, undoAvailable: false as const }; }),
    receipts: vi.fn(async () => [{ ...receipt }]),
  };
  const transport = withBrowserPreferences(base, env);
  return { storage, env, base, transport, receipt, file: new File([new Uint8Array(bytes)], "synthetic.zip", { type: "application/zip" }), presented,
    getHome: () => home, setHome: (value: BrowserPreferences["home"]) => { home = value; }, failHome: (mode: typeof homeFailure) => { homeFailure = mode; } };
}

describe("browser preference portability", () => {
  it("accepts only the typed supplemental schema and default-only changes", () => {
    expect(parseBrowserPreferences(incoming)).toEqual(incoming);
    for (const value of [null, [], { ...incoming, token: "excluded" }, { ...incoming, schema: 2 }, { ...incoming, appearance: ["dark"] }, { ...incoming, home: "https://example.com" }]) expect(() => parseBrowserPreferences(value)).toThrow("invalid");
    expect(planBrowserPreferences(DEFAULT_BROWSER_PREFERENCES, incoming)).toMatchObject({ status: "ready", changes: [{ field: "appearance", before: "light", after: "dark" }, { field: "privacy", before: "visible", after: "masked" }, { field: "home", before: "chat", after: "overview" }], conflicts: [] });
    expect(planBrowserPreferences(incoming, DEFAULT_BROWSER_PREFERENCES)).toMatchObject({ status: "blocked", changes: [] });
    expect(planBrowserPreferences(incoming, incoming).status).toBe("unchanged");
  });
  it("exports only known presentation keys and reads home from the server value", () => {
    const storage = new MemoryStorage(); storage.values.set("alfred-appearance", "dark"); storage.values.set("session", "never export");
    expect(browserPreferenceExportQuery(storage)).toBe("appearance=dark&privacy=visible");
    expect(browserPreferencesFromExportQuery(new URL("https://app.test/export?appearance=dark&privacy=masked"), "overview")).toEqual(incoming);
    expect(browserPreferencesFromExportQuery(new URL("https://app.test/export"), "overview")).toBeUndefined();
    for (const query of ["appearance=dark", "appearance=dark&appearance=light&privacy=visible", "appearance=unknown&privacy=visible"]) expect(() => browserPreferencesFromExportQuery(new URL(`https://app.test/export?${query}`), "chat")).toThrow();
  });
  it("previews validated archive preferences and requires conflicts to be resolved", async () => {
    const h = await harness(DEFAULT_BROWSER_PREFERENCES); h.storage.values.set("alfred-appearance", "dark");
    const preview = await h.transport.preview(h.file);
    expect(preview.canConfirm).toBe(false); expect(preview.browserPreferences?.conflicts).toHaveLength(1);
    await expect(h.transport.confirm(preview.id)).rejects.toThrow("conflicts"); expect(h.base.confirm).not.toHaveBeenCalled();
  });
  it("blocks storage failures and later preference edits before finance confirmation", async () => {
    const h = await harness(); const p = await h.transport.preview(h.file);
    h.storage.values.set("alfred-privacy", "masked");
    await expect(h.transport.confirm(p.id)).rejects.toThrow("changed"); expect(h.base.confirm).not.toHaveBeenCalled();
    const second = await harness(); const next = await second.transport.preview(second.file); second.storage.failKey = DEVICE_IMPORT_RECEIPTS_KEY;
    await expect(second.transport.confirm(next.id)).rejects.toThrow("Storage write failed"); expect(second.base.confirm).not.toHaveBeenCalled();
    const blocked = await harness(); blocked.storage.blocked = true;
    await expect(blocked.transport.preview(blocked.file)).rejects.toThrow("Storage is blocked"); expect(blocked.base.preview).not.toHaveBeenCalled();
  });
  it("applies after finance success, persists a receipt across reload, and restores exact defaults on undo", async () => {
    const h = await harness(); const p = await h.transport.preview(h.file); const result = await h.transport.confirm(p.id);
    expect(result.browserPreferences).toMatchObject({ status: "applied", undoBlocked: false });
    expect(h.storage.getItem("alfred-appearance")).toBe("dark"); expect(h.storage.getItem("alfred-privacy")).toBe("masked"); expect(h.getHome()).toBe("overview");
    const reloaded = withBrowserPreferences(h.base, h.env); expect((await reloaded.receipts())[0].browserPreferences?.status).toBe("applied");
    const undone = await reloaded.undo(result.id); expect(undone.browserPreferences?.status).toBe("undone");
    expect(h.storage.getItem("alfred-appearance")).toBeNull(); expect(h.storage.getItem("alfred-privacy")).toBeNull(); expect(h.getHome()).toBe("chat");
  });
  it("never reapplies browser preferences on a duplicate finance confirmation", async () => {
    const h = await harness(); const p = await h.transport.preview(h.file); await h.transport.confirm(p.id);
    h.storage.removeItem("alfred-appearance"); h.storage.removeItem("alfred-privacy"); h.setHome("chat");
    await h.transport.confirm(p.id);
    expect(h.storage.getItem("alfred-appearance")).toBeNull(); expect(h.storage.getItem("alfred-privacy")).toBeNull(); expect(h.getHome()).toBe("chat"); expect(h.presented).toHaveLength(1);
    const reloaded = withBrowserPreferences({ ...h.base, preview: vi.fn(async () => ({ id: "new-preview", archiveId: h.receipt.archiveId, canConfirm: true, coverage: [] })) }, h.env);
    const p2 = await reloaded.preview(h.file); await reloaded.confirm(p2.id);
    expect(h.storage.getItem("alfred-appearance")).toBeNull(); expect(h.presented).toHaveLength(1);
  });
  it("returns the finance receipt when local storage partially fails after commit", async () => {
    const h = await harness(); const p = await h.transport.preview(h.file);
    h.base.confirm.mockImplementation(async () => { h.storage.failKey = "alfred-privacy"; return { ...h.receipt }; });
    const result = await h.transport.confirm(p.id);
    expect(result.id).toBe(h.receipt.id); expect(result.browserPreferences).toMatchObject({ status: "partial", undoBlocked: true }); expect(result.undoAvailable).toBe(false);
    expect(h.storage.getItem("alfred-appearance")).toBe("dark"); expect(h.storage.getItem("alfred-privacy")).toBeNull();
    await expect(h.transport.undo(result.id)).rejects.toThrow("incomplete or uncertain"); expect(h.base.undo).not.toHaveBeenCalled();
    const reloaded = withBrowserPreferences(h.base, h.env); expect((await reloaded.receipts())[0].browserPreferences?.status).toBe("partial");
  });
  it("returns the finance receipt if storage becomes unreadable immediately after commit", async () => {
    const h = await harness(); const p = await h.transport.preview(h.file);
    h.base.confirm.mockImplementation(async () => { h.storage.blocked = true; return { ...h.receipt }; });
    const result = await h.transport.confirm(p.id);
    expect(result.id).toBe(h.receipt.id); expect(result.browserPreferences?.undoBlocked).toBe(true); expect(result.undoAvailable).toBe(false);
  });
  it("marks a lost home response uncertain instead of discarding a committed finance receipt", async () => {
    const h = await harness(); const p = await h.transport.preview(h.file); h.failHome("after");
    const result = await h.transport.confirm(p.id);
    expect(h.getHome()).toBe("overview"); expect(result.browserPreferences?.status).toBe("partial"); expect(result.undoAvailable).toBe(false);
    const reloaded = withBrowserPreferences(h.base, h.env); expect((await reloaded.receipts())[0].browserPreferences?.undoBlocked).toBe(true);
  });
  it("blocks undo before finance changes if a later browser edit occurred", async () => {
    const h = await harness(); const p = await h.transport.preview(h.file); const receipt = await h.transport.confirm(p.id); h.storage.removeItem("alfred-privacy");
    await expect(h.transport.undo(receipt.id)).rejects.toThrow("changed"); expect(h.base.undo).not.toHaveBeenCalled(); expect(h.storage.getItem("alfred-privacy")).toBeNull();
  });
  it("keeps financial undo success visible if later preference restoration fails", async () => {
    const h = await harness(); const p = await h.transport.preview(h.file); const receipt = await h.transport.confirm(p.id); h.failHome("before");
    const result = await h.transport.undo(receipt.id);
    expect(result.undoneAt).toBe(NOW); expect(result.browserPreferences?.status).toBe("partial"); expect(result.browserPreferences?.warnings[0]).toContain("Finance import was undone");
  });
  it("does not overwrite a browser edit made while finance undo was in flight", async () => {
    const h = await harness(); const p = await h.transport.preview(h.file); const receipt = await h.transport.confirm(p.id);
    h.base.undo.mockImplementation(async () => { h.storage.removeItem("alfred-appearance"); return { id: receipt.id, undoneAt: NOW, undoAvailable: false }; });
    const result = await h.transport.undo(receipt.id);
    expect(result.browserPreferences?.status).toBe("partial"); expect(h.storage.getItem("alfred-appearance")).toBeNull(); expect(h.storage.getItem("alfred-privacy")).toBe("masked");
  });
  it("retains an uncertain finance outcome across reload without applying preferences", async () => {
    const h = await harness(); const p = await h.transport.preview(h.file); h.base.confirm.mockRejectedValueOnce(new Error("Connection lost"));
    await expect(h.transport.confirm(p.id)).rejects.toThrow("Connection lost");
    const reloaded = withBrowserPreferences(h.base, h.env); const receipts = await reloaded.receipts();
    expect(receipts[0].id).toBe(h.receipt.id); expect(receipts[0].browserPreferences?.status).toBe("unknown"); expect(receipts[0].undoAvailable).toBe(false); expect(h.presented).toHaveLength(0);
    // Retrying the original staged preview can confirm the idempotent finance result and then apply once.
    const recovered = await h.transport.confirm(p.id); expect(recovered.browserPreferences?.status).toBe("applied"); expect(h.presented).toHaveLength(1);
  });
  it("merges only exact server receipt identities and never invents receipts from device storage", async () => {
    const h = await harness(); const p = await h.transport.preview(h.file); await h.transport.confirm(p.id);
    h.base.receipts.mockResolvedValueOnce([{ ...h.receipt, id: "different-owner-server-receipt", archiveId: "different-archive" }]);
    const list = await withBrowserPreferences(h.base, h.env).receipts(); expect(list).toHaveLength(1); expect(list[0].id).toBe("different-owner-server-receipt"); expect(list[0].browserPreferences).toBeUndefined();
    h.base.receipts.mockResolvedValueOnce([]); expect(await withBrowserPreferences(h.base, h.env).receipts()).toEqual([]);
  });
  it("does not restore device preferences automatically after an undo from another device", async () => {
    const h = await harness(); const p = await h.transport.preview(h.file); await h.transport.confirm(p.id); h.receipt.undoneAt = NOW; h.receipt.undoAvailable = false;
    const receipt = (await withBrowserPreferences(h.base, h.env).receipts())[0]; expect(receipt.browserPreferences?.status).toBe("partial"); expect(h.getHome()).toBe("overview");
  });
  it("holds the shared lock across finance confirmation and preference writes so a normal toggle runs afterward", async () => {
    const names = installQueuedLocks(); const h = await harness(); h.env.lockingAvailable = browserPreferenceLocksAvailable; h.env.withLock = serializeBrowserPreferenceWrite;
    let release!: () => void, reached!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }), started = new Promise<void>((resolve) => { reached = resolve; });
    h.base.confirm.mockImplementation(async () => { reached(); await gate; return { ...h.receipt }; });
    const p = await h.transport.preview(h.file), importing = h.transport.confirm(p.id); await started;
    let toggled = false;
    const toggle = serializeBrowserPreferenceWrite(() => { toggled = true; h.storage.setItem("alfred-appearance", "light"); });
    expect(toggled).toBe(false); release(); const receipt = await importing; await toggle;
    expect(receipt.browserPreferences?.status).toBe("applied"); expect(toggled).toBe(true); expect(h.storage.getItem("alfred-appearance")).toBe("light");
    await expect(h.transport.undo(receipt.id)).rejects.toThrow("changed"); expect(h.base.undo).not.toHaveBeenCalled(); expect(names.every((name) => name === BROWSER_PREFERENCES_LOCK)).toBe(true);
  });
  it("serializes a home-screen writer after complete undo, preserving the person's later choice", async () => {
    installQueuedLocks(); const h = await harness(); h.env.withLock = serializeBrowserPreferenceWrite;
    const p = await h.transport.preview(h.file), receipt = await h.transport.confirm(p.id);
    let release!: () => void, reached!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }), started = new Promise<void>((resolve) => { reached = resolve; });
    h.base.undo.mockImplementation(async () => { reached(); await gate; return { id: receipt.id, undoneAt: NOW, undoAvailable: false }; });
    const undoing = h.transport.undo(receipt.id); await started;
    let changed = false; const homeWriter = serializeBrowserPreferenceWrite(async () => { changed = true; await h.env.writeHome("overview", "chat"); });
    expect(changed).toBe(false); release(); await undoing; await homeWriter; expect(h.getHome()).toBe("overview");
  });
  it("does not apply twice when two confirmations were queued together", async () => {
    installQueuedLocks(); const h = await harness(); h.env.withLock = serializeBrowserPreferenceWrite;
    const p = await h.transport.preview(h.file); const results = await Promise.all([h.transport.confirm(p.id), h.transport.confirm(p.id)]);
    expect(results.map((receipt) => receipt.browserPreferences?.status)).toEqual(["applied", "applied"]); expect(h.presented).toHaveLength(1);
  });
  it("preserves preferences and permits finance import and undo when Web Locks are unavailable", async () => {
    const h = await harness(); h.env.lockingAvailable = () => false;
    const p = await h.transport.preview(h.file); expect(p.canConfirm).toBe(true); expect(p.browserPreferences).toMatchObject({ status: "preserved", changes: [], conflicts: [] });
    expect(p.coverage.find((row) => row.dataset === BROWSER_PREFERENCES_DATASET)?.status).toBe("preserved");
    const receipt = await h.transport.confirm(p.id); expect(receipt.browserPreferences?.status).toBe("preserved"); expect(h.presented).toHaveLength(0); expect(h.getHome()).toBe("chat");
    await h.transport.undo(receipt.id); expect(h.base.undo).toHaveBeenCalledOnce();
    const blocked = await harness(); blocked.env.lockingAvailable = () => false; blocked.storage.blocked = true;
    const q = await blocked.transport.preview(blocked.file); expect(q.canConfirm).toBe(true); expect((await blocked.transport.confirm(q.id)).browserPreferences?.status).toBe("preserved");
  });
  it("keeps ordinary settings usable without Web Locks while export still includes typed preferences", async () => {
    vi.stubGlobal("navigator", {}); expect(browserPreferenceLocksAvailable()).toBe(false);
    let ran = false; await serializeBrowserPreferenceWrite(() => { ran = true; }); expect(ran).toBe(true);
    expect(browserPreferenceExportQuery(new MemoryStorage())).toBe("appearance=light&privacy=visible");
  });
  it("allows finance export with explicit unavailable-browser coverage when storage is blocked", () => {
    expect(availableBrowserPreferenceExportQuery(() => { throw new Error("Storage blocked"); })).toBe("");
    const storage = new MemoryStorage(); storage.blocked = true;
    expect(availableBrowserPreferenceExportQuery(() => storage)).toBe("");
  });
  it("rejects an unsaved visible preference rather than overwriting the person's current choice", async () => {
    const h = await harness(); h.env.visiblePreferences = () => ({ appearance: "dark", privacy: "visible" });
    await expect(h.transport.preview(h.file)).rejects.toThrow("visible device preferences differ"); expect(h.base.preview).not.toHaveBeenCalled();
  });
});
