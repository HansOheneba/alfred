import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Ledger } from "@/lib/web/ledger";
import { GET as ledgerGet } from "@/app/api/settings/ledger/route";
import { GET as telegramGet } from "@/app/api/settings/telegram/route";
import { loadOwnedSettingsData } from "@/app/settings/lazy-settings-data";

const mocks = vi.hoisted(() => ({ requireOwner: vi.fn(), loadLedger: vi.fn(), username: vi.fn() }));
vi.mock("@/lib/web/api", () => ({ requireOwner: mocks.requireOwner }));
vi.mock("@/lib/web/ledger", () => ({ loadLedger: mocks.loadLedger }));
vi.mock("@/lib/telegram/bot-info", () => ({ telegramBotUsername: mocks.username }));
vi.mock("next/server", () => ({ connection: vi.fn(async () => undefined) }));
const ledger: Ledger = { today: "2003-06-04", currency: "GHS", rows: [], budgets: [], goals: [], insights: [], owed: [], owe: [], bank: { connected: false, lastUsedAt: null, lastEmptyAt: null, accountNames: [], needsLabel: [], balances: [] } };
const owner = (id: string) => ({ profile: { profileId: id }, settings: { fixture: id } });

describe("deferred Settings reads", () => {
  beforeEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); });

  it("requires a session before either resource is loaded and prevents caching errors", async () => {
    mocks.requireOwner.mockImplementation(async () => Response.json({ ok: false, text: "Sign in first." }, { status: 401 }));
    for (const get of [ledgerGet, telegramGet]) {
      const response = await get();
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.loadLedger).not.toHaveBeenCalled(); expect(mocks.username).not.toHaveBeenCalled();
  });

  it("keeps successive owners isolated with a fresh session-derived read", async () => {
    mocks.loadLedger.mockResolvedValue(ledger);
    for (const id of ["owner-a", "owner-b"]) {
      const current = owner(id); mocks.requireOwner.mockResolvedValue(current);
      const response = await ledgerGet();
      expect(await response.json()).toEqual({ ok: true, ownerId: id, ledger });
      expect(mocks.loadLedger).toHaveBeenLastCalledWith(current.profile, current.settings);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.loadLedger).toHaveBeenCalledTimes(2);
  });

  it("does not replace a failed coherent financial read with an empty or older ledger", async () => {
    mocks.requireOwner.mockResolvedValue(owner("owner-a"));
    mocks.loadLedger.mockRejectedValue(new Error("source version changed; private details"));
    const response = await ledgerGet(), body = await response.json();
    expect(response.status).toBe(500); expect(body.ok).toBe(false); expect(body.ledger).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("private details");
  });

  it("reads only public bot details for the authenticated owner", async () => {
    mocks.requireOwner.mockResolvedValue(owner("owner-a")); mocks.username.mockResolvedValue("sample_bot");
    const response = await telegramGet(); expect(await response.json()).toEqual({ ok: true, ownerId: "owner-a", botUsername: "sample_bot" });
    expect(mocks.loadLedger).not.toHaveBeenCalled();
  });

  it("rejects a late response from a different session before exposing its financial data", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ ok: true, ownerId: "owner-b", ledger })); vi.stubGlobal("fetch", fetcher);
    await expect(loadOwnedSettingsData("/api/settings/ledger", "ledger", "owner-a", new AbortController().signal)).rejects.toThrow("session changed");
    expect(fetcher.mock.calls[0][1]).toMatchObject({ cache: "no-store", credentials: "same-origin" });
  });

  it("loads a valid empty ledger without inventing data and preserves unknown bot configuration", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => Response.json({ ok: true, ownerId: "owner-a", ...(url.endsWith("ledger") ? { ledger } : { botUsername: null }) })));
    expect(await loadOwnedSettingsData("/api/settings/ledger", "ledger", "owner-a", new AbortController().signal)).toEqual(ledger);
    expect(await loadOwnedSettingsData("/api/settings/telegram", "botUsername", "owner-a", new AbortController().signal)).toBeNull();
  });

  it.each([null, {}, { rows: [], budgets: [], goals: [] }])("fails closed for a malformed ledger: %j", async (invalid) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true, ownerId: "owner-a", ledger: invalid })));
    await expect(loadOwnedSettingsData("/api/settings/ledger", "ledger", "owner-a", new AbortController().signal)).rejects.toThrow("could not be loaded");
  });

  it("allows aborting obsolete section reads", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))))));
    const pending = loadOwnedSettingsData("/api/settings/ledger", "ledger", "owner-a", controller.signal);
    controller.abort(); await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
