"use client";

import Link from "next/link";
import { buttonClassName } from "@/app/components/button-styles";
import { GettingStartedDashboard } from "./getting-started";
import { WeeklyComparison } from "@/app/dashboard/weekly-comparison";

import { DashboardAccountBalance } from "@/app/dashboard/account-balance";
import { MonthlyInsights, SummaryMetric as Stat } from "@/app/dashboard/overview-cards";

const styles = {
  dashboard: "alfred-ui-dashboard", heading: "alfred-ui-heading", controls: "alfred-ui-controls",
  trends: "alfred-ui-trends", legend: "alfred-ui-legend", categories: "alfred-ui-categories",
  transactions: "alfred-ui-transactions",
} as const;
import { useEffect, useMemo, useState, type MouseEvent } from "react";

import { Card, Dialog, EmptyState, categoryColor } from "@/app/components/ui";
import { BillsCard } from "@/app/dashboard/bills-card";
import { PinnedCharts } from "@/app/dashboard/pinned-charts";
import { CategoryDonut, DailyChart, MonthlyChart, SimpleBars } from "@/app/dashboard/charts";
import { compactMoney, delta, percent } from "@/app/dashboard/helpers";
import { CashFlowSankey } from "@/app/dashboard/sankey-chart";
import { TransactionsTable } from "@/app/dashboard/transactions-table";
import { OverviewQuickAction } from "@/app/dashboard/overview-quick-actions";
import {
  RANGE_LABELS,
  type RangePreset,
} from "@/lib/finance/analytics";
import { formatDisplayDate } from "@/lib/finance/dates";
import { formatMinor, toMinor } from "@/lib/finance/money";
import type { Ledger } from "@/lib/web/ledger";
import type { OverviewTransactionFilters } from "@/lib/web/activity-handoff";
import { DEFAULT_OVERVIEW_VIEW, overviewScrollPosition, overviewViewFromParams, overviewViewHref, type OverviewView } from "./overview-view";
import "./overview-mobile.css";
import { buildOverviewSummary, type OverviewSummary } from "@/lib/web/overview-summary";
import type { RemoteOverviewTransactions } from "./overview-transaction-data";

const PRESETS = Object.keys(RANGE_LABELS) as RangePreset[];

export function DashboardClient({ ledger, name, timeZone = "Africa/Accra", initialView = DEFAULT_OVERVIEW_VIEW, initialTransactionFilters, overview, transactions }: { ledger: Ledger; name: string; timeZone?: string; initialView?: OverviewView; initialTransactionFilters?: OverviewTransactionFilters; overview?: OverviewSummary; transactions?: RemoteOverviewTransactions }) {
  const { currency, today } = ledger;
  const [view, setView] = useState(initialView);
  const { preset, category: selected, dailyMode, insightsOpen } = view;
  const [periodOpen, setPeriodOpen] = useState(false);

  useEffect(() => {
    let frame = 0;
    const restoreScroll = () => {
      const top = overviewScrollPosition(window.history.state?.alfredOverviewScrollY);
      if (top === null) return;
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => window.scrollTo({ top, behavior: "instant" })); });
    };
    const restore = () => {
      setView(overviewViewFromParams(new URLSearchParams(window.location.search)));
      restoreScroll();
    };
    restoreScroll();
    window.addEventListener("popstate", restore);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("popstate", restore); };
  }, []);

  function updateView(changes: Partial<OverviewView>) {
    const next = { ...view, ...changes };
    setView(next);
    window.history.replaceState(window.history.state, "", overviewViewHref(window.location.href, next));
  }

  function rememberActivityPosition(event: MouseEvent<HTMLDivElement>) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.defaultPrevented) return;
    const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!anchor) return;
    const target = new URL(anchor.getAttribute("href")!, window.location.href);
    if (target.origin !== window.location.origin || target.pathname !== "/accounts") return;
    const top = overviewScrollPosition(window.scrollY);
    if (top !== null) window.history.replaceState({ ...window.history.state, alfredOverviewScrollY: top }, "");
  }

  const summary = useMemo(() => overview ?? buildOverviewSummary(ledger), [overview, ledger]);
  const report = summary.reports[preset];
  const { range, spent, earned, categories, accounts, sankey, weekdays } = report;
  const prevSpent = report.previousSpent, prevEarned = report.previousEarned;
  const pace = summary.pace, monthly = summary.monthly, dailyData = report.daily;
  const otherCurrencyCount = summary.otherCurrencyCount;
  const selectedDetails = selected ? report.categoryDetails[selected] : undefined;
  const selectedMinor = selectedDetails?.minor ?? 0, selectedCount = selectedDetails?.count ?? 0;
  const selectedTrend = selected ? summary.categoryTrends[selected] ?? [] : [];

  const month = today.slice(0, 7);
  const budgets = ledger.budgets.filter((budget) => budget.period === month);
  const goals = ledger.goals;
  const hasAny = summary.currencyRowCount > 0;
  const rangeLabel = RANGE_LABELS[preset].toLowerCase();

  function toggle(category: string) {
    updateView({ category: selected === category ? null : category });
  }

  function chooseRange(value: RangePreset) {
    updateView({ preset: value, category: null });
    setPeriodOpen(false);
  }

  const setup = summary.setup;
  if (setup.canShowSetup || setup.showBlockedSetup) return <GettingStartedDashboard ledger={ledger} name={name} timeZone={timeZone} setup={setup} />;

  return (
    <div className={styles.dashboard} onClickCapture={rememberActivityPosition}>
      <div className={styles.heading}>
        <div>
          <p className="text-xs text-muted">{formatDisplayDate(today)}</p>
          <h1 className="mt-1 font-display text-2xl font-medium leading-tight tracking-tight">{name ? `${name}'s finances` : "Your finances"}</h1>
        </div>
        <div className={styles.controls}>
          <button type="button" className={buttonClassName({ variant: "secondary", className: "alfred-ui-rangePicker" })} aria-label={`Date range: ${RANGE_LABELS[preset]}`} aria-haspopup="dialog" aria-expanded={periodOpen} onClick={() => setPeriodOpen(true)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 3v4m8-4v4M4 10h16" /><rect x="4" y="5" width="16" height="16" rx="3" /></svg>
            <span>{RANGE_LABELS[preset]}</span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
          </button>
        </div>
      </div>

      <Dialog open={periodOpen} onClose={() => setPeriodOpen(false)} title="Choose a period">
        <div className="alfred-ui-periodOptions" role="radiogroup" aria-label="Date range">
          {PRESETS.map((item) => <label key={item} className="alfred-ui-periodOption" data-selected={preset === item}>
            <span>{RANGE_LABELS[item]}</span>
            <input type="radio" name="overview-period" value={item} checked={preset === item} onChange={() => chooseRange(item)} onClick={() => { if (preset === item) setPeriodOpen(false); }} />
          </label>)}
        </div>
      </Dialog>

      {ledger.bank.needsLabel.length > 0 ? <div className="alfred-ui-reviewPrompt"><span>Make your overview more complete.</span><Link href="/accounts?tab=needs-attention" className={buttonClassName({ variant: "ghost", size: "sm" })}>{ledger.bank.needsLabel.length} need{ledger.bank.needsLabel.length === 1 ? "s" : ""} a label <span aria-hidden="true">↗</span></Link></div> : null}

      {!hasAny ? (
        <EmptyState>
          No spending or income is recorded in {currency} yet. Tell Alfred what you spent or earned, here in <Link href="/chat" className="text-accent underline-offset-2 hover:underline">chat</Link> or
          on Telegram, and your charts will fill in.
        </EmptyState>
      ) : null}

      {otherCurrencyCount > 0 ? (
        <p className="text-xs text-muted">
          Figures are in {currency}. {otherCurrencyCount} transaction{otherCurrencyCount === 1 ? "" : "s"} in other currencies {otherCurrencyCount === 1 ? "is" : "are"} left out.
        </p>
      ) : null}

      <div className="alfred-ui-overviewGrid" role="region" aria-label="Account balance and cash flow">
      <DashboardAccountBalance accounting={ledger.accounting} currency={currency} timeZone={timeZone} />
        <Stat label="Spent" value={formatMinor(spent, currency)} hint={`${RANGE_LABELS[preset]} · ${delta(spent, prevSpent, false).text}`} tone={delta(spent, prevSpent, false).tone} />
        <Stat label="Income" value={formatMinor(earned, currency)} hint={`${RANGE_LABELS[preset]} · ${delta(earned, prevEarned, true).text}`} tone={delta(earned, prevEarned, true).tone} />
        <WeeklyComparison currentMinor={pace.thisWeekMinor} previousMinor={pace.lastWeekSameStretchMinor} changePercent={pace.changePercent} currency={currency} />
      </div>

      {ledger.pinned?.length ? <PinnedCharts pinned={ledger.pinned} /> : null}

      {hasAny ? <div id="overview-transactions" tabIndex={-1} className={styles.transactions}><TransactionsTable rows={transactions ? ledger.rows : ledger.rows.filter(row => row.currency === currency && row.date >= range.start && row.date <= range.end).sort((left, right) => left.type === right.type ? 0 : left.type === "expense" ? -1 : 1)} category={selected} onClearCategory={() => updateView({ category: null })} rangeLabel={rangeLabel} range={range} currency={currency} initialFilters={initialTransactionFilters} timeZone={timeZone} remote={transactions} preset={preset} /></div> : null}

      <div className="alfred-ui-planningGrid grid gap-4 lg:grid-cols-2">
        <BillsCard
          showCategoryLink
          bills={ledger.bills ?? []}
          upcoming={ledger.upcomingBills ?? []}
          suggestions={ledger.renewalSuggestions ?? []}
          currency={currency}
          today={today}
        />
        <Card title="Budgets · this month" action={<Link href="/settings#budgets" className={buttonClassName({ variant: "ghost", size: "sm" })}>Manage</Link>}>
          {budgets.length === 0 ? (
            <OverviewQuickAction kind="budget" currency={currency} today={today} budgets={ledger.budgets} />
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
                    <p className={`mt-1 text-xs tabular-nums ${over ? "text-danger" : "text-muted"}`}>
                      {over ? `${formatMinor(-budget.remainingMinor, budget.currency)} over` : `${formatMinor(budget.remainingMinor, budget.currency)} left`}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      <div className="alfred-ui-planningGrid grid gap-4 lg:grid-cols-2">
        <Card title="Savings goals" action={<Link href="/settings#goals" className={buttonClassName({ variant: "ghost", size: "sm" })}>Manage</Link>}>
          {goals.length === 0 ? (
            <OverviewQuickAction kind="goal" currency={currency} today={today} />
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
        <OwedCard owed={ledger.owed} owe={ledger.owe} currency={currency} today={today} />
      </div>


      <details className="alfred-ui-insightsDisclosure" open={insightsOpen} onToggle={(event) => { if (event.currentTarget.open !== insightsOpen) updateView({ insightsOpen: event.currentTarget.open }); }}>
        <summary><span><strong>Insights</strong><span>Charts and spending breakdowns · {rangeLabel}</span></span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></summary>
        {insightsOpen ? <div className="alfred-ui-insightsContent">
      <div className="alfred-ui-insightsAndTrends">
      <MonthlyInsights insights={ledger.insights} />

      <div className={styles.trends}>
        <Card title="Spending vs income, last 12 months" action={<div className={styles.legend}><span><i className="bg-income" />Income</span><span><i className="bg-outgoing" />Spent</span></div>}>
          <MonthlyChart data={monthly} currency={currency} />
          <p className="sr-only">
            {monthly.map((item) => `${item.label}: spent ${formatMinor(item.spent, currency)}, income ${formatMinor(item.income, currency)}`).join("; ")}
          </p>
        </Card>
        <Card
          className="alfred-ui-dailyCard"
          title={`Spending by day · ${rangeLabel}`}
          action={
            <div className="alfred-ui-chartModes flex rounded-xl border border-line p-1 text-sm" role="group" aria-label="Chart mode">
              {(["daily", "cumulative"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={dailyMode === mode}
                  onClick={() => updateView({ dailyMode: mode })}
                  className={buttonClassName({ variant: dailyMode === mode ? "soft" : "ghost", size: "sm", className: "alfred-button--compact" })}
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
      </div>

      <Card
        className={styles.categories}
        title={`Where the money went · ${rangeLabel}`}
        action={
          selected ? (
            <button type="button" onClick={() => updateView({ category: null })} className={buttonClassName({ variant: "ghost", size: "sm" })}>
              Clear selection
            </button>
          ) : null
        }
      >
        {categories.length === 0 ? (
          <EmptyState>No spending in this range.</EmptyState>
        ) : (
          <div className="alfred-ui-categoryLayout">
            <div className="alfred-ui-categoryOverview">
              <div className="alfred-ui-donutTotal">
                <CategoryDonut data={categories} currency={currency} selected={selected} onSelect={toggle} />
                <div className="alfred-ui-donutCenter" aria-hidden="true"><span>Total spent</span><strong className="tabular-nums">{formatMinor(spent, currency)}</strong></div>
              </div>
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
            {selected ? <div className="alfred-ui-categoryDetails rounded-xl border border-line bg-bg p-4">
                <>
                  <p className="text-xs text-muted">{selected}</p>
                  <p className="mt-1 text-2xl font-medium tabular-nums">{formatMinor(selectedMinor, currency)}</p>
                  <p className="text-xs text-muted">
                    {percent(selectedMinor, spent)} of spending · {selectedCount} transaction{selectedCount === 1 ? "" : "s"}
                  </p>
                  <a href="#overview-transactions" className={buttonClassName({ variant: "secondary", size: "sm", className: "mt-4" })}>View {selected} transactions <span aria-hidden="true">↑</span></a>
                  <h3 className="mt-5 text-xs font-medium text-muted">Top places and things</h3>
                  <ul className="mt-2 flex flex-col gap-2">
                    {(selectedDetails?.descriptions ?? []).map((item) => (
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
            </div> : null}
          </div>
        )}
      </Card>

      <Card title={`Where it came from, where it went · ${rangeLabel}`}>
        <CashFlowSankey model={sankey} currency={currency} />
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
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
              <ul className="mt-3 flex flex-col gap-2" aria-label="Spending by account">
                {accounts.map((item, index) => (
                  <li key={item.account} className="flex items-center gap-3 text-sm">
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
        <Card title={`By weekday · ${rangeLabel}`} className="alfred-ui-weekdayCard">
          {spent === 0 ? (
            <EmptyState>No spending in this range.</EmptyState>
          ) : (
            <>
              <SimpleBars data={weekdays} currency={currency} fillHeight />
              <p className="sr-only">{weekdays.map((item) => `${item.label}: ${formatMinor(item.spent, currency)}`).join("; ")}</p>
            </>
          )}
        </Card>
      </div>

        </div> : null}
      </details>
    </div>
  );
}

/** Money the person lent out and hasn't had back yet, and what they borrowed and still owe. */
function OwedCard({ owed, owe, currency, today }: { owed: Ledger["owed"]; owe: Ledger["owe"]; currency: string; today: string }) {
  const total = owed.reduce((sum, item) => sum + toMinor(item.owed), 0);
  return (
    <Card title="Owed to you" action={total > 0 ? <span className="tabular-nums text-xs text-muted">{formatMinor(total, owed[0].currency)}</span> : undefined}>
      {owed.length === 0 ? (
        <OverviewQuickAction kind="loan" currency={currency} today={today} />
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
