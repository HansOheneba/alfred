import { sourceName } from "@/lib/bank/parse";
import type { ActionContext, Delivery } from "@/lib/finance/action-router";
import { formatDisplayDate, zonedYmd } from "@/lib/finance/dates";
import { formatMinor } from "@/lib/finance/money";
import type { FinanceAction } from "@/lib/finance/schemas";
import { massiveKey, refreshPrices } from "@/lib/investments/prices";
import { FIXED_INCOME, findInvestment, KIND_LABELS, marketFor, type Investment, type InvestmentPatch, type InvestmentStore } from "@/lib/investments/store";
import { valuePortfolio, type InvestmentView, type Portfolio } from "@/lib/investments/value";

type Action<T extends FinanceAction["type"]> = Extract<FinanceAction, { type: T }>;

const money = (value: number, currency: string) => formatMinor(Math.round(value * 100), currency);
const ghs = (value: number) => money(value, "GHS");
const shortDate = (iso: string) => formatDisplayDate(iso.slice(0, 10)).replace(/ \d{4}$/, "");
const percent = (part: number, whole: number) => `${part >= 0 ? "+" : ""}${((part / whole) * 100).toFixed(1)}%`;

/**
 * Everything needed to value one person's investments. Prices for symbols
 * that have never been priced are fetched first, so a just-added holding
 * shows a value straight away; everything else waits for the daily refresh.
 */
export async function loadPortfolio(store: InvestmentStore, ownerId: string, today: string, options: { fetchMissing?: boolean; fetchImpl?: typeof fetch } = {}): Promise<Portfolio> {
  const [investments, holdings, values, contributions] = await Promise.all([store.list(ownerId), store.holdings(ownerId), store.latestValues(ownerId), store.contributions(ownerId)]);
  const kinds = new Map(investments.map((item) => [item.id, item.kind]));
  const keys = holdings.flatMap((holding) => {
    const market = marketFor(kinds.get(holding.investmentId) ?? "other");
    return market ? [{ market, symbol: holding.symbol }] : [];
  });
  let prices = await store.prices([...keys, { market: "fx", symbol: "USDGHS" }]);
  const missing = keys.filter((key) => !prices.some((price) => price.market === key.market && price.symbol === key.symbol));
  const needsFx = !prices.some((price) => price.market === "fx") && investments.some((item) => item.currency === "USD");
  if (options.fetchMissing && (missing.length > 0 || needsFx)) {
    await refreshPrices(store, { key: massiveKey(), today, only: missing, fetchImpl: options.fetchImpl });
    prices = await store.prices([...keys, { market: "fx", symbol: "USDGHS" }]);
  }
  return valuePortfolio({ investments, holdings, values, contributions, prices, today });
}

/** Where a value came from, in a few words: "Fri 30 Oct close", "you told me on 15 Sep", "at 24% a year". */
function provenance(item: InvestmentView): string {
  if (item.source === "prices") return `at the ${shortDate(item.asOf!)} close`;
  if (item.source === "reported") return `as you told me on ${shortDate(item.asOf!)}${item.stale ? ", so it may be out of date" : ""}`;
  if (item.source === "rate") return `so far at ${item.investment.rate}% a year`;
  if (item.source === "invested") return "going by what you put in, since I don't have a current value";
  return "";
}

/** One line per investment: its value, where that came from, and how it's doing. */
export function investmentLine(item: InvestmentView): string {
  const { investment } = item;
  const head = `• ${investment.name} (${item.kindLabel})`;
  if (item.value === null) return `${head}: no value yet. Tell me what it's worth.`;
  const own = money(item.value, investment.currency);
  const cedis = investment.currency !== "GHS" && item.valueGhs !== null ? ` ≈ ${ghs(item.valueGhs)}` : "";
  const gain = item.gainGhs !== null && item.source !== "invested" && item.investedGhs > 0 ? `, ${item.gainGhs >= 0 ? "up" : "down"} ${ghs(Math.abs(item.gainGhs))} (${percent(item.gainGhs, item.investedGhs)}) on ${ghs(item.investedGhs)} put in` : "";
  const matures = item.maturity
    ? item.maturity.daysLeft >= 0
      ? `. Matures ${shortDate(item.maturity.date)}${item.maturity.valueAtMaturity !== null ? ` at about ${money(item.maturity.valueAtMaturity, investment.currency)}` : ""}`
      : `. Matured ${shortDate(item.maturity.date)}`
    : "";
  return `${head}: ${own}${cedis} ${provenance(item)}${gain}${matures}.`;
}

function totalLine(portfolio: Portfolio): string {
  const gain =
    portfolio.gainGhs !== null && portfolio.investedGhs > 0
      ? `, against ${ghs(portfolio.investedGhs)} put in: ${portfolio.gainGhs >= 0 ? "up" : "down"} ${ghs(Math.abs(portfolio.gainGhs))} (${percent(portfolio.gainGhs, portfolio.investedGhs)})`
      : "";
  return `Your investments are worth about ${ghs(portfolio.totalGhs)}${gain}.`;
}

const NONE = "You haven't told me about any investments yet. Tell me what you have, like “I have $1,200 in Risevest”, “I bought a 91-day T-bill of 5,000 at 24%”, or send a screenshot of your investment app.";

function notFound(name: string): Delivery {
  return { kind: "text", text: `I don't have an investment called ${name} yet. Tell me what it is (US stocks, Ghana stocks, a T-bill, a fund, a pension…) and what it's worth, and I'll start tracking it.` };
}

function today(ctx: ActionContext): string {
  return zonedYmd(ctx.now, ctx.profile.timezone);
}

export async function getInvestments(action: Action<"get_investments">, ctx: ActionContext): Promise<Delivery> {
  if (!ctx.investments) return { kind: "text", text: "I can't see your investments right now." };
  const portfolio = await loadPortfolio(ctx.investments, ctx.profile.profileId, today(ctx), { fetchMissing: true });
  const lines: string[] = [];

  if (action.name) {
    const wanted = findInvestment(portfolio.items.map((item) => item.investment), action.name);
    const item = wanted ? portfolio.items.find((entry) => entry.investment.id === wanted.id) : null;
    if (!item) return notFound(action.name);
    lines.push(investmentLine(item));
    if (item.holdings.length > 0) {
      lines.push(...item.holdings.map((holding) => `  ${holding.symbol}: ${holding.quantity}${holding.value !== null ? ` × ${money(holding.price!, item.investment.currency)} = ${money(holding.value, item.investment.currency)}` : " (no price yet)"}`));
    }
  } else if (portfolio.items.length === 0 && !action.net_worth) {
    return { kind: "text", text: NONE };
  } else if (portfolio.items.length > 0) {
    lines.push(totalLine(portfolio), ...portfolio.items.map(investmentLine));
    if (portfolio.unconverted.length > 0) lines.push(`Not in the total, since I have no cedi rate for it: ${portfolio.unconverted.join(", ")}.`);
  }

  if (action.net_worth) {
    const balances = ctx.bank ? await ctx.bank.balances().catch(() => []) : [];
    const cash = balances.reduce((sum, item) => sum + Number(item.balance), 0);
    const parts = balances.map((item) => `${sourceName(item.source)} ${ghs(Number(item.balance))}`).join(", ");
    lines.unshift(
      `Your net worth is about ${ghs(cash + portfolio.totalGhs)}: ${ghs(cash)} in your accounts${parts ? ` (${parts}, from your latest bank texts)` : ""} and ${ghs(portfolio.totalGhs)} invested. Money people owe you and you owe them isn't included.`,
    );
    if (portfolio.items.length === 0) lines.push(NONE);
  }
  if (portfolio.usdGhs && portfolio.items.some((item) => item.investment.currency === "USD")) lines.push(`Dollars are converted at ${ghs(portfolio.usdGhs)} per $1.`);
  return { kind: "text", text: lines.join("\n") };
}

/** The fields an add or update sets on the investment itself. */
function patchFrom(action: Action<"add_investment"> | Action<"update_investment">, existing: Investment | null, now: string): InvestmentPatch {
  const patch: InvestmentPatch = {};
  if (action.provider) patch.provider = action.provider.trim();
  if (action.currency) patch.currency = action.currency;
  if (action.invested_before != null) patch.investedBefore = action.invested_before;
  if (action.principal != null) patch.principal = action.principal;
  if (action.rate != null) patch.rate = action.rate;
  if (action.started_on) patch.startedOn = action.started_on;
  if (action.matures_on) patch.maturesOn = action.matures_on;
  if (action.kind) patch.kind = action.kind;
  const kind = action.kind ?? existing?.kind;
  // A T-bill or deposit bought with a principal: it started today unless they said otherwise, and that's what went in.
  if (kind && FIXED_INCOME.includes(kind) && action.principal != null) {
    if (!action.started_on && !existing?.startedOn) patch.startedOn = now;
    if (action.invested_before == null && Number(existing?.investedBefore ?? 0) === 0) patch.investedBefore = action.principal;
  }
  return patch;
}

async function saveDetails(store: InvestmentStore, ctx: ActionContext, investment: Investment, action: Action<"add_investment"> | Action<"update_investment">): Promise<void> {
  if (action.holdings?.length) await store.setHoldings(ctx.profile.profileId, investment.id, action.holdings);
  if (action.value != null) await store.addValue(ctx.profile.profileId, investment.id, action.value, ctx.now.toISOString(), "reported");
}

async function lineFor(store: InvestmentStore, ctx: ActionContext, id: string): Promise<string> {
  const portfolio = await loadPortfolio(store, ctx.profile.profileId, today(ctx), { fetchMissing: true });
  const item = portfolio.items.find((entry) => entry.investment.id === id);
  // Just the value part: the reply already names the investment.
  return item ? investmentLine(item).replace(/^• [^:]*: /, "") : "";
}

export async function addInvestment(action: Action<"add_investment">, ctx: ActionContext): Promise<Delivery> {
  if (!ctx.investments) return { kind: "text", text: "I can't track investments right now." };
  const store = ctx.investments;
  const existing = findInvestment(await store.list(ctx.profile.profileId), action.name);
  // Telling Alfred about one it already has is an update.
  if (existing && existing.name.toLowerCase() === action.name.trim().toLowerCase()) return updateInvestment({ ...action, type: "update_investment", closed: null }, ctx);
  const patch = patchFrom(action, null, today(ctx));
  const investment = await store.create(ctx.profile.profileId, {
    name: action.name.trim().slice(0, 80),
    kind: action.kind,
    provider: patch.provider,
    currency: patch.currency ?? (action.kind === "us_stocks" ? "USD" : ctx.profile.currency),
    investedBefore: patch.investedBefore,
    principal: patch.principal,
    rate: patch.rate,
    startedOn: patch.startedOn,
    maturesOn: patch.maturesOn,
  });
  await saveDetails(store, ctx, investment, action);
  const line = await lineFor(store, ctx, investment.id);
  const nudge =
    action.value == null && !action.holdings?.length && !(FIXED_INCOME.includes(action.kind) && action.rate != null)
      ? " Tell me what it's worth now, or what you hold in it, and I'll keep its value."
      : "";
  return { kind: "text", text: `Now tracking ${investment.name} (${KIND_LABELS[investment.kind]}). ${line}${nudge}` };
}

export async function updateInvestment(action: Action<"update_investment">, ctx: ActionContext): Promise<Delivery> {
  if (!ctx.investments) return { kind: "text", text: "I can't track investments right now." };
  const store = ctx.investments;
  const investment = findInvestment(await store.list(ctx.profile.profileId), action.name);
  if (!investment) return notFound(action.name);
  if (action.closed) {
    await store.update(ctx.profile.profileId, investment.id, { status: "closed" });
    return { kind: "text", text: `Closed ${investment.name}. It's no longer counted in your investments.` };
  }
  await store.update(ctx.profile.profileId, investment.id, patchFrom(action, investment, today(ctx)));
  await saveDetails(store, ctx, investment, action);
  return { kind: "text", text: `Updated ${investment.name}: ${await lineFor(store, ctx, investment.id)}` };
}

export async function investMoney(action: Action<"invest_money">, ctx: ActionContext): Promise<Delivery> {
  if (!ctx.investments) return { kind: "text", text: "I can't track investments right now." };
  const store = ctx.investments;
  const investment = findInvestment(await store.list(ctx.profile.profileId), action.name);
  if (!investment) return notFound(action.name);
  const amount = action.direction === "in" ? action.amount : `-${action.amount}`;
  await store.addContribution(ctx.profile.profileId, {
    investmentId: investment.id,
    amount,
    currency: action.currency,
    occurredOn: action.date ?? today(ctx),
    bankMessageId: null,
    note: "Told Alfred",
  });
  const moved = formatMinor(Math.round(Number(action.amount) * 100), action.currency);
  return {
    kind: "text",
    text: action.direction === "in" ? `Noted: ${moved} into ${investment.name}. It isn't counted as spending.` : `Noted: ${moved} out of ${investment.name}. It isn't counted as income.`,
  };
}
