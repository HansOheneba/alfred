import { describe, expect, it } from "vitest";

import { refreshPrices } from "@/lib/investments/prices";
import { findInvestment, MemoryInvestmentStore } from "@/lib/investments/store";
import { grownByRate, valuePortfolio } from "@/lib/investments/value";

const today = "2026-11-02";

async function portfolio(store: MemoryInvestmentStore) {
  return valuePortfolio({
    investments: await store.list("42"),
    holdings: await store.holdings("42"),
    values: await store.latestValues("42"),
    contributions: await store.contributions("42"),
    prices: store.priceRows,
    today,
  });
}

describe("valuing investments", () => {
  it("prices US holdings from daily closes and converts them to cedis", async () => {
    const store = new MemoryInvestmentStore();
    const risevest = await store.create("42", { name: "Risevest", kind: "us_stocks", currency: "USD", investedBefore: "500.00" });
    await store.setHoldings("42", risevest.id, [
      { symbol: "VOO", quantity: 1.5 },
      { symbol: "MSFT", quantity: 0.5 },
    ]);
    await store.savePrices([
      { market: "us", symbol: "VOO", price: 600, currency: "USD", asOf: "2026-10-30" },
      { market: "us", symbol: "MSFT", price: 400, currency: "USD", asOf: "2026-10-30" },
      { market: "fx", symbol: "USDGHS", price: 11.3, currency: "GHS", asOf: "2026-11-01" },
    ]);
    await store.addContribution("42", { investmentId: risevest.id, amount: "2260.00", currency: "GHS", occurredOn: "2026-10-01", bankMessageId: null, note: "" });

    const view = await portfolio(store);
    const item = view.items[0];
    expect(item).toMatchObject({ value: 1100, source: "prices", asOf: "2026-10-30", stale: false, valueGhs: 12430 });
    // 500 dollars before Alfred (5,650 cedis) plus 2,260 cedis sent since.
    expect(item.investedGhs).toBe(7910);
    expect(item.gainGhs).toBe(4520);
    expect(view.totalGhs).toBe(12430);
  });

  it("uses a newer reported value over older prices, and marks old ones stale", async () => {
    const store = new MemoryInvestmentStore();
    const fund = await store.create("42", { name: "Databank fund", kind: "mutual_fund" });
    await store.addValue("42", fund.id, "8400.00", "2026-09-15T10:00:00.000Z", "reported");
    const view = await portfolio(store);
    expect(view.items[0]).toMatchObject({ value: 8400, source: "reported", stale: true });
  });

  it("grows a T-bill by its rate until it matures, and says what it'll be worth then", async () => {
    const store = new MemoryInvestmentStore();
    await store.create("42", { name: "91-day T-bill", kind: "tbill", principal: "5000.00", rate: 24, startedOn: "2026-10-03", maturesOn: "2027-01-02" });
    const item = (await portfolio(store)).items[0];
    expect(item.source).toBe("rate");
    expect(item.value).toBe(Math.round(5000 * (1 + 0.24 * (30 / 365)) * 100) / 100);
    expect(item.maturity).toEqual({ date: "2027-01-02", daysLeft: 61, valueAtMaturity: Math.round(5000 * (1 + 0.24 * (91 / 365)) * 100) / 100 });
    expect(grownByRate(1000, 10, "2026-01-01", "2030-01-01", "2026-07-02")).toBeCloseTo(1000 * (1 + 0.1 * (182 / 365)));
  });

  it("falls back to what went in, and leaves out what can't be put in cedis", async () => {
    const store = new MemoryInvestmentStore();
    const pension = await store.create("42", { name: "Tier 3 pension", kind: "pension" });
    await store.addContribution("42", { investmentId: pension.id, amount: "300.00", currency: "GHS", occurredOn: "2026-10-25", bankMessageId: null, note: "" });
    await store.create("42", { name: "Euro savings", kind: "other", currency: "EUR", investedBefore: "100.00" });
    const view = await portfolio(store);
    expect(view.items[0]).toMatchObject({ value: 300, source: "invested", gainGhs: 0 });
    expect(view.unconverted).toEqual(["Euro savings"]);
    expect(view.totalGhs).toBe(300);
  });

  it("finds an investment by name, first word, or provider", async () => {
    const store = new MemoryInvestmentStore();
    await store.create("42", { name: "Risevest", kind: "us_stocks", provider: "Risevest" });
    await store.create("42", { name: "Databank Epack", kind: "mutual_fund", provider: "Databank" });
    const all = await store.list("42");
    expect(findInvestment(all, "risevest")?.name).toBe("Risevest");
    expect(findInvestment(all, "Databank")?.name).toBe("Databank Epack");
    expect(findInvestment(all, "my bamboo")).toBeNull();
  });
});

describe("refreshing prices", () => {
  function fakeFetch(calls: string[]): typeof fetch {
    return (async (url: string) => {
      calls.push(String(url));
      if (String(url).includes("C:USDGHS")) return Response.json({ results: [{ c: 11.3, t: Date.parse("2026-11-01T23:59:59Z") }] });
      if (String(url).includes("massive")) return Response.json({ results: [{ c: 694.81, t: Date.parse("2026-10-30T20:00:00Z") }] });
      if (String(url).includes("gse")) return Response.json([{ name: "MTNGH", price: 3.1, change: 0, volume: 1 }, { name: "GCB", price: 7.2, change: 0, volume: 1 }]);
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;
  }

  it("fetches the dollar rate, held GSE shares and the oldest US symbols, then skips fresh ones", async () => {
    const store = new MemoryInvestmentStore();
    store.clock = () => new Date(`${today}T09:00:00Z`);
    const us = await store.create("42", { name: "Risevest", kind: "us_stocks", currency: "USD" });
    const gh = await store.create("42", { name: "IC Securities", kind: "gse_stocks" });
    await store.setHoldings("42", us.id, ["VOO", "MSFT", "NVDA", "FIG", "AAPL"].map((symbol) => ({ symbol, quantity: 1 })));
    await store.setHoldings("42", gh.id, [{ symbol: "MTNGH", quantity: 100 }]);

    const calls: string[] = [];
    const first = await refreshPrices(store, { key: "test", today, fetchImpl: fakeFetch(calls) });
    // The dollar rate, four US symbols (the free tier's limit), and MTNGH from the GSE board.
    expect(first.saved).toBe(6);
    expect(calls.filter((url) => url.includes("massive"))).toHaveLength(5);
    expect(store.priceRows.find((price) => price.symbol === "MTNGH")).toMatchObject({ price: 3.1, asOf: today });

    const again: string[] = [];
    await refreshPrices(store, { key: "test", today, fetchImpl: fakeFetch(again) });
    // Only the US symbol that didn't fit the first time.
    expect(again.filter((url) => url.includes("massive"))).toHaveLength(1);
  });

  it("works without a Massive key: GSE and the free dollar rate only", async () => {
    const store = new MemoryInvestmentStore();
    store.clock = () => new Date(`${today}T09:00:00Z`);
    const gh = await store.create("42", { name: "IC Securities", kind: "gse_stocks" });
    await store.setHoldings("42", gh.id, [{ symbol: "GCB", quantity: 10 }]);
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(String(url));
      if (String(url).includes("er-api")) return Response.json({ result: "success", time_last_update_unix: Date.parse("2026-11-02T00:00:00Z") / 1000, rates: { GHS: 11.66 } });
      return fakeFetch([])(url);
    }) as unknown as typeof fetch;
    await refreshPrices(store, { key: null, today, fetchImpl });
    expect(calls.some((url) => url.includes("massive"))).toBe(false);
    expect(store.priceRows.map((price) => `${price.market}:${price.symbol}:${price.price}`).sort()).toEqual(["fx:USDGHS:11.66", "gse:GCB:7.2"]);
  });

  it("fetches again the next day", async () => {
    const store = new MemoryInvestmentStore();
    store.clock = () => new Date("2026-11-01T09:00:00Z");
    await store.savePrices([{ market: "fx", symbol: "USDGHS", price: 11, currency: "GHS", asOf: "2026-10-31" }]);
    const calls: string[] = [];
    await refreshPrices(store, { key: "test", today, fetchImpl: fakeFetch(calls) });
    expect(calls).toHaveLength(1);
  });
});

describe("talking to Alfred about investments", () => {
  async function chat() {
    const { handleAction } = await import("@/lib/finance/action-router");
    const { MemoryFinanceStore } = await import("@/lib/finance/memory-store");
    const { profile } = await import("./helpers");
    const store = new MemoryInvestmentStore();
    store.clock = () => new Date(`${today}T09:00:00Z`);
    await store.savePrices([
      { market: "us", symbol: "VOO", price: 600, currency: "USD", asOf: "2026-10-30" },
      { market: "fx", symbol: "USDGHS", price: 11, currency: "GHS", asOf: "2026-11-01" },
    ]);
    const ctx = {
      profile: profile(42),
      store: new MemoryFinanceStore(),
      now: new Date(`${today}T10:00:00Z`),
      updateId: 1,
      chatId: 100,
      confirmTransactions: "auto" as const,
      pendingTtlMs: 60_000,
      createId: () => "7a1b2c3d-4444-4444-8444-000000000001",
      createActionId: () => "act-1",
      investments: store,
      bank: { ignoreAccount: null, balances: async () => [{ source: "momo" as const, balance: "1000.00", at: `${today}T08:00:00Z` }] },
    };
    type Action = Parameters<typeof handleAction>[0];
    const say = async (action: Action) => {
      const reply = await handleAction(action, ctx);
      return reply.kind === "text" ? reply.text : "";
    };
    return { store, say };
  }

  it("adds US holdings and values them in dollars and cedis", async () => {
    const { say } = await chat();
    const reply = await say({ type: "add_investment", name: "Risevest", kind: "us_stocks", holdings: [{ symbol: "VOO", quantity: 2 }], invested_before: "1000.00" });
    expect(reply).toContain("Now tracking Risevest (US stocks).");
    expect(reply).toContain("US$1,200.00 ≈ GH₵13,200.00 at the 30 Oct close");
    expect(reply).toContain("up GH₵2,200.00 (+20.0%) on GH₵11,000.00 put in");
  });

  it("buys a T-bill today, grows it by its rate, and knows when it matures", async () => {
    const { say } = await chat();
    const reply = await say({ type: "add_investment", name: "91-day T-bill", kind: "tbill", principal: "5000.00", rate: 24, matures_on: "2027-02-01" });
    expect(reply).toContain("GH₵5,000.00 so far at 24% a year");
    expect(reply).toContain("Matures 1 Feb at about GH₵5,299.18");
  });

  it("takes a reported value, money put in, and gives net worth with cash", async () => {
    const { store, say } = await chat();
    await say({ type: "add_investment", name: "Databank Epack", kind: "mutual_fund" });
    expect(await say({ type: "update_investment", name: "databank", value: "8400.00" })).toContain("Updated Databank Epack: GH₵8,400.00 as you told me on 2 Nov");
    expect(await say({ type: "invest_money", name: "Databank", amount: "500.00", currency: "GHS", direction: "in" })).toBe("Noted: GH₵500.00 into Databank Epack. It isn't counted as spending.");
    expect((await store.contributions("42")).map((item) => item.amount)).toEqual(["500.00"]);

    const worth = await say({ type: "get_investments", net_worth: true });
    expect(worth.split("\n")[0]).toBe(
      "Your net worth is about GH₵9,400.00: GH₵1,000.00 in your accounts (MoMo GH₵1,000.00, from your latest bank texts) and GH₵8,400.00 invested. Money people owe you and you owe them isn't included.",
    );
  });

  it("says when it doesn't know an investment, and when there are none", async () => {
    const { say } = await chat();
    expect(await say({ type: "get_investments" })).toContain("You haven't told me about any investments yet.");
    expect(await say({ type: "update_investment", name: "Bamboo", value: "100.00" })).toContain("I don't have an investment called Bamboo yet.");
  });
});

describe("the daily investments job", () => {
  it("reminds about a T-bill maturing soon, once", async () => {
    const { runInvestmentsDaily } = await import("@/lib/investments/daily");
    const store = new MemoryInvestmentStore();
    await store.create("42", { name: "91-day T-bill", kind: "tbill", principal: "5000.00", rate: 24, startedOn: "2026-08-05", maturesOn: "2026-11-04" });
    await store.create("42", { name: "182-day T-bill", kind: "tbill", principal: "2000.00", rate: 26, startedOn: "2026-10-01", maturesOn: "2027-04-01" });
    const sent: string[] = [];
    const deps = { store, today, key: null, chatFor: async () => 100, send: async (_chat: number, text: string) => sent.push(text), fetchImpl: (async () => new Response("", { status: 500 })) as unknown as typeof fetch };

    expect((await runInvestmentsDaily(deps)).reminded).toBe(1);
    expect(sent).toEqual(["Your 91-day T-bill matures on 4 Nov 2026, worth about GH₵5,299.18. Will you roll it over or cash it out? Tell me what you do and I'll update it."]);
    expect((await runInvestmentsDaily(deps)).reminded).toBe(0);
  });
});
