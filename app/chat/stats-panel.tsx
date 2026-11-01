"use client";

import Link from "next/link";
import { useId } from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis } from "recharts";

import { NeedsLabel } from "@/app/components/needs-label";
import { categoryColor } from "@/app/components/ui";
import { categoryTotals, dailySeries, inRows, presetRange, sumMinor } from "@/lib/finance/analytics";
import { formatAmount, formatMinor } from "@/lib/finance/money";
import type { Ledger } from "@/lib/web/ledger";

/** The at-a-glance month beside the chat. */
export function StatsPanel({ ledger }: { ledger: Ledger }) {
  // The panel can render twice (side column and phone sheet), so gradient ids must be unique.
  const fillId = `alfred-panel-fill-${useId().replace(/:/g, "")}`;
  const range = presetRange("this_month", ledger.today);
  const elapsed = { start: range.start, end: ledger.today < range.end ? ledger.today : range.end };
  const spent = inRows(ledger.rows, range, ledger.currency, "expense");
  const income = sumMinor(inRows(ledger.rows, range, ledger.currency, "income"));
  const spentMinor = sumMinor(spent);
  const categories = categoryTotals(spent).slice(0, 4);
  const days = dailySeries(ledger.rows, elapsed, ledger.currency).map((day) => ({ ...day, value: day.cumulative / 100 }));
  const budgets = ledger.budgets.filter((budget) => budget.period === ledger.today.slice(0, 7));
  const money = (minor: number) => formatMinor(minor, ledger.currency);
  // The most telling server-computed finding: a repeated spend, then a budget warning, then the biggest shift.
  const highlight =
    ledger.insights.find((line) => line.startsWith("Repeated spend")) ??
    ledger.insights.find((line) => / budget (is over|has)/.test(line)) ??
    ledger.insights.find((line) => line.includes("moved the most"));
  const month = new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "UTC" }).format(new Date(`${range.start}T00:00:00Z`));

  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="text-xs text-muted">{month} so far</p>
        <p className="mt-1 text-3xl font-medium tracking-tight tabular-nums">{money(spentMinor)}</p>
        <p className="mt-1 text-xs text-muted">
          {income > 0 ? (
            <>
              of {money(income)} income ·{" "}
              <span className={income - spentMinor >= 0 ? "text-success" : "text-danger"}>
                {income - spentMinor >= 0 ? `${money(income - spentMinor)} left` : `${money(spentMinor - income)} over`}
              </span>
            </>
          ) : (
            "spent this month"
          )}
        </p>
        {ledger.bank.balances.length > 0 ? (
          <p className="mt-2 flex flex-wrap gap-x-2 text-xs text-muted">
            {ledger.bank.balances.map((item, index) => (
              <span key={item.source} title={`As of ${new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Accra" }).format(new Date(item.at))}, from your bank's last message`}>
                {index > 0 ? <span aria-hidden="true">· </span> : null}
                {item.label} <span className="tabular-nums text-ink">{formatAmount(item.balance, ledger.currency)}</span>
              </span>
            ))}
          </p>
        ) : null}
      </div>

      {ledger.bank.needsLabel.length > 0 ? (
        <section>
          <h3 className="mb-2 text-xs font-medium text-muted">Needs a label ({ledger.bank.needsLabel.length})</h3>
          <NeedsLabel compact items={ledger.bank.needsLabel} limit={3} />
        </section>
      ) : null}

      {spentMinor > 0 ? (
        <div className="h-24" aria-label={`Spending so far this month: ${money(spentMinor)}`} role="img">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={days} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="label" hide />
              <Tooltip
                contentStyle={{ background: "var(--surface)", border: "1px solid var(--line-strong)", borderRadius: 12, color: "var(--ink)", fontSize: 12 }}
              itemStyle={{ color: "var(--ink)" }}
                formatter={(_value, _name, entry) => [money((entry.payload as { cumulative: number }).cumulative), "By then"]}
                labelStyle={{ color: "var(--muted)" }}
              />
              <Area type="monotone" dataKey="value" stroke="var(--accent)" strokeWidth={2} fill={`url(#${fillId})`} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      ) : null}

      <section>
        <h3 className="mb-2 text-xs font-medium text-muted">Top categories</h3>
        {categories.length === 0 ? (
          <p className="text-sm text-faint">Nothing spent yet this month.</p>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {categories.map((item, index) => (
              <li key={item.category}>
                <div className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2">
                    <span className="size-2 rounded-full" style={{ background: categoryColor(index) }} aria-hidden="true" />
                    {item.category}
                  </span>
                  <span className="tabular-nums text-muted">{money(item.minor)}</span>
                </div>
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-2">
                  <div className="h-full rounded-full" style={{ width: `${Math.max(4, (item.minor / spentMinor) * 100)}%`, background: categoryColor(index) }} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {budgets.length > 0 ? (
        <section>
          <h3 className="mb-2 text-xs font-medium text-muted">Budgets</h3>
          <ul className="flex flex-col gap-2.5">
            {budgets.map((budget) => {
              const used = budget.budgetMinor > 0 ? Math.min(100, (budget.spentMinor / budget.budgetMinor) * 100) : 0;
              const over = budget.remainingMinor < 0;
              return (
                <li key={budget.budgetId}>
                  <div className="flex justify-between text-sm">
                    <span>{budget.category}</span>
                    <span className={`tabular-nums ${over ? "text-danger" : "text-muted"}`}>
                      {over ? `${formatMinor(-budget.remainingMinor, budget.currency)} over` : `${formatMinor(budget.remainingMinor, budget.currency)} left`}
                    </span>
                  </div>
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-2">
                    <div className={`h-full rounded-full ${over ? "bg-danger" : used >= 80 ? "bg-accent" : "bg-success"}`} style={{ width: `${used}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {highlight ? (
        <section className="rounded-xl border border-accent/20 bg-accent-soft p-3">
          <h3 className="text-xs font-medium text-accent">Worth knowing</h3>
          <p className="mt-1 text-sm leading-5 text-ink">{highlight}</p>
        </section>
      ) : null}

      <Link href="/dashboard" className="text-sm text-accent underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-accent">
        Open the full dashboard →
      </Link>
    </div>
  );
}
