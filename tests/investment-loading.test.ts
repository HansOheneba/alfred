import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseSettings } from "@/lib/config";

const transport = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/supabase/connection", () => ({ query: transport.query }));
import { loadPortfolio, loadPortfolioDetails } from "@/lib/investments/actions";
import { createSupabaseInvestmentStore } from "@/lib/investments/store";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TODAY = "2026-11-05";
const AT = new Date("2026-11-05T12:00:00.000Z");
const settings = {} as SupabaseSettings;
const investments = Array.from({ length: 250 }, (_, index) => ({
  id: `synthetic-investment-${index}`, owner_id: OWNER, name: `Fictional fund ${index}`, kind: "mutual_fund",
  provider: "Fictional", currency: "GHS", invested_before: "100.00", principal: null, rate: null,
  started_on: null, matures_on: null, reminded_at: null, payee_key: null, status: "active",
}));
const values = investments.map(item => ({ investment_id: item.id, value: "200.00", as_of: AT, source: "reported" }));
const contributions = Array.from({ length: 5000 }, (_, index) => ({
  id: `synthetic-contribution-${index}`, investment_id: investments[index % investments.length].id,
  amount: "1.00", currency: "GHS", occurred_on: TODAY, bank_message_id: null, note: "Synthetic fixture",
}));
const prices = [{ market: "fx", symbol: "USDGHS", price: "10.00", currency: "GHS", as_of: TODAY, fetched_at: AT }];

function result(sql: string) {
  if (sql.includes(") as investments,")) return [{ investments, holdings: [], values, contributions }];
  if (sql.includes("from public.market_prices")) return prices;
  if (sql.includes("from public.investments where")) return investments;
  if (sql.includes("from public.investment_holdings")) return [];
  if (sql.includes("from public.investment_values")) return values;
  if (sql.includes("from public.investment_contributions")) return contributions;
  throw new Error("Unexpected synthetic query");
}

/** Fixed latency and the app's three-slot pool model; no real time or database is used. */
function delayedQueries(latency = 40) {
  let active = 0;
  const waiting: (() => void)[] = [];
  transport.query.mockReset();
  transport.query.mockImplementation((_settings: unknown, sql: string) => new Promise(resolve => {
    const run = () => {
      active++;
      setTimeout(() => { active--; resolve(structuredClone(result(sql))); waiting.shift()?.(); }, latency);
    };
    if (active < 3) run(); else waiting.push(run);
  }));
}
afterEach(() => { vi.useRealTimers(); transport.query.mockReset(); });

describe("Investments page loading query plan", () => {
  it("records the previous query plan with synthetic database latency", async () => {
    vi.useFakeTimers(); vi.setSystemTime(AT); delayedQueries();
    const store = createSupabaseInvestmentStore(settings), start = Date.now();
    store.portfolioInputs = undefined;
    const loaded = Promise.all([loadPortfolio(store, OWNER, TODAY, { fetchMissing: true }), store.contributions(OWNER)]);
    await vi.runAllTimersAsync();
    const [portfolio, history] = await loaded;
    const measurement = { queries: transport.query.mock.calls.length, simulatedMs: Date.now() - start, investments: portfolio.items.length, contributions: history.length };
    expect(measurement).toEqual({ queries: 6, simulatedMs: 120, investments: 250, contributions: 5000 });
  });

  it("loads valuation and recent history from two reads instead of six, without cross-request caching", async () => {
    vi.useFakeTimers(); vi.setSystemTime(AT); delayedQueries();
    const store = createSupabaseInvestmentStore(settings), start = Date.now();
    const loaded = loadPortfolioDetails(store, OWNER, TODAY, { fetchMissing: true });
    await vi.runAllTimersAsync();
    const { portfolio, contributions: history } = await loaded;
    expect({ queries: transport.query.mock.calls.length, simulatedMs: Date.now() - start, investments: portfolio.items.length, contributions: history.length })
      .toEqual({ queries: 2, simulatedMs: 80, investments: 250, contributions: 5000 });
    expect(transport.query.mock.calls[0][2]).toEqual([OWNER]);
    const next = loadPortfolioDetails(store, OWNER, TODAY, { fetchMissing: true });
    await vi.runAllTimersAsync(); await next;
    expect(transport.query).toHaveBeenCalledTimes(4);
  });

  it("does not turn failed portfolio input reads into an empty portfolio", async () => {
    transport.query.mockRejectedValue(new Error("Synthetic unavailable database"));
    await expect(loadPortfolioDetails(createSupabaseInvestmentStore(settings), OWNER, TODAY)).rejects.toThrow("Synthetic unavailable database");
    expect(transport.query).toHaveBeenCalledOnce();
  });

  it("matches the original individual SQL reads, preserves ordering and isolates owners", async () => {
    const db = new PGlite();
    try {
      await db.exec("create table profiles(id uuid primary key);create table bank_messages(id uuid primary key,status text);create table payee_rules(kind text)");
      await db.exec(readFileSync("supabase/migrations/20261102090000_investments.sql", "utf8"));
      const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      await db.query("insert into profiles values($1),($2)", [OWNER, other]);
      transport.query.mockImplementation(async (_settings: unknown, sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows);
      const store = createSupabaseInvestmentStore(settings);
      const fund = await store.create(OWNER, { name: "Fictional fund", kind: "mutual_fund", investedBefore: "100.00" });
      const shares = await store.create(OWNER, { name: "Fictional shares", kind: "gse_stocks" });
      await store.create(other, { name: "Private fictional fund", kind: "mutual_fund" });
      await store.setHoldings(OWNER, shares.id, [{ symbol: "ZZZ", quantity: 2.125, cost: "1.23" }, { symbol: "AAA", quantity: 3 }]);
      await store.addValue(OWNER, fund.id, "125.00", "2026-11-01T09:00:00.000Z", "reported");
      await store.addValue(OWNER, fund.id, "150.00", AT.toISOString(), "screenshot");
      await store.addContribution(OWNER, { investmentId: fund.id, amount: "25.00", currency: "GHS", occurredOn: "2026-11-04", bankMessageId: null, note: "Synthetic deposit" });
      await store.addContribution(OWNER, { investmentId: fund.id, amount: "-5.00", currency: "GHS", occurredOn: "2026-11-05", bankMessageId: null, note: "Synthetic withdrawal" });
      const expected = { investments: await store.list(OWNER), holdings: await store.holdings(OWNER), values: await store.latestValues(OWNER), contributions: await store.contributions(OWNER) };
      expect(await store.portfolioInputs!(OWNER)).toEqual(expected);
      expect((await store.portfolioInputs!(other)).investments.map(item => item.name)).toEqual(["Private fictional fund"]);
      expect((await store.portfolioInputs!(other)).contributions).toEqual([]);
      await store.addContribution(OWNER, { investmentId: fund.id, amount: "1.00", currency: "GHS", occurredOn: TODAY, bankMessageId: null, note: "Fresh fixture" });
      expect((await store.portfolioInputs!(OWNER)).contributions).toHaveLength(3);
    } finally { await db.close(); }
  });
});
