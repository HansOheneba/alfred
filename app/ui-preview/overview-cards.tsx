"use client";

import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { buttonClassName } from "@/app/components/button-styles";

import { EmptyState } from "@/app/components/ui";
import { AlfredAvatar } from "@/app/components/alfred-avatar";
import { formatMinor, toMinor } from "@/lib/finance/money";
import type { PreviewAccount } from "@/ui-preview/fixture";

import { PreviewIcon } from "./preview-shell";

const metricIcons: Record<string, ReactNode> = {
  Spent: <path d="M6 18 18 6M6 6h12v12"/>,
  Income: <path d="M18 6 6 18M6 6v12h12"/>,
};

export function SummaryMetric({ label, value, hint, tone }: { label: string; value: string; hint?: ReactNode; tone?: "good" | "bad" }) {
  const icon = metricIcons[label];
  return <article className="alfred-ui-metric" data-kind={label === "Spent" ? "expense" : label === "Income" ? "income" : "neutral"} data-presentation={icon ? "card" : "plain"}>
    <div className="alfred-ui-metricHeading"><h2>{label}</h2>{icon ? <span><PreviewIcon>{icon}</PreviewIcon></span> : null}</div>
    <p className="alfred-ui-metricValue tabular-nums">{value}</p>
    {hint ? <p className={`alfred-ui-metricHint ${tone === "good" ? "text-success" : tone === "bad" ? "text-danger" : "text-muted"}`}>{hint}</p> : null}
  </article>;
}

export function includedAccountSummary(accounts: PreviewAccount[], currency: string) {
  const seen = new Set<string>();
  const included = accounts.filter((account) => {
    if (!account.included || account.currency !== currency || seen.has(account.id)) return false;
    seen.add(account.id);
    return true;
  });
  return { accounts: included, count: included.length, totalMinor: included.reduce((sum, account) => sum + toMinor(account.balance), 0) };
}

export function AccountBalanceCard({ accounts, currency, totals }: { accounts: PreviewAccount[]; currency: string; totals?: { count: number; totalMinor: number | null } }) {
  const known = includedAccountSummary(accounts, currency);
  const summary = { ...known, count: totals?.count ?? known.count, totalMinor: totals ? totals.totalMinor : known.totalMinor };
  const stamp = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Accra" });
  return <section className="alfred-ui-totalBalance" aria-label="Total account balance">
    <div className="alfred-ui-balanceHeading"><h2>Total account balance</h2><PreviewIcon><path d="M3 7h16a2 2 0 0 1 2 2v10H5a2 2 0 0 1-2-2V7Zm0 0V5a2 2 0 0 1 2-2h12v4m0 5h4m-4 0v3h4"/></PreviewIcon></div>
    <p className="alfred-ui-totalValue tabular-nums">{summary.totalMinor === null ? "—" : formatMinor(summary.totalMinor, currency)}</p>
    <p className="alfred-ui-accountCount"><span>{summary.count} included account{summary.count === 1 ? "" : "s"}</span><span>{currency}</span></p>
    <ul className="alfred-ui-accountBreakdown" aria-label="Accounts contributing to total">
      {summary.accounts.map((account) => <li key={account.id}><div><span>{account.label}</span><time dateTime={account.reportedAt}>{stamp.format(new Date(account.reportedAt))} GMT</time></div><strong className="tabular-nums">{formatMinor(toMinor(account.balance), currency)}</strong></li>)}
    </ul>
    <div className="alfred-ui-balanceFootnote"><p>{summary.totalMinor === null ? "Record a balance for every included account to see the total." : "Latest reported balances · Not live"}</p><p>Included cash accounts. Excludes investments and loans.</p><Link href="/ui-preview/accounts" className={buttonClassName({ variant: "ghost", size: "sm", className: "mt-2" })}>Manage accounts ↗</Link></div>
  </section>;
}

export function MonthlyInsights({ insights }: { insights: string[] }) {
  const [question, setQuestion] = useState("");
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const router = useRouter();

  function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = question.trim();
    if (!value) { setError("Enter a question for Alfred."); return; }
    router.push(`/ui-preview/chat?question=${encodeURIComponent(value)}`);
  }

  return <section className="alfred-ui-insights" aria-labelledby="monthly-insights-title">
    <div className="alfred-ui-insightsHeader"><div><h2 id="monthly-insights-title">Alfred&apos;s insights · this month</h2><p>Your monthly summary</p></div><button type="button" className={buttonClassName({ variant: "secondary", size: "sm", className: "alfred-ui-insightRefresh" })} onClick={() => { router.refresh(); setStatus("Insights refreshed from the demo records."); }}>Refresh</button></div>
    {insights.length === 0 ? <EmptyState>Insights appear once a few expenses are logged.</EmptyState> : <ul className="alfred-ui-insightRows">{insights.map((line) => <li key={line}><span className="alfred-ui-insightSpark" aria-hidden="true">✦</span><p>{line}</p></li>)}</ul>}
    <div className="alfred-ui-insightComposer">
    {open ? <form id="insight-question-form" className="alfred-ui-insightQuestionForm" data-preview-local-form="true" onSubmit={ask}>
        <label htmlFor="insight-question" className="sr-only">Ask about these insights</label>
        <div className="alfred-ui-insightInput"><AlfredAvatar sizeClass="size-6" sizes="24px" /><input ref={input} id="insight-question" value={question} onChange={(event) => { setQuestion(event.target.value); setError(""); }} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setOpen(false); setError(""); requestAnimationFrame(() => trigger.current?.focus()); } }} placeholder="Ask Alfred…" maxLength={280}/><button type="submit" className={buttonClassName({ variant: "primary", size: "icon" })} aria-label="Ask question"><PreviewIcon><path d="M12 19V5m-6 6 6-6 6 6"/></PreviewIcon></button></div>
        {error ? <p role="alert">{error}</p> : null}
      </form> : <button ref={trigger} type="button" className={buttonClassName({ variant: "soft", className: "alfred-ui-insightAskButton" })} aria-expanded={false} aria-controls="insight-question-form" onClick={() => { setOpen(true); requestAnimationFrame(() => input.current?.focus()); }}><AlfredAvatar sizeClass="size-6" sizes="24px" /> Ask Alfred</button>}
    </div>
    <p role="status" className="sr-only">{status}</p>
  </section>;
}
