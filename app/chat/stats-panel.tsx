"use client";

import Link from "next/link";
import { useId } from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis } from "recharts";

import { NeedsLabel } from "@/app/components/needs-label";
import { categoryColor } from "@/app/components/ui";
import { buildChatContext, type ChatContext } from "@/lib/web/chat-context";
import { formatAmount, formatMinor } from "@/lib/finance/money";
import type { Ledger } from "@/lib/web/ledger";

/** The at-a-glance month beside the chat. */
export function StatsPanel(props: { context: ChatContext; ledger?: never } | { ledger: Ledger; context?: never }) {
  const context = props.context ?? buildChatContext(props.ledger!);
  // The panel can render twice (side column and phone sheet), so gradient ids must be unique.
  const fillId = `alfred-panel-fill-${useId().replace(/:/g, "")}`;
  const range = context.month;
  const { spentMinor, incomeMinor: income, categories } = context.month;
  const days = context.month.days.map(day => ({ ...day, value: day.cumulative / 100 }));
  const budgets = context.budgets;
  const money = (minor: number) => formatMinor(minor, context.currency);
  // The most telling server-computed finding: a repeated spend, then a budget warning, then the biggest shift.
  const highlight = context.highlight;
  const month = new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "UTC" }).format(new Date(`${range.start}T00:00:00Z`));

  const balances = context.balances;
  const includedAccounts = balances.accounts;
  const accountCount = balances.count;
  const totalBalance = balances.totalMinor;
  const stamp = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Accra", timeZoneName: "short" });
  const balanceNote = !balances.availability ? "Account balances are unavailable." : balances.availability === "migration-required" ? "Account storage must be set up before saving accounts." : balances.missingCount ? `${balances.missingCount} included account${balances.missingCount === 1 ? " needs" : "s need"} a reported balance before the total is available.` : !accountCount ? "Add an account and record its balance to see your total." : "Latest reported balances · Not live";

  if (context.setup.isEmpty) return <div className="alfred-production-chat-contextCards" data-first-use-context="true">
    <section className="alfred-production-chat-setupContext" aria-labelledby={`${fillId}-setup-title`}>
      <h2 id={`${fillId}-setup-title`}>Give Alfred a starting point</h2>
      <p>Your balances and spending will appear here as you add accounts and record activity.</p>
      <Link className="alfred-production-chat-setupPrimary" href="/accounts?add=1">Add your first account <span aria-hidden="true">↗</span></Link>
      <Link className="alfred-production-chat-setupLink" href="/dashboard">View your setup checklist <span aria-hidden="true">↗</span></Link>
    </section>
  </div>;

  return (
    <div className="alfred-production-chat-contextCards">
      <div className="alfred-production-chat-contextHeading"><span>Conversation context</span><span>{month}</span></div>
      <section className="alfred-production-chat-snapshot">
        <h2>Your month at a glance</h2>
        <dl><div><dt>Spent</dt><dd className="tabular-nums is-expense">{money(spentMinor)}</dd></div><div><dt>Income</dt><dd className="tabular-nums is-income">{money(income)}</dd></div><div><dt>Kept</dt><dd className="tabular-nums">{money(income - spentMinor)}</dd></div></dl>
        <Link href="/dashboard">Open Overview <span aria-hidden="true">↗</span></Link>
      </section>

      <section className="alfred-production-chat-accountBalances" aria-label="Included account balances">
        <h2>Included account balances</h2>
        <div className="alfred-production-chat-accountTotal"><span>Total account balance</span><strong className="tabular-nums">{totalBalance === null ? "—" : money(totalBalance)}</strong></div>
        <p className="alfred-production-chat-accountCount">{balances.availability === "ready" ? `${accountCount} included account${accountCount === 1 ? "" : "s"}` : "Balances unavailable"} · {context.currency}</p>
        {includedAccounts.length > 0 ? <ul className="alfred-production-chat-balanceList" aria-label="Accounts included in total">{includedAccounts.map(account => <li key={account.id}><div><span>{account.label}</span><strong className="tabular-nums">{account.balanceMinor !== null ? money(account.balanceMinor) : "—"}</strong></div>{account.occurredAt && Number.isFinite(Date.parse(account.occurredAt)) ? <time dateTime={account.occurredAt}>{stamp.format(new Date(account.occurredAt))}</time> : <p>{account.balanceMinor !== null ? "Snapshot time unavailable" : "Reported balance needed"}</p>}</li>)}</ul> : null}
        <p className="alfred-production-chat-contextNote">{balanceNote}</p>
        <p className="alfred-production-chat-contextNote">Cash accounts in {context.currency}. Separate from income or net worth; investments and loans are excluded.</p>
        <Link className="alfred-production-chat-manageAccounts" href="/accounts">Manage accounts <span aria-hidden="true">↗</span></Link>
      </section>

      {context.bank.balances.length > 0 ? <details className="alfred-production-chat-legacySnapshots"><summary>Bank-message snapshots<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></summary><ul className="alfred-production-chat-balanceList">{context.bank.balances.map((item) => <li key={item.source}><div><span>{item.label}</span><strong className="tabular-nums">{formatAmount(item.balance, context.currency)}</strong></div>{Number.isFinite(Date.parse(item.at)) ? <time dateTime={item.at}>{stamp.format(new Date(item.at))}</time> : <p>Snapshot time unavailable</p>}</li>)}</ul><p className="alfred-production-chat-contextNote">Provider-level bank-message facts · Not live. These are kept separate from the account total above.</p></details> : null}

      {context.bank.needsLabelCount > 0 ? <section><h2>Needs a label ({context.bank.needsLabelCount})</h2><div className="alfred-production-chat-labelItems"><NeedsLabel compact items={context.bank.needsLabel} limit={3} totalCount={context.bank.needsLabelCount} /></div></section> : null}

      {spentMinor > 0 ? <section><h2>Spending so far</h2><div className="alfred-production-chat-contextChart" aria-label={`Spending so far this month: ${money(spentMinor)}`} role="img"><ResponsiveContainer width="100%" height="100%"><AreaChart data={days} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}><defs><linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--accent)" stopOpacity={0.35} /><stop offset="100%" stopColor="var(--accent)" stopOpacity={0} /></linearGradient></defs><XAxis dataKey="label" hide /><Tooltip contentStyle={{ background: "var(--surface)", border: "1px solid var(--line-strong)", borderRadius: 12, color: "var(--ink)", fontSize: 12 }} itemStyle={{ color: "var(--ink)" }} formatter={(_value, _name, entry) => [money((entry.payload as { cumulative: number }).cumulative), "By then"]} labelStyle={{ color: "var(--muted)" }} /><Area type="monotone" dataKey="value" stroke="var(--accent)" strokeWidth={2} fill={`url(#${fillId})`} /></AreaChart></ResponsiveContainer></div></section> : null}

      <section><h2>Top categories</h2>{categories.length === 0 ? <p className="alfred-production-chat-contextNote">Nothing spent yet this month.</p> : <ul className="alfred-production-chat-contextList">{categories.map((item, index) => <li key={item.category}><div><span><i style={{ background: categoryColor(index) }} aria-hidden="true" />{item.category}</span><span className="tabular-nums">{money(item.minor)}</span></div><div className="alfred-production-chat-contextTrack"><span style={{ width: `${Math.max(4, item.minor / spentMinor * 100)}%`, background: categoryColor(index) }} /></div></li>)}</ul>}</section>

      {budgets.length > 0 ? <section><h2>Budgets</h2><ul className="alfred-production-chat-contextList">{budgets.map((budget) => {
        const used = budget.budgetMinor > 0 ? Math.min(100, budget.spentMinor / budget.budgetMinor * 100) : 0;
        const over = budget.remainingMinor < 0;
        return <li key={budget.budgetId}><div><span>{budget.category}</span><span className={`tabular-nums ${over ? "is-expense" : ""}`}>{over ? `${formatMinor(-budget.remainingMinor, budget.currency)} over` : `${formatMinor(budget.remainingMinor, budget.currency)} left`}</span></div><div className="alfred-production-chat-contextTrack"><span style={{ width: `${used}%`, background: over ? "var(--danger)" : used >= 80 ? "var(--accent)" : "var(--success)" }} /></div></li>;
      })}</ul></section> : null}

      {highlight ? <section className="alfred-production-chat-contextHighlight"><h2>Worth knowing</h2><p>{highlight}</p></section> : null}
      <Link className="alfred-production-chat-dashboardLink" href="/dashboard">Open the full dashboard <span aria-hidden="true">↗</span></Link>
    </div>
  );
}
