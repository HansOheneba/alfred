"use client";

import { useRef, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { EmptyState } from "@/app/components/ui";
import { AlfredAvatar } from "@/app/components/alfred-avatar";

function Icon({ children }: { children: ReactNode }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;
}

const metricIcons: Record<string, ReactNode> = {
  Spent: <path d="M6 18 18 6M6 6h12v12"/>,
  Income: <path d="M18 6 6 18M6 6v12h12"/>,
};

export function SummaryMetric({ label, value, hint, tone }: { label: string; value: string; hint?: ReactNode; tone?: "good" | "bad" }) {
  const icon = metricIcons[label];
  return <article className="alfred-ui-metric" data-kind={label === "Spent" ? "expense" : label === "Income" ? "income" : "neutral"} data-presentation={icon ? "card" : "plain"}>
    <div className="alfred-ui-metricHeading"><h2>{label}</h2>{icon ? <span><Icon>{icon}</Icon></span> : null}</div>
    <p className="alfred-ui-metricValue tabular-nums">{value}</p>
    {hint ? <p className={`alfred-ui-metricHint ${tone === "good" ? "text-success" : tone === "bad" ? "text-danger" : "text-muted"}`}>{hint}</p> : null}
  </article>;
}

export function MonthlyInsights({ insights }: { insights: string[] }) {
  const [question, setQuestion] = useState("");
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const router = useRouter();

  function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = question.trim();
    if (!value) { setError("Enter a question for Alfred."); return; }
    router.push(`/chat?question=${encodeURIComponent(value)}`);
  }

  return <section className="alfred-ui-insights" aria-labelledby="monthly-insights-title">
    <div className="alfred-ui-insightsHeader"><div><h2 id="monthly-insights-title">Alfred&apos;s insights · this month</h2><p>Your monthly summary</p></div><button type="button" className="alfred-ui-insightRefresh" disabled={refreshing} onClick={() => startRefresh(() => router.refresh())}>{refreshing ? "Refreshing…" : "Refresh"}</button></div>
    {insights.length === 0 ? <EmptyState>Insights appear once a few expenses are logged.</EmptyState> : <ul id="monthly-insight-rows" className="alfred-ui-insightRows">{(expanded ? insights : insights.slice(0, 3)).map((line) => <li key={line}><span className="alfred-ui-insightSpark" aria-hidden="true">✦</span><p>{line}</p></li>)}</ul>}
    {insights.length > 3 ? <button type="button" className="mt-2 inline-flex min-h-11 items-center text-xs font-medium text-accent" aria-expanded={expanded} aria-controls="monthly-insight-rows" onClick={() => setExpanded((value) => !value)}>{expanded ? "Show fewer insights" : `Show ${insights.length - 3} more insight${insights.length - 3 === 1 ? "" : "s"}`}</button> : null}
    <div className="alfred-ui-insightComposer">
    {open ? <form id="insight-question-form" className="alfred-ui-insightQuestionForm" onSubmit={ask}>
        <label htmlFor="insight-question" className="sr-only">Ask about these insights</label>
        <div className="alfred-ui-insightInput"><AlfredAvatar sizeClass="size-6" sizes="24px" /><input ref={input} id="insight-question" value={question} onChange={(event) => { setQuestion(event.target.value); setError(""); }} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setOpen(false); setError(""); requestAnimationFrame(() => trigger.current?.focus()); } }} placeholder="Ask Alfred…" maxLength={280}/><button type="submit" aria-label="Ask question"><Icon><path d="M12 19V5m-6 6 6-6 6 6"/></Icon></button></div>
        {error ? <p role="alert">{error}</p> : null}
      </form> : <button ref={trigger} type="button" className="alfred-ui-insightAskButton" aria-expanded={false} aria-controls="insight-question-form" onClick={() => { setOpen(true); requestAnimationFrame(() => input.current?.focus()); }}><AlfredAvatar sizeClass="size-6" sizes="24px" /> Ask Alfred</button>}
    </div>
    <p role="status" className="sr-only">{refreshing ? "Refreshing monthly insights from your recorded activity." : "Monthly insights reflect your recorded activity."}</p>
  </section>;
}
