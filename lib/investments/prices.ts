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

/** "VOO", "BRK.B": what a US symbol may look like. */
export function cleanSymbol(value: string): string | null {
  const symbol = value.trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9.-]{0,9}$/.test(symbol) ? symbol : null;
}

async function massiveClose(ticker: string, key: string, fetchImpl: typeof fetch): Promise<{ price: number; asOf: string } | null> {
  const response = await fetchImpl(`${MASSIVE}/${encodeURIComponent(ticker)}/prev?adjusted=true`, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return null;
  const parsed = prevSchema.safeParse(await response.json());
  if (!parsed.success) return null;
  const last = parsed.data.results.at(-1)!;
  return { price: last.c, asOf: day(last.t) };
}

/** Cedis per dollar: Massive when it's set up, the free feed otherwise. */
export async function fetchUsdGhs(key: string | null, fetchImpl: typeof fetch = fetch): Promise<Price | null> {
  try {
    if (key) {
      const close = await massiveClose("C:USDGHS", key, fetchImpl);
      if (close) return { market: "fx", symbol: "USDGHS", price: close.price, currency: "GHS", asOf: close.asOf };
    }
    const response = await fetchImpl(FX_FALLBACK, { signal: AbortSignal.timeout(10_000) });
    const parsed = fxSchema.safeParse(await response.json());
    return parsed.success ? { market: "fx", symbol: "USDGHS", price: parsed.data.rates.GHS, currency: "GHS", asOf: day(parsed.data.time_last_update_unix * 1000) } : null;
  } catch (error) {
    logError("prices_fx", error);
    return null;
  }
}

export async function fetchUsCloses(symbols: string[], key: string, fetchImpl: typeof fetch = fetch): Promise<Price[]> {
  const prices: Price[] = [];
  for (const symbol of symbols) {
    try {
      const close = await massiveClose(symbol, key, fetchImpl);
      if (close) prices.push({ market: "us", symbol, price: close.price, currency: "USD", asOf: close.asOf });
    } catch (error) {
      logError("prices_us", error);
    }
  }
  return prices;
}

/** Every GSE share's latest price; the feed lists them all in one call. */
export async function fetchGsePrices(today: string, fetchImpl: typeof fetch = fetch): Promise<Price[]> {
  try {
    const response = await fetchImpl(GSE_LIVE, { signal: AbortSignal.timeout(10_000) });
    const parsed = gseSchema.safeParse(await response.json());
    if (!parsed.success) return [];
    return parsed.data.map((item) => ({ market: "gse" as const, symbol: item.name.toUpperCase(), price: item.price, currency: "GHS", asOf: today }));
  } catch (error) {
    logError("prices_gse", error);
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
  options: { key: string | null; today: string; only?: { market: Market; symbol: string }[]; fetchImpl?: typeof fetch },
): Promise<{ saved: number }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const wanted = options.only ?? (await store.heldSymbols());
  const known = await store.prices([...wanted, { market: "fx", symbol: "USDGHS" }]);
  // Fetched today already: a close doesn't change during the day, and weekends have none.
  const fresh = (market: Market, symbol: string) =>
    known.find((price) => price.market === market && price.symbol === symbol && (price.fetchedAt ?? "").slice(0, 10) >= options.today);
  const saved: Price[] = [];

  if (!fresh("fx", "USDGHS")) {
    const fx = await fetchUsdGhs(options.key, fetchImpl);
    if (fx) saved.push(fx);
  }
  const gse = wanted.filter((item) => item.market === "gse");
  if (gse.length > 0 && gse.some((item) => !fresh("gse", item.symbol))) {
    const board = await fetchGsePrices(options.today, fetchImpl);
    saved.push(...board.filter((price) => gse.some((item) => item.symbol === price.symbol)));
  }
  if (options.key) {
    const age = (symbol: string) => known.find((price) => price.market === "us" && price.symbol === symbol)?.asOf ?? "";
    const us = wanted
      .filter((item) => item.market === "us" && !fresh("us", item.symbol))
      .map((item) => item.symbol)
      .sort((a, b) => age(a).localeCompare(age(b)))
      .slice(0, US_CALLS_PER_RUN);
    saved.push(...(await fetchUsCloses(us, options.key, fetchImpl)));
  }
  if (saved.length > 0) await store.savePrices(saved);
  return { saved: saved.length };
}

/** The Massive key, when it's set. */
export function massiveKey(): string | null {
  const key = process.env.MASSIVE_API_KEY?.trim();
  return key && key.length <= 1024 && !/[\r\n\0]/.test(key) ? key : null;
}
