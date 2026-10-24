import Link from "next/link";

import type { DashboardBudget, DashboardCategory, DashboardDay, DashboardGoal, DashboardSnapshot } from "@/lib/finance/dashboard";
import { formatDisplayDate } from "@/lib/finance/dates";
import { formatMinor, toMinor } from "@/lib/finance/money";

const CATEGORY_COLORS = ["#e8c572", "#8eb6ff", "#f0a070", "#9ddeaf", "#d7a4e8", "#7ec8c3", "#e7a0a8", "#c5c1b7"];

export function DashboardView({ snapshot, name }: { snapshot: DashboardSnapshot; name: string }) {
  const greeting = name ? `${name}'s finances` : "Your finances";
  const peak = Math.max(...snapshot.days.map((day) => day.spentMinor), 0);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 pb-16">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs tracking-wide text-neutral-500">{snapshot.monthLabel}</p>
          <h1 className="mt-1 text-2xl font-medium tracking-tight">{greeting}</h1>
        </div>
        <Link
          href="/chat"
          className="rounded-full bg-neutral-100 px-4 py-2 text-sm text-neutral-950 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-400"
        >
          Talk to Alfred
        </Link>
      </div>

      {snapshot.hasActivity ? null : (
        <p className="text-sm leading-6 text-neutral-400">
          Nothing is recorded yet. Tell Alfred what you spent or earned, here or on Telegram, and it will show up here.
        </p>
      )}

      <section className="grid gap-3 sm:grid-cols-3" aria-label="This month">
        <Figure label="Spent" amount={formatMinor(snapshot.spentMinor, snapshot.currency)} />
        <Figure label="Income" amount={formatMinor(snapshot.incomeMinor, snapshot.currency)} />
        <Figure label="Net" amount={formatMinor(snapshot.netMinor, snapshot.currency)} />
      </section>

      {snapshot.otherCurrencies.length > 0 ? (
        <p className="text-sm text-neutral-400">
          Also this month:{" "}
          {snapshot.otherCurrencies
            .map((item) => `${formatMinor(item.spentMinor, item.currency)} spent, ${formatMinor(item.incomeMinor, item.currency)} income`)
            .join("; ")}
          .
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-2xl border border-white/10 bg-neutral-950 p-4">
          <h2 className="text-sm font-medium">Spending by category</h2>
          {snapshot.categories.length === 0 ? (
            <p className="mt-4 text-sm text-neutral-500">No spending in {snapshot.currency} this month.</p>
          ) : (
            <ul className="mt-4 flex flex-col gap-3">
              {snapshot.categories.map((item, index) => (
                <CategoryRow key={item.category} item={item} currency={snapshot.currency} color={CATEGORY_COLORS[index % CATEGORY_COLORS.length]} />
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-2xl border border-white/10 bg-neutral-950 p-4">
          <h2 className="text-sm font-medium">Spending by day</h2>
          <div className="mt-4 flex h-32 items-end gap-1" role="img" aria-label={daySummary(snapshot.days, snapshot.currency)}>
            {snapshot.days.map((day) => (
              <div key={day.date} className="flex h-full min-w-0 flex-1 flex-col justify-end" title={`${formatDisplayDate(day.date)}: ${formatMinor(day.spentMinor, snapshot.currency)}`}>
                <div
                  className="w-full rounded-sm bg-[#e8c572]"
                  style={{ height: barHeight(day.spentMinor, peak) }}
                />
              </div>
            ))}
          </div>
          <div className="mt-2 flex justify-between text-xs text-neutral-500">
            <span>{snapshot.days[0]?.day ?? ""}</span>
            <span>{snapshot.days.at(-1)?.day ?? ""}</span>
          </div>
        </section>
      </div>

      {snapshot.budgets.length > 0 ? (
        <section className="rounded-2xl border border-white/10 bg-neutral-950 p-4">
          <h2 className="text-sm font-medium">Budgets</h2>
          <ul className="mt-4 flex flex-col gap-4">
            {snapshot.budgets.map((item) => (
              <BudgetRow key={`${item.category}-${item.currency}`} item={item} />
            ))}
          </ul>
        </section>
      ) : null}

      {snapshot.goals.length > 0 ? (
        <section className="rounded-2xl border border-white/10 bg-neutral-950 p-4">
          <h2 className="text-sm font-medium">Savings</h2>
          <ul className="mt-4 flex flex-col gap-4">
            {snapshot.goals.map((item) => (
              <GoalRow key={item.name} item={item} />
            ))}
          </ul>
        </section>
      ) : null}

      <section className="rounded-2xl border border-white/10 bg-neutral-950 p-4">
        <h2 className="text-sm font-medium">Latest transactions</h2>
        {snapshot.recent.length === 0 ? (
          <p className="mt-4 text-sm text-neutral-500">No transactions yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-white/10">
            {snapshot.recent.map((item) => (
              <li key={item.transactionId} className="flex items-baseline justify-between gap-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm">{item.description || item.category}</p>
                  <p className="text-xs text-neutral-500">
                    {formatDisplayDate(item.transactionDate)} · {item.category}
                    {item.type === "income" ? " · Income" : ""}
                  </p>
                </div>
                <p className={item.type === "income" ? "shrink-0 text-sm text-emerald-200" : "shrink-0 text-sm"}>
                  {item.type === "income" ? "+" : "−"}
                  {formatMinor(toMinor(item.amount), item.currency)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Figure({ label, amount }: { label: string; amount: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-neutral-950 px-4 py-4">
      <p className="text-xs tracking-wide text-neutral-500">{label}</p>
      <p className="mt-2 text-2xl font-medium tracking-tight">{amount}</p>
    </div>
  );
}

function CategoryRow({ item, currency, color }: { item: DashboardCategory; currency: string; color: string }) {
  return (
    <li>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span>{item.category}</span>
        <span className="text-neutral-300">
          {formatMinor(item.minor, currency)}
          <span className="ml-2 text-xs text-neutral-500">{Math.round(item.share * 100)}%</span>
        </span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full" style={{ width: `${Math.max(item.share > 0 ? 2 : 0, item.share * 100)}%`, background: color }} />
      </div>
    </li>
  );
}

function BudgetRow({ item }: { item: DashboardBudget }) {
  const used = item.budgetMinor === 0 ? 0 : Math.min(1, item.spentMinor / item.budgetMinor);
  const over = item.remainingMinor < 0;
  return (
    <li>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span>{item.category}</span>
        <span className={over ? "text-red-300" : "text-neutral-300"}>
          {formatMinor(item.spentMinor, item.currency)} of {formatMinor(item.budgetMinor, item.currency)}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/10">
        <div className={over ? "h-full rounded-full bg-red-300" : "h-full rounded-full bg-[#8eb6ff]"} style={{ width: `${Math.max(used > 0 ? 2 : 0, used * 100)}%` }} />
      </div>
    </li>
  );
}

function GoalRow({ item }: { item: DashboardGoal }) {
  const used = item.targetMinor === 0 ? 0 : Math.min(1, item.currentMinor / item.targetMinor);
  return (
    <li>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span>
          {item.name}
          {item.status === "completed" ? <span className="ml-2 text-xs text-neutral-500">Done</span> : null}
        </span>
        <span className="text-neutral-300">
          {formatMinor(item.currentMinor, item.currency)} of {formatMinor(item.targetMinor, item.currency)}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full bg-[#9ddeaf]" style={{ width: `${Math.max(used > 0 ? 2 : 0, used * 100)}%` }} />
      </div>
    </li>
  );
}

function barHeight(spent: number, peak: number): string {
  if (spent <= 0 || peak <= 0) return "0%";
  return `${Math.max(8, (spent / peak) * 100)}%`;
}

function daySummary(days: DashboardDay[], currency: string): string {
  const total = days.reduce((sum, day) => sum + day.spentMinor, 0);
  return `Daily spending from day ${days[0]?.day ?? ""} to ${days.at(-1)?.day ?? ""}, ${formatMinor(total, currency)} in total.`;
}
