import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshPrices, US_CALLS_PER_RUN } from "@/lib/investments/prices";
import { MemoryInvestmentStore } from "@/lib/investments/store";

vi.mock("@/lib/log", () => ({ logError: vi.fn() }));
const TODAY = "2026-11-05";
const AT = Date.parse(`${TODAY}T12:00:00.000Z`);
const only = [{ market: "gse" as const, symbol: "MTNGH" }, ...["AAA", "BBB", "CCC", "DDD", "EEE"].map(symbol => ({ market: "us" as const, symbol }))];
const wait = () => new Promise(resolve => setTimeout(resolve, 1000));
const ticker = (url: string) => decodeURIComponent(url).match(/\/ticker\/([^/]+)/)?.[1] ?? "";
afterEach(() => vi.useRealTimers());

describe("independent investment price feed loading", () => {
  it("loads FX and GSE alongside the sequential capped US group, reducing the six-response path from six to four simulated seconds", async () => {
    vi.useFakeTimers(); vi.setSystemTime(AT);
    const store = new MemoryInvestmentStore();
    let usActive = 0, maxUsActive = 0;
    const calls: { key: string; at: number }[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input), key = ticker(url), isUs = key && key !== "C:USDGHS";
      calls.push({ key: key || "gse", at: Date.now() - AT });
      if (isUs) { usActive++; maxUsActive = Math.max(maxUsActive, usActive); }
      await wait();
      if (isUs) usActive--;
      return url.includes("gse/live") ? Response.json([{ name: "MTNGH", price: 3.1 }, { name: "UNHELD", price: 8 }])
        : Response.json({ results: [{ c: key === "C:USDGHS" ? 10 : 100, t: AT }] });
    });
    const loaded = refreshPrices(store, { key: "synthetic-key", today: TODAY, only, fetchImpl: fetchImpl as typeof fetch });
    await vi.runAllTimersAsync();
    expect(await loaded).toEqual({ saved: 6 });
    expect(Date.now() - AT).toBe(4000);
    expect(calls.slice(0, 3)).toEqual([{ key: "C:USDGHS", at: 0 }, { key: "gse", at: 0 }, { key: "AAA", at: 0 }]);
    expect(calls.filter(call => ["AAA", "BBB", "CCC", "DDD", "EEE"].includes(call.key)).map(call => call.key)).toEqual(["AAA", "BBB", "CCC", "DDD"]);
    expect(maxUsActive).toBe(1);
    expect(calls.filter(call => call.key !== "gse")).toHaveLength(US_CALLS_PER_RUN + 1);
    expect(store.priceRows.some(price => price.symbol === "UNHELD")).toBe(false);
    expect(store.priceRows.find(price => price.symbol === "USDGHS")?.price).toBe(10);
  });

  it("preserves the validated free FX fallback and saves healthy feeds when other responses are invalid", async () => {
    vi.useFakeTimers(); vi.setSystemTime(AT);
    const store = new MemoryInvestmentStore();
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input), key = ticker(url);
      await wait();
      if (key === "C:USDGHS") return new Response("", { status: 503 });
      if (url.includes("er-api")) return Response.json({ result: "success", time_last_update_unix: AT / 1000, rates: { GHS: 11 } });
      if (url.includes("gse/live") || key === "AAA") return Response.json({ invalid: true });
      return Response.json({ results: [{ c: 100, t: AT }] });
    });
    const loaded = refreshPrices(store, { key: "synthetic-key", today: TODAY, only, fetchImpl: fetchImpl as typeof fetch });
    await vi.runAllTimersAsync();
    expect(await loaded).toEqual({ saved: 4 });
    expect(Date.now() - AT).toBe(4000);
    expect(store.priceRows.map(price => price.symbol).sort()).toEqual(["BBB", "CCC", "DDD", "USDGHS"]);
    expect(store.priceRows.find(price => price.symbol === "USDGHS")?.price).toBe(11);
    expect(fetchImpl).toHaveBeenCalledTimes(7);
  });
});
