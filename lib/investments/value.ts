import { FIXED_INCOME, KIND_LABELS, marketFor, type InvestmentKind } from "@/lib/investments/kinds";
import type { Contribution, Holding, Investment, Price, ReportedValue } from "@/lib/investments/store";

/**
 * What each investment is worth today, where that figure comes from, and how
 * fresh it is. The server works these out; nothing here is a guess dressed up
 * as live: a figure that's old is marked stale, and one estimated from a rate
 * says so.
 *
 * Where a value comes from, best first:
 * - prices: every holding priced from the latest daily close (US stocks, GSE)
 * - reported: the newest value the person gave, in chat or a screenshot
 * - rate: a T-bill, fixed deposit or bond grown by its rate since it started
 * - invested: nothing better, so what went in
 */
export type ValueSource = "prices" | "reported" | "rate" | "invested";

export type HoldingView = { symbol: string; quantity: number; price: number | null; value: number | null; priceAsOf: string | null };

export type InvestmentView = {
  investment: Investment;
  kindLabel: string;
  /** In the investment's own currency. */
  value: number | null;
  valueGhs: number | null;
  source: ValueSource | null;
  asOf: string | null;
  stale: boolean;
  /** Money in, less money out, including what was there before Alfred, in cedis. */
  investedGhs: number;
  gainGhs: number | null;
  holdings: HoldingView[];
  maturity: { date: string; daysLeft: number; valueAtMaturity: number | null } | null;
};

export type Portfolio = {
  items: InvestmentView[];
  totalGhs: number;
  investedGhs: number;
  gainGhs: number | null;
  /** Cedi value by kind, for the allocation chart. */
  byKind: { kind: InvestmentKind; label: string; valueGhs: number }[];
  /** Cedis per US dollar, when known. */
  usdGhs: number | null;
  /** Investments whose value couldn't be put in cedis, left out of the totals. */
  unconverted: string[];
};

const DAY_MS = 86_400_000;
/** A reported value older than this is shown as stale. */
const REPORTED_STALE_DAYS = 31;
/** Daily closes older than this are shown as stale (weekends and holidays included). */
const PRICE_STALE_DAYS = 5;

const days = (from: string, to: string) => Math.round((Date.parse(to.slice(0, 10)) - Date.parse(from.slice(0, 10))) / DAY_MS);
const round = (value: number) => Math.round(value * 100) / 100;

/** A cedi amount for `value` in `currency`, or null when there's no rate for it. */
export function toGhs(value: number, currency: string, usdGhs: number | null): number | null {
  if (currency === "GHS") return value;
  if (currency === "USD" && usdGhs) return value * usdGhs;
  return null;
}

/** Simple interest from the start date to `on` (no later than maturity). */
export function grownByRate(principal: number, rate: number, startedOn: string, on: string, maturesOn: string | null): number {
  const end = maturesOn && maturesOn < on ? maturesOn : on;
  const elapsed = Math.max(0, days(startedOn, end));
  return principal * (1 + (rate / 100) * (elapsed / 365));
}

export function valuePortfolio(input: {
  investments: Investment[];
  holdings: Holding[];
  values: ReportedValue[];
  contributions: Contribution[];
  prices: Price[];
  today: string;
}): Portfolio {
  const fx = input.prices.find((price) => price.market === "fx" && price.symbol === "USDGHS");
  const usdGhs = fx ? fx.price : null;
  const items: InvestmentView[] = [];
  const unconverted: string[] = [];

  for (const investment of input.investments.filter((item) => item.status === "active")) {
    const market = marketFor(investment.kind);
    const holdings: HoldingView[] = input.holdings
      .filter((holding) => holding.investmentId === investment.id)
      .map((holding) => {
        const price = market ? input.prices.find((item) => item.market === market && item.symbol === holding.symbol) : undefined;
        return {
          symbol: holding.symbol,
          quantity: holding.quantity,
          price: price?.price ?? null,
          value: price ? round(holding.quantity * price.price) : null,
          priceAsOf: price?.asOf ?? null,
        };
      });
    const reported = input.values.find((value) => value.investmentId === investment.id) ?? null;
    const flows = input.contributions.filter((item) => item.investmentId === investment.id);
    const before = Number(investment.investedBefore);
    const investedGhs = round(
      (toGhs(before, investment.currency, usdGhs) ?? 0) + flows.reduce((sum, item) => sum + (toGhs(Number(item.amount), item.currency, usdGhs) ?? 0), 0),
    );
    const investedOwn = before + flows.reduce((sum, item) => sum + (item.currency === investment.currency ? Number(item.amount) : 0), 0);

    let value: number | null = null;
    let source: ValueSource | null = null;
    let asOf: string | null = null;

    const priced = holdings.length > 0 && holdings.every((holding) => holding.value !== null);
    const pricedAsOf = priced ? holdings.map((holding) => holding.priceAsOf!).sort()[0] : null;
    if (priced && (!reported || pricedAsOf! >= reported.asOf.slice(0, 10))) {
      value = round(holdings.reduce((sum, holding) => sum + holding.value!, 0));
      source = "prices";
      asOf = pricedAsOf;
    } else if (reported) {
      value = Number(reported.value);
      source = "reported";
      asOf = reported.asOf;
    } else if (FIXED_INCOME.includes(investment.kind) && investment.rate != null && investment.startedOn) {
      const principal = investment.principal != null ? Number(investment.principal) : investedOwn;
      if (principal > 0) {
        value = round(grownByRate(principal, investment.rate, investment.startedOn, input.today, investment.maturesOn));
        source = "rate";
        asOf = input.today;
      }
    }
    if (value === null && investedOwn > 0) {
      value = round(investedOwn);
      source = "invested";
      asOf = null;
    }

    const valueGhs = value === null ? null : toGhs(value, investment.currency, usdGhs);
    if (value !== null && valueGhs === null) unconverted.push(investment.name);
    const age = asOf ? days(asOf, input.today) : null;
    const stale = source === "prices" ? (age ?? 0) > PRICE_STALE_DAYS : source === "reported" ? (age ?? 0) > REPORTED_STALE_DAYS : false;

    let maturity: InvestmentView["maturity"] = null;
    if (investment.maturesOn) {
      const principal = investment.principal != null ? Number(investment.principal) : investedOwn;
      maturity = {
        date: investment.maturesOn,
        daysLeft: days(input.today, investment.maturesOn),
        valueAtMaturity:
          investment.rate != null && investment.startedOn && principal > 0
            ? round(grownByRate(principal, investment.rate, investment.startedOn, investment.maturesOn, investment.maturesOn))
            : null,
      };
    }

    items.push({
      investment,
      kindLabel: KIND_LABELS[investment.kind],
      value,
      valueGhs: valueGhs === null ? null : round(valueGhs),
      source,
      asOf,
      stale,
      investedGhs,
      gainGhs: valueGhs !== null && investedGhs > 0 ? round(valueGhs - investedGhs) : null,
      holdings,
      maturity,
    });
  }

  const counted = items.filter((item) => item.valueGhs !== null);
  const totalGhs = round(counted.reduce((sum, item) => sum + item.valueGhs!, 0));
  const investedGhs = round(counted.reduce((sum, item) => sum + item.investedGhs, 0));
  const kinds = new Map<InvestmentKind, number>();
  for (const item of counted) kinds.set(item.investment.kind, (kinds.get(item.investment.kind) ?? 0) + item.valueGhs!);
  return {
    items,
    totalGhs,
    investedGhs,
    gainGhs: counted.length > 0 && investedGhs > 0 ? round(totalGhs - investedGhs) : null,
    byKind: [...kinds.entries()].map(([kind, valueGhs]) => ({ kind, label: KIND_LABELS[kind], valueGhs: round(valueGhs) })).sort((a, b) => b.valueGhs - a.valueGhs),
    usdGhs,
    unconverted,
  };
}
