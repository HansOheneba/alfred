import Link from "next/link";
import { AlfredAvatar } from "@/app/components/alfred-avatar";
import { getGettingStartedState } from "@/app/components/getting-started-state";
import { DashboardAccountBalance } from "./account-balance";
import type { Ledger } from "@/lib/web/ledger";
import "./getting-started.css";

const firstTransaction = "/chat?question=" + encodeURIComponent("Help me record my first transaction.");

export function GettingStartedDashboard({ ledger, name, timeZone }: { ledger: Ledger; name: string; timeZone: string }) {
  const state = getGettingStartedState(ledger);
  const steps = [
    { title: "Add your first account", description: "Give your bank, mobile money or cash a place in Alfred.", done: state.hasAccount, href: state.hasAccount ? "/accounts" : "/accounts?add=1", action: state.hasAccount ? "View accounts" : "Add account" },
    { title: "Record a transaction", description: "Tell Alfred what you spent or earned. Review the details before saving.", done: state.hasTransaction, href: firstTransaction, action: "Record a transaction" },
    { title: "Set a budget", description: "Choose a category and a monthly spending limit that works for you.", done: state.hasBudget, href: "/settings#budgets", action: state.hasBudget ? "View budgets" : "Set a budget" },
  ];
  const next = steps.findIndex((step) => !step.done);
  return <div className="alfred-getting-started">
    <header className="alfred-getting-started-heading">
      <AlfredAvatar sizeClass="size-12" sizes="48px" />
      <div><p>Welcome to Alfred</p><h1>{name ? `Let’s make this yours, ${name}.` : "Let’s make this yours."}</h1><p>A few small steps to start making sense of your money.</p></div>
    </header>
    <div className="alfred-getting-started-layout">
      <section className="alfred-getting-started-checklist" aria-labelledby="getting-started-title">
        <header><div><h2 id="getting-started-title">Your first steps</h2><p>Start anywhere. Your progress follows what you save.</p></div><span aria-label={`${state.completedCount} of 3 steps complete`}>{state.completedCount} of 3</span></header>
        <div className="alfred-getting-started-progress" role="progressbar" aria-label="Getting started" aria-valuemin={0} aria-valuemax={3} aria-valuenow={state.completedCount}><span style={{ width: `${state.completedCount / 3 * 100}%` }} /></div>
        <ol>{steps.map((step, index) => <li key={step.title} data-complete={step.done}>
          <span className="alfred-getting-started-step" aria-hidden="true">{step.done ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 4 4L19 6" /></svg> : index + 1}</span>
          <div><h3>{step.title}{step.done ? <span className="sr-only"> — completed</span> : null}</h3><p>{step.description}</p></div>
          <Link href={step.href} className={index === next ? "is-next" : ""}>{step.action}<span aria-hidden="true">↗</span></Link>
        </li>)}</ol>
        <footer><span>Prefer to talk it through?</span><Link href="/chat">Ask Alfred <span aria-hidden="true">↗</span></Link></footer>
      </section>
      {state.hasAccount ? <DashboardAccountBalance accounting={ledger.accounting} currency={ledger.currency} timeZone={timeZone} /> : <aside className="alfred-getting-started-ahead">
        <span className="alfred-getting-started-aheadIcon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><path d="M14 21v-4m4 4v-7m3 7v-9"/></svg></span>
        <h2>Your overview starts here.</h2><p>As you add activity, this space becomes a picture of your money.</p>
        <ul><li><span aria-hidden="true">01</span><div><h3>Know where you stand</h3><p>Your accounts and their reported balances, together.</p></div></li><li><span aria-hidden="true">02</span><div><h3>See your spending clearly</h3><p>Trends and categories built from your own records.</p></div></li><li><span aria-hidden="true">03</span><div><h3>Plan a little ahead</h3><p>Budgets and insights that grow with your activity.</p></div></li></ul>
        <p className="alfred-getting-started-note">No balance recorded yet. Add an account and its balance when you’re ready.</p>
      </aside>}
    </div>
    <p className="alfred-getting-started-footnote">Your charts will appear once you record activity. You can keep using Chat and every tab along the way.</p>
  </div>;
}
