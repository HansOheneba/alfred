"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";

import { Button, Card, Dialog, EmptyState, Field, categoryColor, inputClass } from "@/app/components/ui";
import { Spinner } from "@/app/components/status";
import { formatMinor } from "@/lib/finance/money";
import { INVESTMENT_KINDS, KIND_LABELS, type InvestmentKind } from "@/lib/investments/kinds";
import type { Contribution } from "@/lib/investments/store";
import type { InvestmentView, Portfolio } from "@/lib/investments/value";

export type InvestmentsData = {
  portfolio: Portfolio;
  cash: { label: string; balance: number; at: string }[];
  contributions: (Contribution & { investment: string })[];
};

const money = (value: number, currency = "GHS") => formatMinor(Math.round(value * 100), currency);
const shortDate = (iso: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${iso.slice(0, 10)}T00:00:00Z`));
const FIXED: InvestmentKind[] = ["tbill", "fixed_deposit", "bond"];

/** "GH₵12,430" big with ".00" small, like a banking app's balance. */
function BigMoney({ value }: { value: number }) {
  const [whole, cents] = money(value).split(".");
  return (
    <span className="tabular-nums">
      <span className="text-4xl font-semibold tracking-tight sm:text-5xl">{whole}</span>
      <span className="text-xl font-semibold text-muted">.{cents}</span>
    </span>
  );
}

function Gain({ gain, base }: { gain: number | null; base: number }) {
  if (gain === null || base <= 0) return <span className="text-muted">—</span>;
  const up = gain >= 0;
  return (
    <span className={`tabular-nums ${up ? "text-income" : "text-outgoing"}`}>
      {up ? "+" : "−"}
      {money(Math.abs(gain))} ({up ? "+" : "−"}
      {Math.abs((gain / base) * 100).toFixed(1)}%)
    </span>
  );
}

/** Where a value came from and how fresh it is, in a few words. */
function provenance(item: InvestmentView): string {
  if (item.source === "prices") return `Closing prices, ${shortDate(item.asOf!)}`;
  if (item.source === "reported") return `You told Alfred, ${shortDate(item.asOf!)}`;
  if (item.source === "rate") return `Grown at ${item.investment.rate}% a year`;
  if (item.source === "invested") return "What you put in · no current value yet";
  return "No value yet";
}

async function post(body: unknown): Promise<{ ok: true; portfolio: Portfolio } | { ok: false; text: string }> {
  try {
    const response = await fetch("/api/investments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await response.json()) as { ok: true; portfolio: Portfolio } | { ok: false; text: string };
  } catch {
    return { ok: false, text: "Alfred couldn't be reached. Try again." };
  }
}

export function InvestmentsClient({ initial }: { initial: InvestmentsData }) {
  const [portfolio, setPortfolio] = useState(initial.portfolio);
  const [adding, setAdding] = useState(false);
  const cash = initial.cash.reduce((sum, item) => sum + item.balance, 0);
  const maturing = portfolio.items.filter((item) => item.maturity && item.maturity.daysLeft >= -7).sort((a, b) => a.maturity!.date.localeCompare(b.maturity!.date));

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-6 pb-16 sm:px-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium tracking-[0.14em] text-muted">YOUR INVESTMENTS</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">What you own, at a glance.</h1>
          <p className="mt-1 text-sm text-muted">What it&apos;s worth, what you put in, and what&apos;s coming up.</p>
        </div>
        <Button variant="primary" onClick={() => setAdding(true)}>
          Add investment
        </Button>
      </header>

      <section className="grid overflow-hidden rounded-2xl border border-line bg-surface md:grid-cols-[1.3fr_1fr]">
        <div className="p-5 sm:p-6">
          <p className="text-sm font-medium text-muted">Net worth</p>
          <p className="mt-2">
            <BigMoney value={cash + portfolio.totalGhs} />
          </p>
          <p className="mt-3 text-sm text-muted">
            {money(cash)} in your accounts · {money(portfolio.totalGhs)} invested
          </p>
          {initial.cash.length > 0 ? (
            <p className="mt-1 text-xs text-faint">
              Accounts: {initial.cash.map((item) => `${item.label} ${money(item.balance)}`).join(" · ")}, from your latest bank texts
            </p>
          ) : null}
        </div>
        <dl className="grid grid-cols-2 gap-px border-t border-line bg-line md:grid-cols-1 md:border-l md:border-t-0">
          <div className="bg-surface p-4 sm:px-6">
            <dt className="text-xs text-muted">Investments are worth</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums">{money(portfolio.totalGhs)}</dd>
          </div>
          <div className="bg-surface p-4 sm:px-6">
            <dt className="text-xs text-muted">You put in</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums">{money(portfolio.investedGhs)}</dd>
          </div>
          <div className="col-span-2 bg-surface p-4 sm:px-6 md:col-span-1">
            <dt className="text-xs text-muted">Gain so far</dt>
            <dd className="mt-1 text-lg font-semibold">
              <Gain gain={portfolio.gainGhs} base={portfolio.investedGhs} />
            </dd>
          </div>
        </dl>
      </section>

      {portfolio.items.length === 0 ? (
        <Card>
          <EmptyState>
            No investments yet. Add one here, or tell Alfred in{" "}
            <Link href="/chat" className="text-accent underline-offset-2 hover:underline">
              chat
            </Link>
            : &ldquo;I have $1,200 in Risevest&rdquo;, &ldquo;I bought a 91-day T-bill of 5,000 at 24%&rdquo;, or send a screenshot of your investment app.
          </EmptyState>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            <Card title="Where it's invested">
              <Allocation portfolio={portfolio} />
            </Card>
            <Card title="Coming up">
              {maturing.length > 0 ? (
                <ul className="flex flex-col divide-y divide-line">
                  {maturing.map((item) => (
                    <li key={item.investment.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                      <span>
                        <span className="font-medium text-ink">{item.investment.name}</span>
                        <span className="block text-xs text-muted">
                          {item.maturity!.daysLeft > 0 ? `Matures ${shortDate(item.maturity!.date)} · in ${item.maturity!.daysLeft} day${item.maturity!.daysLeft === 1 ? "" : "s"}` : item.maturity!.daysLeft === 0 ? "Matures today" : `Matured ${shortDate(item.maturity!.date)}`}
                        </span>
                      </span>
                      {item.maturity!.valueAtMaturity !== null ? <span className="font-medium tabular-nums">{money(item.maturity!.valueAtMaturity, item.investment.currency)}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted">Nothing maturing. T-bills, fixed deposits and bonds show here, and Alfred reminds you on Telegram a few days before.</p>
              )}
            </Card>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            {portfolio.items.map((item) => (
              <InvestmentCard key={item.investment.id} item={item} onChange={setPortfolio} />
            ))}
          </div>
        </>
      )}

      {initial.contributions.length > 0 ? (
        <Card title="Money in and out">
          <ul className="flex flex-col divide-y divide-line text-sm">
            {initial.contributions.map((item) => {
              const out = Number(item.amount) < 0;
              return (
                <li key={item.id} className="flex items-center justify-between gap-3 py-2.5">
                  <span>
                    <span className="text-ink">{out ? `Out of ${item.investment}` : `Into ${item.investment}`}</span>
                    <span className="block text-xs text-muted">
                      {shortDate(item.occurredOn)}
                      {item.note ? ` · ${item.note}` : ""}
                    </span>
                  </span>
                  <span className={`tabular-nums ${out ? "text-income" : "text-ink"}`}>{money(Math.abs(Number(item.amount)), item.currency)}</span>
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}

      <p className="text-xs leading-5 text-faint">
        Money you put into investments isn&apos;t counted as spending. US prices are daily closing prices; Ghana prices come from the Ghana Stock Exchange&apos;s daily board.
        {portfolio.usdGhs ? ` Dollars are converted at ${money(portfolio.usdGhs)} per $1.` : ""}
        {portfolio.unconverted.length ? ` Not in the totals (no cedi rate): ${portfolio.unconverted.join(", ")}.` : ""}
      </p>

      <AddInvestment open={adding} onClose={() => setAdding(false)} onSaved={setPortfolio} />
    </div>
  );
}

function Allocation({ portfolio }: { portfolio: Portfolio }) {
  const data = portfolio.byKind.filter((item) => item.valueGhs > 0);
  if (data.length === 0) return <p className="text-sm text-muted">Add values to see how your money is spread.</p>;
  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row">
      <div className="h-40 w-40 shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Tooltip formatter={(value) => money(Number(value))} contentStyle={{ background: "var(--surface)", border: "1px solid var(--line-strong)", borderRadius: 12, color: "var(--ink)", fontSize: 12 }} />
            <Pie data={data} dataKey="valueGhs" nameKey="label" innerRadius="60%" outerRadius="95%" paddingAngle={2} stroke="var(--surface)" strokeWidth={2}>
              {data.map((item, index) => (
                <Cell key={item.kind} fill={categoryColor(index)} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="flex w-full flex-col gap-2 text-sm">
        {data.map((item, index) => (
          <li key={item.kind} className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2">
              <span className="size-2.5 rounded-full" style={{ background: categoryColor(index) }} aria-hidden="true" />
              {item.label}
            </span>
            <span className="tabular-nums text-muted">
              {((item.valueGhs / portfolio.totalGhs) * 100).toFixed(0)}% · <span className="text-ink">{money(item.valueGhs)}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function InvestmentCard({ item, onChange }: { item: InvestmentView; onChange: (portfolio: Portfolio) => void }) {
  const { investment } = item;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });

  async function save(event: FormEvent) {
    event.preventDefault();
    setState({ busy: true, error: null });
    const result = await post({ op: "value", id: investment.id, value });
    if (!result.ok) return setState({ busy: false, error: result.text });
    onChange(result.portfolio);
    setEditing(false);
    setValue("");
    setState({ busy: false, error: null });
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold">{investment.name}</h2>
          <p className="mt-0.5 text-xs text-muted">
            {item.kindLabel}
            {investment.provider && investment.provider !== investment.name ? ` · ${investment.provider}` : ""}
            {investment.currency !== "GHS" ? ` · in ${investment.currency}` : ""}
          </p>
        </div>
        {item.stale ? <span className="shrink-0 rounded-full bg-surface-2 px-2.5 py-1 text-[11px] font-medium text-muted">Out of date</span> : null}
      </div>

      <p className="mt-4 text-2xl font-semibold tracking-tight tabular-nums">{item.value === null ? "—" : money(item.value, investment.currency)}</p>
      {investment.currency !== "GHS" && item.valueGhs !== null ? <p className="text-sm text-muted tabular-nums">≈ {money(item.valueGhs)}</p> : null}
      <p className="mt-1 text-xs text-faint">{provenance(item)}</p>

      <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-3 text-sm">
        <div>
          <dt className="text-xs text-muted">Put in</dt>
          <dd className="tabular-nums">{item.investedGhs > 0 ? money(item.investedGhs) : "—"}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Gain</dt>
          <dd>{item.source === "invested" ? <span className="text-muted">—</span> : <Gain gain={item.gainGhs} base={item.investedGhs} />}</dd>
        </div>
      </dl>

      {item.holdings.length > 0 ? (
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th className="py-1 font-normal">Holding</th>
              <th className="py-1 text-right font-normal">Units</th>
              <th className="py-1 text-right font-normal">Price</th>
              <th className="py-1 text-right font-normal">Value</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {item.holdings.map((holding) => (
              <tr key={holding.symbol} className="border-t border-line">
                <td className="py-1.5 font-medium">{holding.symbol}</td>
                <td className="py-1.5 text-right">{holding.quantity}</td>
                <td className="py-1.5 text-right">{holding.price === null ? "—" : money(holding.price, investment.currency)}</td>
                <td className="py-1.5 text-right">{holding.value === null ? "—" : money(holding.value, investment.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {item.maturity ? (
        <p className="mt-3 rounded-xl bg-surface-2 px-3 py-2 text-xs text-muted">
          {item.maturity.daysLeft >= 0 ? `Matures ${shortDate(item.maturity.date)}` : `Matured ${shortDate(item.maturity.date)}`}
          {item.maturity.valueAtMaturity !== null ? ` · about ${money(item.maturity.valueAtMaturity, investment.currency)} then` : ""}
        </p>
      ) : null}

      {editing ? (
        <form onSubmit={save} className="mt-4 flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor={`value-${investment.id}`}>
            What it&apos;s worth now
          </label>
          <input
            id={`value-${investment.id}`}
            inputMode="decimal"
            autoFocus
            className={`${inputClass} h-9 max-w-40`}
            placeholder={`Worth now (${investment.currency})`}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <Button type="submit" variant="primary" size="sm" disabled={state.busy || !value.trim()}>
            {state.busy ? <Spinner /> : null}
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          {state.error ? <p className="w-full text-xs text-danger">{state.error}</p> : null}
        </form>
      ) : (
        <div className="mt-4 flex gap-2">
          <Button size="sm" onClick={() => setEditing(true)}>
            Update value
          </Button>
        </div>
      )}
    </Card>
  );
}

function AddInvestment({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: (portfolio: Portfolio) => void }) {
  const [form, setForm] = useState({ name: "", kind: "us_stocks" as InvestmentKind, currency: "USD", value: "", principal: "", rate: "", maturesOn: "" });
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const fixed = FIXED.includes(form.kind);
  const set = (patch: Partial<typeof form>) => setForm((current) => ({ ...current, ...patch }));

  async function save(event: FormEvent) {
    event.preventDefault();
    setState({ busy: true, error: null });
    const result = await post({
      op: "add",
      name: form.name,
      kind: form.kind,
      currency: form.currency,
      value: fixed ? null : form.value || null,
      principal: fixed ? form.principal || null : null,
      rate: fixed && form.rate ? Number(form.rate) : null,
      maturesOn: fixed && form.maturesOn ? form.maturesOn : null,
    });
    if (!result.ok) return setState({ busy: false, error: result.text });
    onSaved(result.portfolio);
    setForm({ name: "", kind: "us_stocks", currency: "USD", value: "", principal: "", rate: "", maturesOn: "" });
    setState({ busy: false, error: null });
    onClose();
  }

  return (
    <Dialog open={open} onClose={onClose} title="Add an investment">
      <form onSubmit={save} className="flex flex-col gap-4">
        <Field label="Name">
          <input className={inputClass} value={form.name} onChange={(event) => set({ name: event.target.value })} placeholder="Risevest, 91-day T-bill, Databank Epack…" maxLength={80} required />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Kind">
            <select className={inputClass} value={form.kind} onChange={(event) => set({ kind: event.target.value as InvestmentKind, currency: event.target.value === "us_stocks" ? "USD" : "GHS" })}>
              {INVESTMENT_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {KIND_LABELS[kind]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Currency">
            <select className={inputClass} value={form.currency} onChange={(event) => set({ currency: event.target.value })}>
              <option value="GHS">Cedis (GHS)</option>
              <option value="USD">Dollars (USD)</option>
            </select>
          </Field>
        </div>
        {fixed ? (
          <div className="grid grid-cols-3 gap-3">
            <Field label="Amount">
              <input className={inputClass} inputMode="decimal" value={form.principal} onChange={(event) => set({ principal: event.target.value })} placeholder="5000" />
            </Field>
            <Field label="Rate %">
              <input className={inputClass} inputMode="decimal" value={form.rate} onChange={(event) => set({ rate: event.target.value })} placeholder="24" />
            </Field>
            <Field label="Matures">
              <input className={inputClass} type="date" value={form.maturesOn} onChange={(event) => set({ maturesOn: event.target.value })} />
            </Field>
          </div>
        ) : (
          <Field label="Worth now (optional)" hint="Or tell Alfred in chat later, or send a screenshot of your investment app.">
            <input className={inputClass} inputMode="decimal" value={form.value} onChange={(event) => set({ value: event.target.value })} placeholder={form.currency === "USD" ? "1200" : "8400"} />
          </Field>
        )}
        {form.kind === "us_stocks" || form.kind === "gse_stocks" ? (
          <p className="text-xs leading-5 text-muted">To price it every day, tell Alfred what you hold, like &ldquo;my Risevest has 2 VOO and 0.5 MSFT&rdquo;.</p>
        ) : null}
        {state.error ? <p className="text-sm text-danger">{state.error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={state.busy || !form.name.trim()}>
            {state.busy ? <Spinner /> : null}
            Add
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
