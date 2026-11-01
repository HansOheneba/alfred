"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { Card, EmptyState, Stat, categoryColor } from "@/app/components/ui";
import { BillsCard } from "@/app/dashboard/bills-card";
import { CategoryDonut, DailyChart, MonthlyChart, SimpleBars } from "@/app/dashboard/charts";
import { compactMoney, delta, percent } from "@/app/dashboard/helpers";
import { CashFlowSankey } from "@/app/dashboard/sankey-chart";
import { TransactionsTable } from "@/app/dashboard/transactions-table";
import {
  RANGE_LABELS,
  accountTotals,
  buildSankeyModel,
  categoryTotals,
  dailySeries,
  inRows,
  monthlySeries,
  presetRange,
  previousRange,
  sumMinor,
  topDescriptions,
  weekdaySeries,
  weeklyPace,
  type RangePreset,
} from "@/lib/finance/analytics";
import { formatDisplayDate, inclusiveDays } from "@/lib/finance/dates";
import { formatAmount, formatMinor, toMinor } from "@/lib/finance/money";
import type { Ledger } from "@/lib/web/ledger";

const PRESETS = Object.keys(RANGE_LABELS) as RangePreset[];

function lastTwelveMonths(today: string) {
  const [year, month] = today.split("-").map(Number);
  const start = new Date(Date.UTC(year, month - 12, 1)).toISOString().slice(0, 10);
  const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return { start, end };
}

export function DashboardClient({ ledger, name }: { ledger: Ledger; name: string }) {
  const { currency, today } = ledger;
  const [preset, setPreset] = useState<RangePreset>("this_month");
  const [selected, setSelected] = useState<string | null>(null);
  const [dailyMode, setDailyMode] = useState<"daily" | "cumulative">("daily");

  const rows = useMemo(() => ledger.rows.filter((row) => row.currency === currency), [ledger.rows, currency]);
  const otherCurrencyCount = ledger.rows.length - rows.length;
  const range = useMemo(() => presetRange(preset, today, rows), [preset, today, rows]);
  const previous = useMemo(() => previousRange(range), [range]);

  const expenses = useMemo(() => inRows(rows, range, currency, "expense"), [rows, range, currency]);
  const income = useMemo(() => inRows(rows, range, currency, "income"), [rows, range, currency]);
  const spent = sumMinor(expenses);
  const earned = sumMinor(income);
  const prevSpent = sumMinor(inRows(rows, previous, currency, "expense"));
  const prevEarned = sumMinor(inRows(rows, previous, currency, "income"));
  const net = earned - spent;
  const prevNet = prevEarned - prevSpent;

  // Average over days elapsed, so a month in progress isn't divided by 31.
  const elapsedEnd = today < range.end ? today : range.end;
  const days = elapsedEnd >= range.start ? inclusiveDays({ start: range.start, end: elapsedEnd }) : 1;
  const daily = Math.round(spent / days);
  const prevDaily = Math.round(prevSpent / inclusiveDays(previous));

  const categories = useMemo(() => categoryTotals(expenses), [expenses]);
  const accounts = useMemo(() => accountTotals(expenses), [expenses]);
  const sankey = useMemo(() => buildSankeyModel(income, expenses), [income, expenses]);
  const pace = useMemo(() => weeklyPace(rows, today, currency), [rows, today, currency]);
  const monthly = useMemo(() => monthlySeries(rows, lastTwelveMonths(today), currency), [rows, today, currency]);
  const dailyData = useMemo(() => dailySeries(rows, { start: range.start, end: elapsedEnd >= range.start ? elapsedEnd : range.end }, currency), [rows, range, elapsedEnd, currency]);
  const weekdays = useMemo(() => weekdaySeries(expenses), [expenses]);

  const selectedRows = useMemo(() => (selected ? expenses.filter((row) => row.category === selected) : []), [expenses, selected]);
  const selectedTrend = useMemo(
    () =>
      selected
        ? monthlySeries(rows.filter((row) => row.category === selected), lastTwelveMonths(today), currency)
            .slice(-6)
            .map((item) => ({ label: item.label, spent: item.spent }))
        : [],
    [rows, selected, today, currency],
  );
  const tableRows = useMemo(() => [...expenses, ...income], [expenses, income]);

  const month = today.slice(0, 7);
  const budgets = ledger.budgets.filter((budget) => budget.period === month);
  const goals = ledger.goals;
  const hasAny = rows.length > 0;
  const rangeLabel = RANGE_LABELS[preset].toLowerCase();

  function toggle(category: string) {
    setSelected((current) => (current === category ? null : category));
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 pt-6 pb-[calc(2.5rem+env(safe-area-inset-bottom))] sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs text-muted">{formatDisplayDate(today)}</p>
          <h1 className="mt-1 font-display text-2xl font-medium leading-tight tracking-tight">{name ? `${name}'s finances` : "Your finances"}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1 rounded-full border border-line bg-surface p-1" role="group" aria-label="Date range">
            {PRESETS.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => {
                  setPreset(item);
                  setSelected(null);
                }}
                aria-pressed={preset === item}
                className={`rounded-full px-3 py-1.5 text-xs transition focus-visible:outline-2 focus-visible:outline-accent ${
                  preset === item ? "bg-accent text-accent-ink" : "text-muted hover:text-ink"
                }`}
              >
                {RANGE_LABELS[item]}
              </button>
            ))}
          </div>
          <Link
            href="/chat"
            className="inline-flex h-9 items-center rounded-full border border-line-strong px-4 text-sm text-ink transition hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent"
          >
            Talk to Alfred
          </Link>
        </div>
      </div>

      {ledger.bank.balances.length > 0 ? (
        <div className="-mt-1 flex flex-wrap items-center gap-2" aria-label="Latest balances from bank messages">
          {ledger.bank.balances.map((item) => (
            <span
              key={item.source}
              title={`As of ${new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Accra" }).format(new Date(item.at))}, from your bank's last message. Not live.`}
              className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1 text-xs text-muted"
            >
              {item.label}
              <span className="tabular-nums text-ink">{formatAmount(item.balance, currency)}</span>
            </span>
          ))}
          {ledger.bank.needsLabel.length > 0 ? (
            <Link href="/review" className="inline-flex items-center rounded-full bg-accent-soft px-3 py-1 text-xs text-accent hover:underline">
              {ledger.bank.needsLabel.length} need{ledger.bank.needsLabel.length === 1 ? "s" : ""} a label
            </Link>
          ) : null}
        </div>
      ) : null}

      {!hasAny ? (
        <EmptyState>
          Nothing is recorded yet. Tell Alfred what you spent or earned, here in <Link href="/chat" className="text-accent underline-offset-2 hover:underline">chat</Link> or
          on Telegram, and your charts will fill in.
        </EmptyState>
      ) : null}

      {otherCurrencyCount > 0 ? (
        <p className="text-xs text-muted">
          Figures are in {currency}. {otherCurrencyCount} transaction{otherCurrencyCount === 1 ? "" : "s"} in other currencies {otherCurrencyCount === 1 ? "is" : "are"} left out.
        </p>
      ) : null}

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-5" aria-label="Summary">
        <Stat label="Spent" value={formatMinor(spent, currency)} hint={delta(spent, prevSpent, false).text} tone={delta(spent, prevSpent, false).tone} />
        <Stat label="Income" value={formatMinor(earned, currency)} hint={delta(earned, prevEarned, true).text} tone={delta(earned, prevEarned, true).tone} />
        <Stat
          label={net >= 0 ? "Kept" : "Overspent"}
          value={formatMinor(Math.abs(net), currency)}
          hint={earned > 0 ? `${percent(Math.max(net, 0), earned)} of income kept` : delta(net, prevNet, true).text}
          tone={net >= 0 ? "good" : "bad"}
        />
        <Stat label="Daily average" value={formatMinor(daily, currency)} hint={delta(daily, prevDaily, false).text} tone={delta(daily, prevDaily, false).tone} />
        <Stat
          label="This week so far"
          value={formatMinor(pace.thisWeekMinor, currency)}
          hint={
            pace.changePercent !== null
              ? `${pace.changePercent > 0 ? "+" : ""}${pace.changePercent}% vs same days last week (${formatMinor(pace.lastWeekSameStretchMinor, currency)})`
              : pace.lastWeekSameStretchMinor === 0
                ? "Same days last week: none"
                : `Same days last week: ${formatMinor(pace.lastWeekSameStretchMinor, currency)}`
          }
          tone={pace.changePercent !== null ? (pace.changePercent <= 0 ? "good" : "bad") : undefined}
        />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Spending vs income, last 12 months">
          <MonthlyChart data={monthly} currency={currency} />
          <p className="sr-only">
            {monthly.map((item) => `${item.label}: spent ${formatMinor(item.spent, currency)}, income ${formatMinor(item.income, currency)}`).join("; ")}
          </p>
        </Card>
        <Card
          title={`Spending by day · ${rangeLabel}`}
          action={
            <div className="flex rounded-full border border-line p-0.5 text-xs" role="group" aria-label="Chart mode">
              {(["daily", "cumulative"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={dailyMode === mode}
                  onClick={() => setDailyMode(mode)}
                  className={`rounded-full px-2.5 py-1 focus-visible:outline-2 focus-visible:outline-accent ${dailyMode === mode ? "bg-surface-2 text-ink" : "text-muted"}`}
                >
                  {mode === "daily" ? "Daily" : "Running total"}
                </button>
              ))}
            </div>
          }
        >
          {spent === 0 ? <EmptyState>No spending in this range.</EmptyState> : <DailyChart data={dailyData} currency={currency} mode={dailyMode} />}
        </Card>
      </div>

      <Card
        title={`Where the money went · ${rangeLabel}`}
        action={
          selected ? (
            <button type="button" onClick={() => setSelected(null)} className="text-xs text-muted underline-offset-2 hover:text-ink hover:underline">
              Clear selection
            </button>
          ) : null
        }
      >
        {categories.length === 0 ? (
          <EmptyState>No spending in this range.</EmptyState>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
            <div>
              <CategoryDonut data={categories} currency={currency} selected={selected} onSelect={toggle} />
              <ul className="mt-3 flex flex-col gap-1" aria-label="Categories">
                {categories.map((item, index) => (
                  <li key={item.category}>
                    <button
                      type="button"
                      onClick={() => toggle(item.category)}
                      aria-pressed={selected === item.category}
                      className={`flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left text-sm transition focus-visible:outline-2 focus-visible:outline-accent ${
                        selected === item.category ? "bg-surface-2" : "hover:bg-surface-2"
                      }`}
                    >
                      <span className="size-2.5 shrink-0 rounded-full" style={{ background: categoryColor(index) }} aria-hidden="true" />
                      <span className="flex-1">{item.category}</span>
                      <span className="text-xs text-muted">{percent(item.minor, spent)}</span>
                      <span className="w-28 text-right tabular-nums">{formatMinor(item.minor, currency)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-xl border border-line bg-bg p-4">
              {selected ? (
                <>
                  <p className="text-xs text-muted">{selected}</p>
                  <p className="mt-1 text-2xl font-medium tabular-nums">{formatMinor(sumMinor(selectedRows), currency)}</p>
                  <p className="text-xs text-muted">
                    {percent(sumMinor(selectedRows), spent)} of spending · {selectedRows.length} transaction{selectedRows.length === 1 ? "" : "s"}
                  </p>
                  <h3 className="mt-5 text-xs font-medium text-muted">Top places and things</h3>
                  <ul className="mt-2 flex flex-col gap-2">
                    {topDescriptions(selectedRows).map((item) => (
                      <li key={item.label} className="flex items-center justify-between gap-3 text-sm">
                        <span className="truncate">
                          {item.label}
                          {item.count > 1 ? <span className="text-muted"> ×{item.count}</span> : null}
                        </span>
                        <span className="tabular-nums">{formatMinor(item.minor, currency)}</span>
                      </li>
                    ))}
                  </ul>
                  <h3 className="mt-5 text-xs font-medium text-muted">Last 6 months</h3>
                  <SimpleBars data={selectedTrend} currency={currency} height="h-36" />
                </>
              ) : (
                <div className="flex h-full min-h-48 flex-col items-center justify-center gap-2 text-center">
                  <p className="text-sm text-ink">Pick a category</p>
                  <p className="max-w-xs text-xs text-muted">Click a slice or a row to see its biggest items, its trend, and its transactions below.</p>
                </div>
              )}
            </div>
          </div>
        )}
      </Card>

      <Card title={`Where it came from, where it went · ${rangeLabel}`}>
        <CashFlowSankey model={sankey} currency={currency} />
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Alfred's insights · this month">
          {ledger.insights.length === 0 ? (
            <EmptyState>Insights appear once a few expenses are logged.</EmptyState>
          ) : (
            <ul className="flex flex-col gap-2.5">
              {ledger.insights.map((line) => (
                <li key={line} className="flex gap-3 text-sm leading-6">
                  <span className="mt-2 size-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title={`Spending by account · ${rangeLabel}`}>
          {accounts.length === 0 ? (
            <EmptyState>No spending in this range.</EmptyState>
          ) : (
            <div>
              <CategoryDonut
                data={accounts.map((item) => ({ category: item.account, minor: item.minor }))}
                currency={currency}
                selected={null}
                onSelect={() => undefined}
              />
              <ul className="mt-3 flex flex-col gap-1.5" aria-label="Spending by account">
                {accounts.map((item, index) => (
                  <li key={item.account} className="flex items-center gap-2.5 text-sm">
                    <span className="size-2.5 shrink-0 rounded-full" style={{ background: categoryColor(index) }} aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{item.account}</span>
                    <span className="text-xs text-muted">{percent(item.minor, spent)}</span>
                    <span className="w-24 text-right tabular-nums">{formatMinor(item.minor, currency)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
        <Card title={`By weekday · ${rangeLabel}`}>
          {spent === 0 ? (
            <EmptyState>No spending in this range.</EmptyState>
          ) : (
            <>
              <SimpleBars data={weekdays} currency={currency} />
              <p className="sr-only">{weekdays.map((item) => `${item.label}: ${formatMinor(item.spent, currency)}`).join("; ")}</p>
            </>
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <BillsCard
          bills={ledger.bills ?? []}
          upcoming={ledger.upcomingBills ?? []}
          suggestions={ledger.renewalSuggestions ?? []}
          currency={currency}
          today={today}
        />
        <Card title="Budgets · this month" action={<Link href="/settings" className="text-xs text-muted underline-offset-2 hover:text-ink hover:underline">Manage</Link>}>
          {budgets.length === 0 ? (
            <EmptyState>No budgets for this month. Ask Alfred, e.g. &ldquo;Set a food budget of 800&rdquo;.</EmptyState>
          ) : (
            <ul className="flex flex-col gap-4">
              {budgets.map((budget) => {
                const over = budget.remainingMinor < 0;
                const used = budget.budgetMinor > 0 ? Math.min(100, Math.round((budget.spentMinor / budget.budgetMinor) * 100)) : 0;
                return (
                  <li key={budget.budgetId}>
                    <div className="flex items-baseline justify-between gap-3 text-sm">
                      <span>{budget.category}</span>
                      <span className={`tabular-nums text-xs ${over ? "text-danger" : "text-muted"}`}>
                        {formatMinor(budget.spentMinor, budget.currency)} of {formatMinor(budget.budgetMinor, budget.currency)}
                      </span>
                    </div>
                    <div
                      className="mt-2 h-2 overflow-hidden rounded-full bg-surface-2"
                      role="progressbar"
                      aria-label={`${budget.category} budget used`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={used}
                    >
                      <div className={`h-full rounded-full ${over ? "bg-danger" : used >= 80 ? "bg-accent" : "bg-success"}`} style={{ width: `${over ? 100 : used}%` }} />
                    </div>
                    <p className={`mt-1 text-xs ${over ? "text-danger" : "text-muted"}`}>
                      {over ? `${formatMinor(-budget.remainingMinor, budget.currency)} over` : `${formatMinor(budget.remainingMinor, budget.currency)} left`}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Savings goals" action={<Link href="/settings" className="text-xs text-muted underline-offset-2 hover:text-ink hover:underline">Manage</Link>}>
          {goals.length === 0 ? (
            <EmptyState>No savings goals yet. Ask Alfred, e.g. &ldquo;Save 3000 for a laptop by March&rdquo;.</EmptyState>
          ) : (
            <ul className="flex flex-col gap-4">
              {goals.map((goal) => {
                const target = toMinor(goal.targetAmount);
                const current = toMinor(goal.currentAmount);
                const progress = target > 0 ? Math.min(100, Math.round((current / target) * 100)) : 0;
                return (
                  <li key={goal.goalId}>
                    <div className="flex items-baseline justify-between gap-3 text-sm">
                      <span>
                        {goal.name}
                        {goal.status === "completed" ? <span className="ml-2 text-xs text-success">Done</span> : null}
                      </span>
                      <span className="tabular-nums text-xs text-muted">
                        {compactMoney(current, goal.currency)} / {compactMoney(target, goal.currency)}
                      </span>
                    </div>
                    <div
                      className="mt-2 h-2 overflow-hidden rounded-full bg-surface-2"
                      role="progressbar"
                      aria-label={`${goal.name} progress`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={progress}
                    >
                      <div className="h-full rounded-full bg-accent" style={{ width: `${progress}%` }} />
                    </div>
                    <p className="mt-1 text-xs text-muted">
                      {progress}% saved{goal.targetDate ? ` · by ${formatDisplayDate(goal.targetDate)}` : ""}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        <OwedCard owed={ledger.owed} owe={ledger.owe} />
      </div>

      {hasAny ? <TransactionsTable rows={tableRows} category={selected} onClearCategory={() => setSelected(null)} rangeLabel={rangeLabel} /> : null}
    </div>
  );
}

/** Money the person lent out and hasn't had back yet, and what they borrowed and still owe. */
function OwedCard({ owed, owe }: { owed: Ledger["owed"]; owe: Ledger["owe"] }) {
  const total = owed.reduce((sum, item) => sum + toMinor(item.owed), 0);
  return (
    <Card title="Owed to you" action={total > 0 ? <span className="tabular-nums text-xs text-muted">{formatMinor(total, owed[0].currency)}</span> : undefined}>
      {owed.length === 0 && owe.length > 0 ? (
        <p className="text-sm text-muted">No one owes you money.</p>
      ) : owed.length === 0 ? (
        <EmptyState>No one owes you money. Tell Alfred when you lend some, e.g. &ldquo;I lent Kofi 100&rdquo;.</EmptyState>
      ) : (
        <ul className="flex flex-col gap-4">
          {owed.map((item) => {
            const lent = toMinor(item.lent);
            const repaid = toMinor(item.repaid);
            const progress = lent > 0 ? Math.min(100, Math.round((repaid / lent) * 100)) : 0;
            return (
              <li key={item.personKey}>
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate">{item.person}</span>
                  <span className="shrink-0 tabular-nums font-medium">{formatMinor(toMinor(item.owed), item.currency)}</span>
                </div>
                <div
                  className="mt-2 h-2 overflow-hidden rounded-full bg-surface-2"
                  role="progressbar"
                  aria-label={`${item.person} paid back`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={progress}
                >
                  <div className="h-full rounded-full bg-accent" style={{ width: `${progress}%` }} />
                </div>
                <p className="mt-1 text-xs text-muted">
                  {repaid > 0 ? `${compactMoney(repaid, item.currency)} of ${compactMoney(lent, item.currency)} paid back` : `Lent ${compactMoney(lent, item.currency)}`} · since{" "}
                  {formatDisplayDate(item.since.slice(0, 10))}
                </p>
              </li>
            );
          })}
        </ul>
      )}
      {owe.length > 0 ? (
        <div className="mt-5 border-t border-line pt-4">
          <p className="text-xs text-muted">You owe</p>
          <ul className="mt-2 flex flex-col gap-2">
            {owe.map((item) => (
              <li key={item.personKey} className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 truncate">{item.person}</span>
                <span className="shrink-0 tabular-nums font-medium">{formatMinor(toMinor(item.owe), item.currency)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}
