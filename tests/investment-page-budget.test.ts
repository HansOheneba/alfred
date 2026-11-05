import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPortfolioDetails } from "@/lib/investments/actions";
import { MemoryInvestmentStore } from "@/lib/investments/store";
import { includedAccountCash } from "@/lib/finance/accounting/cash-summary";
import { InvestmentAssetsSummary } from "@/app/investments/investments-client";

vi.mock("@/lib/log", () => ({ logError: vi.fn() }));
vi.mock("@/lib/investments/prices", async original => ({ ...await original<typeof import("@/lib/investments/prices")>(), massiveKey: () => "synthetic-key" }));
const TODAY = "2026-11-05", AT = Date.parse(`${TODAY}T12:00:00Z`), OWNER = "fictional-owner";
const ticker = (url: string) => decodeURIComponent(url).match(/\/ticker\/([^/]+)/)?.[1] ?? "";
const quote = (price: number) => Response.json({ results: [{ c: price, t: AT }] });
afterEach(() => vi.useRealTimers());

async function unpricedStocks() {
  const store = new MemoryInvestmentStore();
  const investment = await store.create(OWNER, { name: "Fictional shares", kind: "us_stocks", currency: "USD" });
  await store.setHoldings(OWNER, investment.id, ["AAA", "BBB", "CCC", "DDD"].map(symbol => ({ symbol, quantity: 1 })));
  return store;
}

describe("page-only missing quote wait", () => {
  it("settles hanging quote fetches at the page budget without changing known or unknown valuation metadata", async () => {
    vi.useFakeTimers(); vi.setSystemTime(AT);
    const store = await unpricedStocks();
    const known = await store.create(OWNER, { name: "Fictional reported fund", kind: "mutual_fund", currency: "GHS" });
    await store.addValue(OWNER, known.id, "500.00", "2026-09-01T12:00:00.000Z", "reported");
    const gse = await store.create(OWNER, { name: "Fictional GSE shares", kind: "gse_stocks", currency: "GHS" });
    await store.setHoldings(OWNER, gse.id, [{ symbol: "MTNGH", quantity: 1 }]);
    await store.savePrices([{ market: "gse", symbol: "MTNGH", price: 3.1, currency: "GHS", asOf: "2026-10-01" }]);
    const missingGse = await store.create(OWNER, { name: "Unpriced fictional GSE shares", kind: "gse_stocks", currency: "GHS" });
    await store.setHoldings(OWNER, missingGse.id, [{ symbol: "UNPRICED", quantity: 1 }]);
    const writes = [vi.spyOn(store, "create"), vi.spyOn(store, "update"), vi.spyOn(store, "addValue"), vi.spyOn(store, "addContribution"), vi.spyOn(store, "setHoldings")];
    const cache = vi.spyOn(store, "savePrices");
    const signals: AbortSignal[] = [];
    const fetchImpl = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init!.signal!; signals.push(signal);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    let settled = false;
    const pending = loadPortfolioDetails(store, OWNER, TODAY, { fetchMissing: true, fetchImpl: fetchImpl as typeof fetch, missingPriceBudgetMs: 2000 }).then(value => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(1999); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const { portfolio } = await pending;
    expect(Date.now() - AT).toBe(2000);
    expect(signals).toHaveLength(3); expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // FX, GSE and first US; later symbols never start.
    expect(vi.getTimerCount()).toBe(0);
    expect(portfolio.items[0]).toMatchObject({ value: null, valueGhs: null, source: null, asOf: null });
    expect(portfolio.items[0].holdings.every(holding => holding.price === null && holding.value === null)).toBe(true);
    expect(portfolio.items[1]).toMatchObject({ value: 500, source: "reported", asOf: "2026-09-01T12:00:00.000Z", stale: true });
    expect(portfolio.items[2]).toMatchObject({ value: 3.1, source: "prices", asOf: "2026-10-01", stale: true });
    expect(portfolio.items[2].holdings[0]).toMatchObject({ price: 3.1, priceAsOf: "2026-10-01" });
    expect(portfolio.totalGhs).toBe(503.1);
    const html = renderToStaticMarkup(createElement(InvestmentAssetsSummary, { cash: includedAccountCash(null, "GHS"), portfolio }));
    expect(html).toContain("Total unavailable"); expect(html).toContain("Known investment values");
    expect(cache).not.toHaveBeenCalled(); for (const write of writes) expect(write).not.toHaveBeenCalled();
  });

  it("awaits caching completed quotes and ignores a network response that arrives after cancellation", async () => {
    vi.useFakeTimers(); vi.setSystemTime(AT);
    const store = await unpricedStocks(), savePrices = store.savePrices.bind(store);
    let completeCacheSave!: () => void;
    const cache = vi.spyOn(store, "savePrices").mockImplementation(async prices => {
      await new Promise<void>(resolve => { completeCacheSave = resolve; });
      await savePrices(prices);
    });
    let lateResponse!: (response: Response) => void;
    const calls: string[] = [], signals: AbortSignal[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const key = ticker(String(input)); calls.push(key); signals.push(init!.signal!);
      if (key === "BBB") return new Promise<Response>(resolve => { lateResponse = resolve; });
      await new Promise(resolve => setTimeout(resolve, 100));
      return quote(key === "C:USDGHS" ? 10 : 100);
    });
    let settled = false;
    const pending = loadPortfolioDetails(store, OWNER, TODAY, { fetchMissing: true, fetchImpl: fetchImpl as typeof fetch, missingPriceBudgetMs: 2000 }).then(value => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(2000);
    expect(settled).toBe(false); // The remote budget never detaches the accepted cache write.
    expect(cache).toHaveBeenCalledOnce(); completeCacheSave();
    const loaded = await pending;
    expect(calls).toEqual(["C:USDGHS", "AAA", "BBB"]);
    expect(cache).toHaveBeenCalledOnce(); expect(store.priceRows.map(price => price.symbol).sort()).toEqual(["AAA", "USDGHS"]);
    expect(loaded.portfolio.items[0].holdings[0]).toMatchObject({ symbol: "AAA", price: 100, value: 100, priceAsOf: TODAY });
    expect(loaded.portfolio.items[0].value).toBeNull();
    lateResponse(quote(999));
    await vi.advanceTimersByTimeAsync(10000);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(cache).toHaveBeenCalledOnce(); expect(calls).toEqual(["C:USDGHS", "AAA", "BBB"]);
    expect(store.priceRows.some(price => price.symbol === "BBB")).toBe(false);
  });

  it("also bounds response-body waits, keeping late body data out of the price cache", async () => {
    vi.useFakeTimers(); vi.setSystemTime(AT);
    const store = await unpricedStocks(), cache = vi.spyOn(store, "savePrices");
    const lateBodies: ((value: unknown) => void)[] = [];
    const fetchImpl = vi.fn(async () => ({ ok: true, json: () => new Promise(resolve => { lateBodies.push(resolve); }) }) as Response);
    const pending = loadPortfolioDetails(store, OWNER, TODAY, { fetchMissing: true, fetchImpl: fetchImpl as typeof fetch, missingPriceBudgetMs: 2000 });
    await vi.advanceTimersByTimeAsync(2000);
    expect((await pending).portfolio.items[0].value).toBeNull();
    for (const lateBody of lateBodies) lateBody({ results: [{ c: 999, t: AT }] }); await vi.advanceTimersByTimeAsync(10000);
    expect(cache).not.toHaveBeenCalled(); expect(store.priceRows).toEqual([]);
  });

  it("shares the original deadline with the FX fallback instead of granting it another wait window", async () => {
    vi.useFakeTimers(); vi.setSystemTime(AT);
    const store = await unpricedStocks(), cache = vi.spyOn(store, "savePrices");
    const signals: AbortSignal[] = [], calls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); calls.push(ticker(url) || "free-fx"); signals.push(init!.signal!);
      if (ticker(url) === "C:USDGHS") {
        await new Promise(resolve => setTimeout(resolve, 1500));
        return new Response("", { status: 503 });
      }
      return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }));
    });
    const pending = loadPortfolioDetails(store, OWNER, TODAY, { fetchMissing: true, fetchImpl: fetchImpl as typeof fetch, missingPriceBudgetMs: 2000 });
    await vi.advanceTimersByTimeAsync(2000);
    expect((await pending).portfolio.items[0].value).toBeNull();
    expect(Date.now() - AT).toBe(2000);
    expect(calls).toEqual(["C:USDGHS", "AAA", "free-fx"]);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(cache).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the existing complete missing-price behavior when callers omit the page budget", async () => {
    vi.useFakeTimers(); vi.setSystemTime(AT);
    const store = await unpricedStocks();
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      await new Promise(resolve => setTimeout(resolve, 1000));
      return quote(ticker(String(input)) === "C:USDGHS" ? 10 : 100);
    });
    let settled = false;
    const pending = loadPortfolioDetails(store, OWNER, TODAY, { fetchMissing: true, fetchImpl: fetchImpl as typeof fetch }).then(value => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(2000); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect((await pending).portfolio.items[0]).toMatchObject({ value: 400, valueGhs: 4000, source: "prices", asOf: TODAY, stale: false });
    expect(Date.now() - AT).toBe(4000); expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it("reduces a modeled forty-second timeout chain to the page's two-second quote wait", async () => {
    vi.useFakeTimers(); vi.setSystemTime(AT);
    const fetchImpl = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init!.signal!;
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); reject(new Error("Synthetic ten-second upstream timeout")); }, 10000);
      signal.addEventListener("abort", abort, { once: true });
    }));
    const ordinary = loadPortfolioDetails(await unpricedStocks(), OWNER, TODAY, { fetchMissing: true, fetchImpl: fetchImpl as typeof fetch });
    await vi.runAllTimersAsync();
    expect((await ordinary).portfolio.items[0].value).toBeNull();
    expect(Date.now() - AT).toBe(40000); expect(fetchImpl).toHaveBeenCalledTimes(5);
    vi.setSystemTime(AT); fetchImpl.mockClear();
    const page = loadPortfolioDetails(await unpricedStocks(), OWNER, TODAY, { fetchMissing: true, fetchImpl: fetchImpl as typeof fetch, missingPriceBudgetMs: 2000 });
    await vi.runAllTimersAsync();
    expect((await page).portfolio.items[0].value).toBeNull();
    expect(Date.now() - AT).toBe(2000); expect(fetchImpl).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });
});
