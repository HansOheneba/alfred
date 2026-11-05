import { z } from "zod";

import type { InvestmentStore, Market, Price } from "@/lib/investments/store";
import { logError } from "@/lib/log";

/**
 * Daily prices: US closing prices and the dollar rate from Massive (needs
 * MASSIVE_API_KEY), Ghana Stock Exchange prices from a free public feed, and
 * a free exchange-rate feed when Massive isn't set up. Prices are cached in
 * market_prices and shared by everyone, so each symbol is fetched once a day.
 */
const MASSIVE = "https://api.massive.com/v2/aggs/ticker";
const GSE_LIVE = "https://dev.kwayisi.org/apis/gse/live";
const FX_FALLBACK = "https://open.er-api.com/v6/latest/USD";
/** Massive's free tier allows 5 calls a minute; one goes to the dollar rate. */
export const US_CALLS_PER_RUN = 4;

const prevSchema = z.object({ results: z.array(z.object({ c: z.number().positive(), t: z.number() })).min(1) });
const gseSchema = z.array(z.object({ name: z.string(), price: z.number().positive() }));
const fxSchema = z.object({ result: z.literal("success"), time_last_update_unix: z.number(), rates: z.object({ GHS: z.number().positive() }) });

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Settle a page-budgeted request even if a response body arrives after cancellation. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    work.then(value => { signal.removeEventListener("abort", abort); if (signal.aborted) reject(signal.reason); else resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) abort();
  });
}

async function readResponse<T>(url: string, init: RequestInit, fetchImpl: typeof fetch, read: (response: Response) => Promise<T>, budget?: AbortSignal): Promise<T> {
  const signal = budget ? AbortSignal.any([budget, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
  signal.throwIfAborted();
  const work = (async () => {
    const response = await fetchImpl(url, { ...init, signal });
    signal.throwIfAborted();
    const result = await read(response);
    signal.throwIfAborted();
    return result;
  })();
  // Without a page budget, retain the existing per-request fetch timeout behavior.
  return budget ? untilAborted(work, signal) : work;
}

/** "VOO", "BRK.B": what a US symbol may look like. */
export function cleanSymbol(value: string): string | null {
  const symbol = value.trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9.-]{0,9}$/.test(symbol) ? symbol : null;
}

async function massiveClose(ticker: string, key: string, fetchImpl: typeof fetch, budget?: AbortSignal): Promise<{ price: number; asOf: string } | null> {
  return readResponse(`${MASSIVE}/${encodeURIComponent(ticker)}/prev?adjusted=true`, { headers: { authorization: `Bearer ${key}` } }, fetchImpl, async response => {
    if (!response.ok) return null;
    const parsed = prevSchema.safeParse(await response.json());
    if (!parsed.success) return null;
    const last = parsed.data.results.at(-1)!;
    return { price: last.c, asOf: day(last.t) };
  }, budget);
}

/** Cedis per dollar: Massive when it's set up, the free feed otherwise. */
export async function fetchUsdGhs(key: string | null, fetchImpl: typeof fetch = fetch, budget?: AbortSignal): Promise<Price | null> {
  try {
    if (key) {
      const close = await massiveClose("C:USDGHS", key, fetchImpl, budget);
      if (close) return { market: "fx", symbol: "USDGHS", price: close.price, currency: "GHS", asOf: close.asOf };
    }
    const parsed = fxSchema.safeParse(await readResponse(FX_FALLBACK, {}, fetchImpl, response => response.json(), budget));
    return parsed.success ? { market: "fx", symbol: "USDGHS", price: parsed.data.rates.GHS, currency: "GHS", asOf: day(parsed.data.time_last_update_unix * 1000) } : null;
  } catch (error) {
    if (!budget?.aborted) logError("prices_fx", error);
    return null;
  }
}

export async function fetchUsCloses(symbols: string[], key: string, fetchImpl: typeof fetch = fetch, budget?: AbortSignal): Promise<Price[]> {
  const prices: Price[] = [];
  for (const symbol of symbols) {
    if (budget?.aborted) break;
    try {
      const close = await massiveClose(symbol, key, fetchImpl, budget);
      if (close) prices.push({ market: "us", symbol, price: close.price, currency: "USD", asOf: close.asOf });
    } catch (error) {
      if (!budget?.aborted) logError("prices_us", error);
    }
  }
  return prices;
}

/** Every GSE share's latest price; the feed lists them all in one call. */
export async function fetchGsePrices(today: string, fetchImpl: typeof fetch = fetch, budget?: AbortSignal): Promise<Price[]> {
  try {
    const parsed = gseSchema.safeParse(await readResponse(GSE_LIVE, {}, fetchImpl, response => response.json(), budget));
    if (!parsed.success) return [];
    return parsed.data.map((item) => ({ market: "gse" as const, symbol: item.name.toUpperCase(), price: item.price, currency: "GHS", asOf: today }));
  } catch (error) {
    if (!budget?.aborted) logError("prices_gse", error);
    return [];
  }
}

/**
 * Refreshes the prices that matter: the dollar rate, every held GSE share,
 * and the US symbols that are missing or oldest, within the free-tier limit.
 * `only` limits it to particular symbols, like one just added.
 */
export async function refreshPrices(
  store: InvestmentStore,
  options: { key: string | null; today: string; only?: { market: Market; symbol: string }[]; fetchImpl?: typeof fetch; signal?: AbortSignal },
): Promise<{ saved: number }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const wanted = options.only ?? (await store.heldSymbols());
  const known = await store.prices([...wanted, { market: "fx", symbol: "USDGHS" }]);
  // Fetched today already: a close doesn't change during the day, and weekends have none.
  const fresh = (market: Market, symbol: string) =>
    known.find((price) => price.market === market && price.symbol === symbol && (price.fetchedAt ?? "").slice(0, 10) >= options.today);
  const gse = wanted.filter((item) => item.market === "gse");
  const age = (symbol: string) => known.find((price) => price.market === "us" && price.symbol === symbol)?.asOf ?? "";
  const us = wanted
    .filter((item) => item.market === "us" && !fresh("us", item.symbol))
    .map((item) => item.symbol)
    .sort((a, b) => age(a).localeCompare(age(b)))
    .slice(0, US_CALLS_PER_RUN);
  // Feeds do not depend on one another. Keep US calls sequential and capped,
  // while the FX fallback and GSE board load alongside that group.
  const [fx, board, closes] = await Promise.all([
    fresh("fx", "USDGHS") ? Promise.resolve(null) : fetchUsdGhs(options.key, fetchImpl, options.signal),
    gse.some((item) => !fresh("gse", item.symbol)) ? fetchGsePrices(options.today, fetchImpl, options.signal) : Promise.resolve([]),
    options.key ? fetchUsCloses(us, options.key, fetchImpl, options.signal) : Promise.resolve([]),
  ]);
  const saved: Price[] = [...(fx ? [fx] : []), ...board.filter((price) => gse.some((item) => item.symbol === price.symbol)), ...closes];
  if (saved.length > 0) await store.savePrices(saved);
  return { saved: saved.length };
}

/** The Massive key, when it's set. */
export function massiveKey(): string | null {
  const key = process.env.MASSIVE_API_KEY?.trim();
  return key && key.length <= 1024 && !/[\r\n\0]/.test(key) ? key : null;
}
