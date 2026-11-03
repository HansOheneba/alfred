import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/chat/empty/route";

const mocks = vi.hoisted(() => ({
  connection: vi.fn(),
  owner: vi.fn(),
  empty: vi.fn(),
  ledger: vi.fn(),
  transactions: vi.fn(),
  network: vi.fn(),
}));
vi.mock("next/server", () => ({ connection: mocks.connection }));
vi.mock("@/lib/web/api", () => ({ requireOwner: mocks.owner }));
vi.mock("@/lib/web/finance-empty", () => ({ financeLooksEmpty: mocks.empty }));
vi.mock("@/lib/web/ledger", () => ({ loadLedger: mocks.ledger }));
vi.mock("@/lib/log", () => ({ logError: vi.fn() }));

const ownerId = "00000000-0000-4000-8000-000000000001";
const settings = { supabase: { projectRef: "synthetic-empty-status-only" } };
const owner = { profile: { profileId: ownerId }, settings, store: { listTransactions: mocks.transactions } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connection.mockResolvedValue(undefined);
  mocks.owner.mockResolvedValue(owner);
  mocks.empty.mockResolvedValue(true);
  mocks.network.mockImplementation(() => { throw new Error("Synthetic route must not contact a network service"); });
  vi.stubGlobal("fetch", mocks.network);
});

afterEach(() => {
  expect(mocks.ledger).not.toHaveBeenCalled();
  expect(mocks.transactions).not.toHaveBeenCalled();
  expect(mocks.network).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("cheap authenticated Chat empty status", () => {
  it.each([401, 403])("forwards authentication status %s without reading financial sources", async status => {
    const auth = Response.json({ ok: false, text: "Sign in first." }, { status });
    mocks.owner.mockResolvedValue(auth);
    const response = await GET();
    expect(response).toBe(auth);
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.empty).not.toHaveBeenCalled();
  });

  it.each([true, false])("returns the cheap check's %s result with the authenticated owner stamp", async financialsEmpty => {
    mocks.empty.mockResolvedValue(financialsEmpty);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, ownerId, financialsEmpty });
    expect(mocks.connection).toHaveBeenCalledExactlyOnceWith();
    expect(mocks.owner).toHaveBeenCalledExactlyOnceWith();
    expect(mocks.empty).toHaveBeenCalledExactlyOnceWith(settings.supabase, ownerId);
    expect(mocks.connection.mock.invocationCallOrder[0]).toBeLessThan(mocks.owner.mock.invocationCallOrder[0]);
  });

  it("uses a newly authenticated session owner rather than retaining a prior caller", async () => {
    const nextId = "00000000-0000-4000-8000-000000000002";
    mocks.owner.mockResolvedValue({ ...owner, profile: { profileId: nextId } });
    const response = await GET();
    expect(await response.json()).toEqual({ ok: true, ownerId: nextId, financialsEmpty: true });
    expect(mocks.empty).toHaveBeenCalledExactlyOnceWith(settings.supabase, nextId);
  });

  it("returns an honest error without inventing an empty or nonempty account when the check fails", async () => {
    mocks.empty.mockRejectedValue(new Error("synthetic internal database failure"));
    const response = await GET();
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toEqual({ ok: false, text: "Your account status could not be checked. Try again." });
    expect(body).not.toHaveProperty("financialsEmpty");
    expect(JSON.stringify(body)).not.toContain("database failure");
  });

  it("leaves framework request-time cancellation outside the route error handler", async () => {
    const cancellation = new Error("synthetic prerender cancellation");
    mocks.connection.mockRejectedValue(cancellation);
    await expect(GET()).rejects.toBe(cancellation);
    expect(mocks.owner).not.toHaveBeenCalled();
    expect(mocks.empty).not.toHaveBeenCalled();
  });
});
