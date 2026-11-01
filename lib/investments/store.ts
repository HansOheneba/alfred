import type { SupabaseSettings } from "@/lib/config";
import { FIXED_INCOME, marketFor, type InvestmentKind, type Market } from "@/lib/investments/kinds";
import { query } from "@/lib/supabase/connection";

/**
 * What a person invests in, what it holds, what they've said it's worth, and
 * the money they've put in or taken out. Money into an investment is never a
 * ledger transaction: it isn't spending, so it lives here as a contribution.
 */
export { FIXED_INCOME, INVESTMENT_KINDS, KIND_LABELS, marketFor, type InvestmentKind, type Market } from "@/lib/investments/kinds";

export type Investment = {
  id: string;
  ownerId: string;
  name: string;
  kind: InvestmentKind;
  provider: string;
  currency: string;
  /** What was in it before Alfred tracked it, in its own currency. */
  investedBefore: string;
  principal: string | null;
  /** Yearly rate, in percent. */
  rate: number | null;
  startedOn: string | null;
  maturesOn: string | null;
  remindedAt: string | null;
  payeeKey: string | null;
  status: "active" | "closed";
};

export type NewInvestment = Pick<Investment, "name" | "kind"> &
  Partial<Pick<Investment, "provider" | "currency" | "investedBefore" | "principal" | "rate" | "startedOn" | "maturesOn" | "payeeKey">>;

export type InvestmentPatch = Partial<
  Pick<Investment, "name" | "kind" | "provider" | "currency" | "investedBefore" | "principal" | "rate" | "startedOn" | "maturesOn" | "remindedAt" | "payeeKey" | "status">
>;

export type Holding = { investmentId: string; symbol: string; quantity: number; cost: string | null };
export type ReportedValue = { investmentId: string; value: string; asOf: string; source: "reported" | "screenshot" };
export type Contribution = {
  id: string;
  investmentId: string;
  /** Positive for money put in, negative for money taken out. */
  amount: string;
  currency: string;
  occurredOn: string;
  bankMessageId: string | null;
  note: string;
};
export type NewContribution = Omit<Contribution, "id">;

/** `asOf` is the day the price is for; `fetchedAt` is when Alfred got it, set by the store. */
export type Price = { market: Market; symbol: string; price: number; currency: string; asOf: string; fetchedAt?: string };

export interface InvestmentStore {
  list(ownerId: string): Promise<Investment[]>;
  create(ownerId: string, input: NewInvestment): Promise<Investment>;
  update(ownerId: string, id: string, patch: InvestmentPatch): Promise<void>;
  holdings(ownerId: string): Promise<Holding[]>;
  /** Sets these holdings' quantities (and costs when given); a quantity of 0 removes one. */
  setHoldings(ownerId: string, investmentId: string, holdings: { symbol: string; quantity: number; cost?: string | null }[]): Promise<void>;
  /** The newest reported value of each investment. */
  latestValues(ownerId: string): Promise<ReportedValue[]>;
  addValue(ownerId: string, investmentId: string, value: string, asOf: string, source: ReportedValue["source"]): Promise<void>;
  contributions(ownerId: string): Promise<Contribution[]>;
  addContribution(ownerId: string, input: NewContribution): Promise<Contribution>;
  removeContribution(ownerId: string, id: string): Promise<void>;
  prices(keys: { market: Market; symbol: string }[]): Promise<Price[]>;
  savePrices(prices: Price[]): Promise<void>;
  /** Every symbol anyone holds, so the daily job knows what to price. */
  heldSymbols(): Promise<{ market: Market; symbol: string }[]>;
  /** Active fixed-income investments maturing on or before `until` that haven't been reminded about. */
  maturingBy(until: string): Promise<Investment[]>;
}

/** The investment a name refers to: exact, then by its first word or the start of the name. */
export function findInvestment(investments: Investment[], name: string | null | undefined): Investment | null {
  const wanted = (name ?? "").trim().toLowerCase();
  if (!wanted) return null;
  const active = investments.filter((item) => item.status === "active");
  return (
    active.find((item) => item.name.toLowerCase() === wanted) ??
    active.find((item) => item.name.toLowerCase().startsWith(wanted) || wanted.startsWith(item.name.toLowerCase())) ??
    active.find((item) => item.provider && item.provider.toLowerCase() === wanted) ??
    null
  );
}

type InvestmentRow = {
  id: string;
  owner_id: string;
  name: string;
  kind: InvestmentKind;
  provider: string;
  currency: string;
  invested_before: string;
  principal: string | null;
  rate: string | null;
  started_on: string | null;
  matures_on: string | null;
  reminded_at: Date | null;
  payee_key: string | null;
  status: Investment["status"];
};

const investmentColumns = `id::text, owner_id::text, name, kind, provider, currency, invested_before::text, principal::text, rate::text,
  to_char(started_on, 'YYYY-MM-DD') as started_on, to_char(matures_on, 'YYYY-MM-DD') as matures_on, reminded_at, payee_key, status`;

const money = (value: string | number) => Number(value).toFixed(2);

function fromRow(row: InvestmentRow): Investment {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    kind: row.kind,
    provider: row.provider,
    currency: row.currency,
    investedBefore: money(row.invested_before),
    principal: row.principal == null ? null : money(row.principal),
    rate: row.rate == null ? null : Number(row.rate),
    startedOn: row.started_on,
    maturesOn: row.matures_on,
    remindedAt: row.reminded_at ? row.reminded_at.toISOString() : null,
    payeeKey: row.payee_key,
    status: row.status,
  };
}

const PATCH_COLUMNS: Record<keyof InvestmentPatch, string> = {
  name: "name",
  kind: "kind",
  provider: "provider",
  currency: "currency",
  investedBefore: "invested_before",
  principal: "principal",
  rate: "rate",
  startedOn: "started_on",
  maturesOn: "matures_on",
  remindedAt: "reminded_at",
  payeeKey: "payee_key",
  status: "status",
};

export function createSupabaseInvestmentStore(settings: SupabaseSettings): InvestmentStore {
  return {
    async list(ownerId) {
      const rows = await query<InvestmentRow>(settings, `select ${investmentColumns} from public.investments where owner_id = $1::uuid and status = 'active' order by created_at`, [ownerId]);
      return rows.map(fromRow);
    },
    async create(ownerId, input) {
      const rows = await query<InvestmentRow>(
        settings,
        `insert into public.investments (owner_id, name, kind, provider, currency, invested_before, principal, rate, started_on, matures_on, payee_key)
         values ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         returning ${investmentColumns}`,
        [
          ownerId, input.name, input.kind, input.provider ?? "", input.currency ?? "GHS", input.investedBefore ?? "0", input.principal ?? null,
          input.rate ?? null, input.startedOn ?? null, input.maturesOn ?? null, input.payeeKey ?? null,
        ],
      );
      return fromRow(rows[0]);
    },
    async update(ownerId, id, patch) {
      const sets: string[] = [];
      const values: unknown[] = [ownerId, id];
      for (const [key, column] of Object.entries(PATCH_COLUMNS) as [keyof InvestmentPatch, string][]) {
        if (patch[key] === undefined) continue;
        values.push(patch[key]);
        sets.push(`${column} = $${values.length}`);
      }
      if (sets.length === 0) return;
      await query(settings, `update public.investments set ${sets.join(", ")}, updated_at = now() where owner_id = $1::uuid and id = $2::uuid`, values);
    },
    async holdings(ownerId) {
      const rows = await query<{ investment_id: string; symbol: string; quantity: string; cost: string | null }>(
        settings,
        "select investment_id::text, symbol, quantity::text, cost::text from public.investment_holdings where owner_id = $1::uuid order by symbol",
        [ownerId],
      );
      return rows.map((row) => ({ investmentId: row.investment_id, symbol: row.symbol, quantity: Number(row.quantity), cost: row.cost == null ? null : money(row.cost) }));
    },
    async setHoldings(ownerId, investmentId, holdings) {
      for (const holding of holdings) {
        if (holding.quantity <= 0) {
          await query(settings, "delete from public.investment_holdings where owner_id = $1::uuid and investment_id = $2::uuid and symbol = $3", [ownerId, investmentId, holding.symbol]);
          continue;
        }
        await query(
          settings,
          `insert into public.investment_holdings (investment_id, owner_id, symbol, quantity, cost) values ($1::uuid, $2::uuid, $3, $4, $5)
           on conflict (investment_id, symbol) do update
           set quantity = excluded.quantity, cost = coalesce(excluded.cost, public.investment_holdings.cost), updated_at = now()`,
          [investmentId, ownerId, holding.symbol, holding.quantity, holding.cost ?? null],
        );
      }
    },
    async latestValues(ownerId) {
      const rows = await query<{ investment_id: string; value: string; as_of: Date; source: ReportedValue["source"] }>(
        settings,
        `select distinct on (investment_id) investment_id::text, value::text, as_of, source
         from public.investment_values where owner_id = $1::uuid
         order by investment_id, as_of desc, created_at desc`,
        [ownerId],
      );
      return rows.map((row) => ({ investmentId: row.investment_id, value: money(row.value), asOf: row.as_of.toISOString(), source: row.source }));
    },
    async addValue(ownerId, investmentId, value, asOf, source) {
      await query(settings, "insert into public.investment_values (investment_id, owner_id, value, as_of, source) values ($1::uuid, $2::uuid, $3, $4, $5)", [
        investmentId, ownerId, value, asOf, source,
      ]);
    },
    async contributions(ownerId) {
      const rows = await query<{ id: string; investment_id: string; amount: string; currency: string; occurred_on: string; bank_message_id: string | null; note: string }>(
        settings,
        `select id::text, investment_id::text, amount::text, currency, to_char(occurred_on, 'YYYY-MM-DD') as occurred_on, bank_message_id::text, note
         from public.investment_contributions where owner_id = $1::uuid order by occurred_on, created_at`,
        [ownerId],
      );
      return rows.map((row) => ({
        id: row.id,
        investmentId: row.investment_id,
        amount: money(row.amount),
        currency: row.currency,
        occurredOn: row.occurred_on,
        bankMessageId: row.bank_message_id,
        note: row.note,
      }));
    },
    async addContribution(ownerId, input) {
      const rows = await query<{ id: string }>(
        settings,
        `insert into public.investment_contributions (investment_id, owner_id, amount, currency, occurred_on, bank_message_id, note)
         values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7) returning id::text`,
        [input.investmentId, ownerId, input.amount, input.currency, input.occurredOn, input.bankMessageId, input.note.slice(0, 200)],
      );
      return { ...input, id: rows[0].id };
    },
    async removeContribution(ownerId, id) {
      await query(settings, "delete from public.investment_contributions where owner_id = $1::uuid and id = $2::uuid", [ownerId, id]);
    },
    async prices(keys) {
      if (keys.length === 0) return [];
      const rows = await query<{ market: Market; symbol: string; price: string; currency: string; as_of: string; fetched_at: Date }>(
        settings,
        `select market, symbol, price::text, currency, to_char(as_of, 'YYYY-MM-DD') as as_of, fetched_at from public.market_prices
         where (market, symbol) in (select * from unnest($1::text[], $2::text[]))`,
        [keys.map((key) => key.market), keys.map((key) => key.symbol)],
      );
      return rows.map((row) => ({ market: row.market, symbol: row.symbol, price: Number(row.price), currency: row.currency, asOf: row.as_of, fetchedAt: row.fetched_at.toISOString() }));
    },
    async savePrices(prices) {
      for (const price of prices) {
        await query(
          settings,
          `insert into public.market_prices (market, symbol, price, currency, as_of, fetched_at) values ($1, $2, $3, $4, $5, now())
           on conflict (market, symbol) do update set price = excluded.price, currency = excluded.currency, as_of = excluded.as_of, fetched_at = now()`,
          [price.market, price.symbol, price.price, price.currency, price.asOf],
        );
      }
    },
    async heldSymbols() {
      const rows = await query<{ market: Market; symbol: string }>(
        settings,
        `select distinct case i.kind when 'us_stocks' then 'us' else 'gse' end as market, h.symbol
         from public.investment_holdings h join public.investments i on i.id = h.investment_id
         where i.status = 'active' and i.kind in ('us_stocks', 'gse_stocks')`,
      );
      return rows;
    },
    async maturingBy(until) {
      const rows = await query<InvestmentRow>(
        settings,
        `select ${investmentColumns} from public.investments
         where status = 'active' and kind in ('tbill', 'fixed_deposit', 'bond') and matures_on is not null and matures_on <= $1 and reminded_at is null`,
        [until],
      );
      return rows.map(fromRow);
    },
  };
}

function withoutOwner(row: Contribution & { ownerId: string }): Contribution {
  return { id: row.id, investmentId: row.investmentId, amount: row.amount, currency: row.currency, occurredOn: row.occurredOn, bankMessageId: row.bankMessageId, note: row.note };
}

/** In-memory store for tests. */
export class MemoryInvestmentStore implements InvestmentStore {
  items: Investment[] = [];
  holdingRows: (Holding & { ownerId: string })[] = [];
  valueRows: (ReportedValue & { ownerId: string })[] = [];
  contributionRows: (Contribution & { ownerId: string })[] = [];
  priceRows: Price[] = [];

  async list(ownerId: string) {
    return this.items.filter((item) => item.ownerId === ownerId && item.status === "active").map((item) => ({ ...item }));
  }
  async create(ownerId: string, input: NewInvestment) {
    const investment: Investment = {
      id: `10000000-0000-4000-8000-${String(this.items.length + 1).padStart(12, "0")}`,
      ownerId,
      name: input.name,
      kind: input.kind,
      provider: input.provider ?? "",
      currency: input.currency ?? "GHS",
      investedBefore: input.investedBefore ?? "0.00",
      principal: input.principal ?? null,
      rate: input.rate ?? null,
      startedOn: input.startedOn ?? null,
      maturesOn: input.maturesOn ?? null,
      remindedAt: null,
      payeeKey: input.payeeKey ?? null,
      status: "active",
    };
    this.items.push(investment);
    return { ...investment };
  }
  async update(ownerId: string, id: string, patch: InvestmentPatch) {
    const item = this.items.find((entry) => entry.ownerId === ownerId && entry.id === id);
    if (item) Object.assign(item, Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)));
  }
  async holdings(ownerId: string) {
    return this.holdingRows.filter((row) => row.ownerId === ownerId).map((row) => ({ investmentId: row.investmentId, symbol: row.symbol, quantity: row.quantity, cost: row.cost }));
  }
  async setHoldings(ownerId: string, investmentId: string, holdings: { symbol: string; quantity: number; cost?: string | null }[]) {
    for (const holding of holdings) {
      this.holdingRows = this.holdingRows.filter((row) => !(row.investmentId === investmentId && row.symbol === holding.symbol));
      if (holding.quantity > 0) this.holdingRows.push({ ownerId, investmentId, symbol: holding.symbol, quantity: holding.quantity, cost: holding.cost ?? null });
    }
  }
  async latestValues(ownerId: string) {
    const newest = new Map<string, ReportedValue>();
    for (const row of this.valueRows.filter((entry) => entry.ownerId === ownerId)) {
      const current = newest.get(row.investmentId);
      if (!current || row.asOf >= current.asOf) newest.set(row.investmentId, { investmentId: row.investmentId, value: row.value, asOf: row.asOf, source: row.source });
    }
    return [...newest.values()];
  }
  async addValue(ownerId: string, investmentId: string, value: string, asOf: string, source: ReportedValue["source"]) {
    this.valueRows.push({ ownerId, investmentId, value, asOf, source });
  }
  async contributions(ownerId: string) {
    return this.contributionRows.filter((row) => row.ownerId === ownerId).map((row) => withoutOwner(row));
  }
  async addContribution(ownerId: string, input: NewContribution) {
    const row = { ...input, ownerId, id: `20000000-0000-4000-8000-${String(this.contributionRows.length + 1).padStart(12, "0")}` };
    this.contributionRows.push(row);
    return withoutOwner(row);
  }
  async removeContribution(ownerId: string, id: string) {
    this.contributionRows = this.contributionRows.filter((row) => !(row.ownerId === ownerId && row.id === id));
  }
  async prices(keys: { market: Market; symbol: string }[]) {
    return this.priceRows.filter((row) => keys.some((key) => key.market === row.market && key.symbol === row.symbol));
  }
  /** What "now" is when prices are saved; tests move it on to a later day. */
  clock = () => new Date();
  async savePrices(prices: Price[]) {
    for (const price of prices) {
      this.priceRows = this.priceRows.filter((row) => !(row.market === price.market && row.symbol === price.symbol));
      this.priceRows.push({ ...price, fetchedAt: this.clock().toISOString() });
    }
  }
  async heldSymbols() {
    const kinds = new Map(this.items.map((item) => [item.id, item.kind]));
    const seen = new Map<string, { market: Market; symbol: string }>();
    for (const row of this.holdingRows) {
      const market = marketFor(kinds.get(row.investmentId) ?? "other");
      if (market) seen.set(`${market}:${row.symbol}`, { market, symbol: row.symbol });
    }
    return [...seen.values()];
  }
  async maturingBy(until: string) {
    return this.items.filter((item) => item.status === "active" && FIXED_INCOME.includes(item.kind) && item.maturesOn && item.maturesOn <= until && !item.remindedAt);
  }
}
