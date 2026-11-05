import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ owner: vi.fn(), page: vi.fn() }));
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("@/lib/web/api", () => ({ requireOwner: mocks.owner }));
vi.mock("@/lib/web/overview", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/web/overview")>(), loadOverviewTransactionPage: mocks.page }));
import { GET } from "@/app/api/overview/transactions/route";
import { InvalidOverviewPage, OverviewChanged } from "@/lib/web/overview";
import { OverviewReadChanged, readOverviewTransactions } from "@/app/dashboard/overview-transaction-data";
import { overviewTransactionQueryKey, type OverviewTransactionPage, type OverviewTransactionQuery } from "@/lib/web/overview-transactions";

const query: OverviewTransactionQuery = { preset: "this_month", category: null, filters: { search: "", type: "all", category: "all", sort: "date-desc" } };
const page: OverviewTransactionPage = { rows: [], total: 0, categories: ["Food"], version: "a".repeat(64), queryKey: overviewTransactionQueryKey(query), nextCursor: null };
const config = { ownerId: "fictional-owner", initialPage: page };
const success = (patch = {}) => Response.json({ ok: true, ownerId: config.ownerId, page, ...patch });
beforeEach(() => {
  mocks.owner.mockResolvedValue({ profile: { profileId: config.ownerId }, settings: { supabase: {} } });
  mocks.page.mockResolvedValue(page);
});
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });

describe("authenticated read-only Overview page API", () => {
  it("stamps the authenticated owner and prevents shared caching", async () => {
    const response = await GET(new Request("https://fictional.invalid/api/overview/transactions"));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true, ownerId: config.ownerId, page });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(mocks.page).toHaveBeenCalledWith({ profileId: config.ownerId }, { supabase: {} }, query, null);
  });
  it("requires authentication before reading any financial data", async () => {
    mocks.owner.mockResolvedValue(Response.json({ ok: false }, { status: 401 }));
    expect((await GET(new Request("https://fictional.invalid/api/overview/transactions"))).status).toBe(401);
    expect(mocks.page).not.toHaveBeenCalled();
  });
  it.each(["ownerId=foreign", "range=all&range=this_month", "tx_type=transfer", "tx_sort=wrong"])("rejects unsupported or duplicate filters %s before loading", async input => {
    expect((await GET(new Request(`https://fictional.invalid/api/overview/transactions?${input}`))).status).toBe(400);
    expect(mocks.page).not.toHaveBeenCalled();
  });
  it.each([[new InvalidOverviewPage(), 400], [new OverviewChanged(), 409], [new Error("fictional database detail"), 503]])("handles invalid/stale/unavailable reads without exposing storage details", async (error, status) => {
    mocks.page.mockRejectedValue(error);
    const response = await GET(new Request("https://fictional.invalid/api/overview/transactions"));
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body.ok).toBe(false); expect(JSON.stringify(body)).not.toContain("fictional database detail");
    expect(body.stale).toBe(status === 409 ? true : undefined);
  });
});

describe("bounded owner-stamped Overview transaction reads", () => {
  it("uses GET only and verifies owner, query and accounting version before returning rows", async () => {
    const request = vi.fn(async () => success());
    await expect(readOverviewTransactions(config, query, "fictional-cursor", new AbortController().signal, request)).resolves.toEqual(page);
    expect(request).toHaveBeenCalledOnce();
    const [url, options] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url, "https://fictional.invalid").searchParams.get("cursor")).toBe("fictional-cursor");
    expect(options).toMatchObject({ method: "GET", credentials: "same-origin", cache: "no-store" });
  });
  it.each([
    [{ ownerId: "other-fictional-owner" }, "signed-in account changed"],
    [{ page: { ...page, queryKey: "different-query" } }, "could not be verified"],
    [{ page: { ...page, rows: Array.from({ length: 16 }, () => ({})) } }, "could not be verified"],
    [{ page: { ...page, version: "b".repeat(64) } }, "financial records changed"],
  ])("rejects changed-session or unverified payloads", async (patch, message) => {
    await expect(readOverviewTransactions(config, query, null, new AbortController().signal, async () => success(patch))).rejects.toThrow(message);
  });
  it("requires a refresh for a server-side source change without automatically retrying", async () => {
    const request = vi.fn(async () => Response.json({ ok: false, stale: true }, { status: 409 }));
    await expect(readOverviewTransactions(config, query, null, new AbortController().signal, request)).rejects.toBeInstanceOf(OverviewReadChanged);
    expect(request).toHaveBeenCalledOnce();
  });
  it("bounds a stalled response body and cancels the transport after 20 seconds", async () => {
    vi.useFakeTimers(); let transport: AbortSignal | undefined;
    const request = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      transport = init?.signal ?? undefined;
      return { ok: true, status: 200, json: () => new Promise(() => undefined) } as unknown as Response;
    });
    const pending = readOverviewTransactions(config, query, null, new AbortController().signal, request);
    const rejection = expect(pending).rejects.toThrow("took too long");
    await vi.advanceTimersByTimeAsync(20_000); await rejection;
    expect(transport?.aborted).toBe(true); expect(request).toHaveBeenCalledOnce();
  });
  it("cancels obsolete reads even when the transport ignores abort", async () => {
    const controller = new AbortController();
    let resolve!: (response: Response) => void;
    const pending = readOverviewTransactions(config, query, null, controller.signal, () => new Promise(done => { resolve = done; }));
    const rejection = expect(pending).rejects.toThrow("cancelled");
    controller.abort(); await rejection; resolve(success());
    await Promise.resolve();
  });
});
