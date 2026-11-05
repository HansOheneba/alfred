import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Ledger } from "@/lib/web/ledger";
import { GET as ledgerGet } from "@/app/api/settings/ledger/route";
import { GET as telegramGet } from "@/app/api/settings/telegram/route";
import { loadOwnedSettingsData } from "@/app/settings/lazy-settings-data";

const mocks = vi.hoisted(() => ({ requireOwner: vi.fn(), loadLedger: vi.fn(), loadBudgets: vi.fn(), loadGoals: vi.fn(), loadBank: vi.fn(), username: vi.fn() }));
vi.mock("@/lib/web/api", () => ({ requireOwner: mocks.requireOwner }));
vi.mock("@/lib/web/ledger", () => ({ loadLedger: mocks.loadLedger }));
vi.mock("@/lib/web/secondary-read-models", () => ({ loadSettingsBudgets: mocks.loadBudgets, loadSettingsGoals: mocks.loadGoals, loadSettingsBank: mocks.loadBank }));
vi.mock("@/lib/telegram/bot-info", () => ({ telegramBotUsername: mocks.username }));
vi.mock("next/server", () => ({ connection: vi.fn(async () => undefined) }));
const ledger: Ledger = { today: "2003-06-04", currency: "GHS", rows: [], budgets: [], goals: [], insights: [], owed: [], owe: [], bank: { connected: false, lastUsedAt: null, lastEmptyAt: null, accountNames: [], needsLabel: [], balances: [] } };
const budgets = { today: ledger.today, currency: ledger.currency, budgets: ledger.budgets };
const resourceRequest = (section: string) => new Request(`https://fictional.invalid/api/settings/ledger?section=${section}`);
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
    mocks.loadBudgets.mockResolvedValue(budgets);
    for (const id of ["owner-a", "owner-b"]) {
      const current = owner(id); mocks.requireOwner.mockResolvedValue(current);
      const response = await ledgerGet(resourceRequest("budgets"));
      expect(await response.json()).toEqual({ ok: true, ownerId: id, budgets });
      expect(mocks.loadBudgets).toHaveBeenLastCalledWith(current.profile, current.settings);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.loadBudgets).toHaveBeenCalledTimes(2);
    expect(mocks.loadLedger).not.toHaveBeenCalled();
  });

  it("does not replace a failed coherent financial read with an empty or older ledger", async () => {
    mocks.requireOwner.mockResolvedValue(owner("owner-a"));
    mocks.loadBudgets.mockRejectedValue(new Error("source version changed; private details"));
    const response = await ledgerGet(resourceRequest("budgets")), body = await response.json();
    expect(response.status).toBe(500); expect(body.ok).toBe(false); expect(body.ledger).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("private details");
  });

  it.each(["goals", "bank"])("loads only the selected %s resource", async section => {
    mocks.requireOwner.mockResolvedValue(owner("owner-a"));
    const data = section === "goals" ? { currency: ledger.currency, goals: [] } : { currency: ledger.currency, bank: ledger.bank };
    const selected = section === "goals" ? mocks.loadGoals : mocks.loadBank;
    selected.mockResolvedValue(data);
    const response = await ledgerGet(resourceRequest(section));
    expect(await response.json()).toEqual({ ok: true, ownerId: "owner-a", [section]: data });
    expect(selected).toHaveBeenCalledOnce(); expect(mocks.loadLedger).not.toHaveBeenCalled(); expect(mocks.loadBudgets).not.toHaveBeenCalled();
  });

  it.each(["", "transactions", "all"])("rejects an unsupported section without a finance read (%s)", async section => {
    mocks.requireOwner.mockResolvedValue(owner("owner-a"));
    expect((await ledgerGet(resourceRequest(section))).status).toBe(400);
    expect(mocks.loadLedger).not.toHaveBeenCalled(); expect(mocks.loadBudgets).not.toHaveBeenCalled(); expect(mocks.loadGoals).not.toHaveBeenCalled(); expect(mocks.loadBank).not.toHaveBeenCalled();
  });

  it.each([
    ["budgets", { today: ledger.today, currency: ledger.currency, budgets: [] }],
    ["goals", { currency: ledger.currency, goals: [] }],
    ["bank", { currency: ledger.currency, bank: ledger.bank }],
  ] as const)("validates the compact %s resource with owner/session guards", async (section, data) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true, ownerId: "owner-a", [section]: data })));
    expect(await loadOwnedSettingsData(`/api/settings/ledger?section=${section}`, section, "owner-a", new AbortController().signal)).toEqual(data);
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
