"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent } from "react";

import { AlfredMark, PrivacyToggle } from "@/app/components/app-shell";
import { NotebookIcon, NotebookPanel, useNotebookPanel } from "@/app/chat/notebook-panel";
import { formatMinor, toMinor } from "@/lib/finance/money";
import { buildAccountingView } from "@/lib/finance/accounting/view";
import type { AccountingState } from "@/lib/finance/accounting/types";
import { categoryTotals } from "@/lib/finance/analytics";
import { buildPreviewLedger, previewBalanceAccounts } from "@/ui-preview/accounting-ledger";
import { usePreviewAccounting } from "@/ui-preview/accounting-store";
import { previewLedger as basePreviewLedger, previewName, previewToday } from "@/ui-preview/fixture";

import { PreviewChatTools, PreviewIcon } from "./preview-shell";
import { ChatNotebookPreview } from "./chat-notebook";
import "./chat-preview.css";

type Fact = { label: string; value: string; tone?: "income" | "expense" };
type Reply = { title: string; text: string; facts?: Fact[]; points?: { label: string; value: string }[]; note?: string };
type Message = { id: string; role: "user"; text: string } | { id: string; role: "assistant"; reply: Reply; question?: string };

function financeContext(state: AccountingState) {
  const previewLedger = buildPreviewLedger(state);
  const monthRows = previewLedger.rows.filter((row) => row.currency === previewLedger.currency && row.date.startsWith(previewToday.slice(0, 7)));
  const spentMinor = monthRows.filter((row) => row.type === "expense").reduce((total, row) => total + row.minor, 0);
  const incomeMinor = monthRows.filter((row) => row.type === "income").reduce((total, row) => total + row.minor, 0);
  const balances = buildAccountingView(state, previewLedger.currency).balances;
  const balanceAccounts = previewBalanceAccounts(state).filter((account) => account.included && account.currency === previewLedger.currency);
  const foodBudget = previewLedger.budgets.find((budget) => budget.category === "Food" && budget.period === previewToday.slice(0, 7));
  const largestCategory = categoryTotals(monthRows.filter((row) => row.type === "expense"))[0]?.category ?? "No recorded spending";
  return { previewLedger, monthRows, spentMinor, incomeMinor, balanceAccounts, balanceMinor: balances.totalMinor, balanceCount: balances.count, foodBudget, largestCategory };
}
const money = (minor: number) => formatMinor(minor, basePreviewLedger.currency);

function demoReply(question: string, finance: ReturnType<typeof financeContext>): Reply {
  const { previewLedger, monthRows, spentMinor, incomeMinor, balanceAccounts, balanceMinor, balanceCount, foodBudget, largestCategory } = finance;
  const text = question.toLowerCase();
  if (/balance|account|own|cash|net worth/.test(text)) return {
    title: "Your included accounts, in one place",
    text: balanceMinor === null ? "A complete account total is unavailable until every included account has a reported balance. The known snapshots are listed below; they are separate from this month's income or spending." : `${money(balanceMinor)} is reported across ${balanceCount} included accounts in this preview. That is a cash-account balance, separate from this month's income or spending.`,
    facts: [{ label: "Total account balance", value: balanceMinor === null ? "Unavailable" : money(balanceMinor) }, { label: "Accounts with included balances", value: String(balanceCount) }],
    points: balanceAccounts.map((account) => ({ label: account.label, value: money(toMinor(account.balance)) })),
    note: "Based on the latest reported snapshots in the synthetic Accounts workspace. Not live. Investments, savings-goal progress, other currencies and loans are excluded from this cash total.",
  };
  if (/food|budget|limit|grocer|close|left/.test(text) && foodBudget) return {
    title: "Food is close to its monthly budget",
    text: `You've recorded ${money(foodBudget.spentMinor)} against a ${money(foodBudget.budgetMinor)} Food budget. That leaves ${money(foodBudget.remainingMinor)} in the budget shown for October.`,
    facts: [{ label: "Food budget used", value: `${Math.round(foodBudget.spentMinor / foodBudget.budgetMinor * 100)}%`, tone: "expense" }, { label: "Budget remaining", value: money(foodBudget.remainingMinor) }],
    points: [...new Set(monthRows.filter((row) => row.type === "expense" && row.category === "Food").map((row) => row.description))].map((description) => ({ label: description, value: money(monthRows.filter((row) => row.type === "expense" && row.category === "Food" && row.description === description).reduce((sum, row) => sum + row.minor, 0)) })).sort((a, b) => {
      const amount = (value: string) => Number(value.replace(/[^0-9.]/g, ""));
      return amount(b.value) - amount(a.value);
    }).slice(0, 3),
    note: "This is a breakdown of the synthetic ledger, not a forecast or a new budget change.",
  };
  if (/bill|renew|coming|subscription|upcoming|due/.test(text)) {
    const upcoming = previewLedger.upcomingBills ?? [];
    return {
      title: "Here is what is coming up",
      text: `The preview has ${upcoming.length} bills in the next 30 days, totaling ${money(upcoming.reduce((sum, item) => sum + toMinor(item.amount ?? "0.00"), 0))}.`,
      points: upcoming.map((item) => ({ label: `${item.name} · ${new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "Africa/Accra" }).format(new Date(item.renewalDate + "T12:00:00Z"))}`, value: money(toMinor(item.amount ?? "0.00")) })),
      note: "These are saved synthetic bills. No payment will be made from this preview.",
    };
  }
  if (/saving|goal|emergency|trip/.test(text)) return {
    title: "Your savings goals have their own view",
    text: "The preview tracks two savings goals. Their progress is shown separately because that money can already be included in a bank-account balance.",
    points: previewLedger.goals.map((goal) => ({ label: goal.name, value: `${money(toMinor(goal.currentAmount))} of ${money(toMinor(goal.targetAmount))}` })),
    note: "Goal progress is not added to the Total account balance card.",
  };
  if (/income|earn|salary|kept|keep|month|spen|expense|overview|money|change/.test(text)) return {
    title: /income|earn|salary/.test(text) ? "Your income this month" : "October at a glance",
    text: `You've recorded ${money(spentMinor)} in spending and ${money(incomeMinor)} in income this month, ${previewName}. The difference is ${money(incomeMinor - spentMinor)}${incomeMinor > 0 ? `, or ${Math.round((incomeMinor - spentMinor) / incomeMinor * 100)}% of recorded income kept` : ""}.`,
    facts: [{ label: "Spent this month", value: money(spentMinor), tone: "expense" }, { label: "Income kept", value: money(incomeMinor - spentMinor), tone: "income" }],
    points: [{ label: "Largest spending category", value: largestCategory }, { label: "Food budget used", value: `${foodBudget ? Math.round(foodBudget.spentMinor / foodBudget.budgetMinor * 100) : 0}%` }],
    note: "Based on the synthetic October ledger. Kept is income minus spending, not your total account balance.",
  };
  return {
    title: "Let's keep it grounded in your overview",
    text: "I can demonstrate answers about October spending, income, food budgets, account balances, upcoming bills and savings goals using this preview's synthetic records.",
    note: "This local demo has no connected AI model or live accounts. Nothing is saved or sent outside this browser.",
  };
}

const SUGGESTIONS = [
  { title: "Understand my spending", question: "How is my spending looking this month?", icon: <path d="M4 19V9m8 10V4m8 15v-7" /> },
  { title: "Check my food budget", question: "Why is food close to its budget limit?", icon: <><circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/></> },
  { title: "See upcoming bills", question: "What bills are coming up?", icon: <><rect x="4" y="5" width="16" height="16" rx="2"/><path d="M8 3v4m8-4v4M4 10h16"/></> },
];

function subscribeLocation(onChange: () => void) {
  window.addEventListener("popstate", onChange);
  return () => window.removeEventListener("popstate", onChange);
}
function locationSnapshot() { return window.location.search; }
function FinancialText({ text }: { text: string }) {
  return <>{text.split(/((?:GH₵|GHS)\s?[\d,]+(?:\.\d{2})?)/g).map((part, index) => /^(?:GH₵|GHS)/.test(part) ? <span key={index} className="amount">{part}</span> : part)}</>;
}

function AssistantReply({ reply }: { reply: Reply }) {
  return <div className="alfred-chat-assistantContent">
    <h3>{reply.title}</h3>
    <p><FinancialText text={reply.text}/></p>
    {reply.facts ? <div className="alfred-chat-replyFacts">{reply.facts.map((fact) => <div key={fact.label} data-tone={fact.tone}><span>{fact.label}</span><strong className={/[₵]/.test(fact.value) ? "tabular-nums" : ""}>{fact.value}</strong></div>)}</div> : null}
    {reply.points ? <dl className="alfred-chat-replyPoints">{reply.points.map((point) => <div key={point.label}><dt>{point.label}</dt><dd><FinancialText text={point.value}/></dd></div>)}</dl> : null}
    {reply.note ? <p className="alfred-chat-source"><PreviewIcon><path d="m5 12 4 4L19 6"/></PreviewIcon>{reply.note}</p> : null}
  </div>;
}

export function ChatPreview() {
  const accounting = usePreviewAccounting();
  const finance = useMemo(() => financeContext(accounting), [accounting]);
  const { previewLedger, spentMinor, incomeMinor, balanceAccounts, balanceCount, foodBudget } = finance;
  const query = useSyncExternalStore(subscribeLocation, locationSnapshot, () => "");
  const handoff = new URLSearchParams(query).get("question")?.trim().slice(0, 1000) ?? "";
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [freshStart, setFreshStart] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const notebookPanel = useNotebookPanel();
  const input = useRef<HTMLTextAreaElement>(null);
  const composer = useRef<HTMLFormElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const stayAtBottom = useRef(true);
  const question = freshStart ? "" : handoff || "How is my month looking?";
  const initial: Message[] = question ? [
    { id: "initial-user", role: "user", text: question },
    { id: "initial-alfred", role: "assistant", reply: demoReply(question, finance), question },
  ] : [{ id: "initial-alfred", role: "assistant", reply: { title: `What would you like to know, ${previewName}?`, text: "Ask about your spending, budgets, accounts or bills. I'll use the synthetic October overview shown beside this conversation.", note: "Local demo. No connected model, account changes or external messages." } }];
  const thread = [...initial, ...messages];

  useEffect(() => {
    if (stayAtBottom.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [messages.length, question]);

  useEffect(() => {
    const node = scroll.current;
    if (!node) return;
    const observer = new ResizeObserver(() => { if (stayAtBottom.current) node.scrollTop = node.scrollHeight; });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  function ask(value: string) {
    const clean = value.trim().slice(0, 1000);
    if (!clean) return;
    stayAtBottom.current = true;
    setMessages((current) => [...current, { id: `question-${current.length}`, role: "user", text: clean }, { id: `reply-${current.length}`, role: "assistant", reply: demoReply(clean, finance), question: clean }]);
    setDraft("");
    input.current?.focus({ preventScroll: true });
  }
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); ask(draft); }
  function enter(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); ask(draft); }
  }

  return <div className="alfred-chat-workspace">
    <h1 className="sr-only">Chat</h1>
    <div className="alfred-chat-layout">
      <section className="alfred-chat-conversation" aria-label="Chat with Alfred">

        <div ref={scroll} className="alfred-chat-thread" tabIndex={0} onScroll={(event) => { const node = event.currentTarget; stayAtBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48; }} role="log" aria-label="Conversation" aria-live="polite" aria-relevant="additions">
        {handoff && !freshStart ? <div className="alfred-chat-handoff"><PreviewIcon><path d="m4 12 4 4 12-12M4 20h16"/></PreviewIcon>Question from your dashboard insights</div> : null}
          <p className="alfred-chat-dayDivider">24 October · Synthetic conversation</p>
          {thread.map((message) => message.role === "user" ? <div className="alfred-chat-userTurn" key={message.id}><div><p>{message.text}</p></div><span className="alfred-chat-userAvatar" aria-hidden="true">A</span></div> : <article className="alfred-chat-assistantTurn" key={message.id}><div className="alfred-chat-messageIdentity"><AlfredMark size="size-6"/><span>Alfred</span><span>Demo response</span></div><AssistantReply reply={message.question ? demoReply(message.question, finance) : message.reply}/></article>)}
        </div>
        <div className="alfred-chat-composeArea">
        <div className="alfred-chat-suggestions" aria-label="Suggested questions">{SUGGESTIONS.map((suggestion) => <button type="button" key={suggestion.title} onClick={() => ask(suggestion.question)}><PreviewIcon>{suggestion.icon}</PreviewIcon>{suggestion.title}<span aria-hidden="true">↗</span></button>)}</div>
        <form ref={composer} className="alfred-chat-composer" onSubmit={submit} data-preview-local-form="true">
          <div className="alfred-chat-composerHeader"><label htmlFor="alfred-chat-message">Ask Alfred</label>
            <div className="alfred-chat-headerTools" role="group" aria-label="Conversation actions">
              <button className="alfred-chat-contextToggle" type="button" aria-label={contextOpen ? "Hide context" : "Show context"} title={contextOpen ? "Hide context" : "Show context"} aria-expanded={contextOpen} aria-controls="alfred-chat-context" onClick={() => setContextOpen((open) => !open)}><PreviewIcon><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M14 4v16M6 8h4m-4 4h4"/></PreviewIcon><span className="alfred-chat-actionLabel">{contextOpen ? "Hide context" : "Show context"}</span></button>
              <button className="alfred-notebook-open" type="button" aria-label="Notebook" title="Notebook" aria-haspopup="dialog" aria-expanded={notebookPanel.open} aria-controls="alfred-chat-notebook" onClick={() => notebookPanel.setOpen(true)}><NotebookIcon/><span className="alfred-chat-actionLabel">Notebook</span></button>
              <button className="alfred-chat-new" type="button" aria-label="New conversation" title="New conversation" onClick={() => { setMessages([]); setDraft(""); setFreshStart(true); input.current?.focus(); }}><PreviewIcon><path d="M12 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-7M16 3l5 5M10 14l2-6 5-5a2.1 2.1 0 0 1 3 3l-5 5-5 3Z"/></PreviewIcon><span className="alfred-chat-actionLabel">New conversation</span></button>
            </div>
          </div>
          <textarea ref={input} id="alfred-chat-message" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={enter} placeholder="Ask about your spending, budget or accounts…" maxLength={1000} rows={2}/>
          <div className="alfred-chat-composerFooter"><div className="alfred-chat-footerUtilities"><PrivacyToggle/><p><span className="alfred-chat-demoBadge">Local demo</span><span className="alfred-chat-enterHint">Enter to ask · Shift + Enter for a new line</span></p></div><button type="submit" disabled={!draft.trim()} aria-label="Ask Alfred"><span>Ask Alfred</span><PreviewIcon><path d="M12 19V5m-5 5 5-5 5 5"/></PreviewIcon></button></div>
        </form>
        <p className="alfred-chat-demoNote">Demo answers use synthetic records in this browser. No live AI or account changes.</p>
        </div>
      </section>
      <aside id="alfred-chat-context" className="alfred-chat-context" data-open={contextOpen} aria-label="Conversation context">
        <div className="alfred-chat-contextTitle"><span>Conversation context</span><span>October</span></div>
        <details className="alfred-chat-previewUtilities"><summary>Preview options</summary><p>October overview</p><PreviewChatTools/></details>
        <section className="alfred-chat-snapshot"><h2>Your month at a glance</h2><dl><div><dt>Spent</dt><dd className="tabular-nums alfred-chat-expense">{money(spentMinor)}</dd></div><div><dt>Income</dt><dd className="tabular-nums alfred-chat-income">{money(incomeMinor)}</dd></div><div><dt>Kept</dt><dd className="tabular-nums">{money(incomeMinor - spentMinor)}</dd></div></dl><Link href="/ui-preview">Open Overview <span aria-hidden="true">↗</span></Link></section>
        <section className="alfred-chat-budgetContext"><div><PreviewIcon><circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/></PreviewIcon><h2>Food budget</h2></div><p><strong>{foodBudget ? Math.round(foodBudget.spentMinor / foodBudget.budgetMinor * 100) : 0}%</strong> used this month</p><div className="alfred-chat-budgetTrack" role="progressbar" aria-label="Food budget used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={foodBudget ? Math.round(foodBudget.spentMinor / foodBudget.budgetMinor * 100) : 0}><span style={{width:`${foodBudget ? Math.min(100, foodBudget.spentMinor / foodBudget.budgetMinor * 100) : 0}%`}}/></div><p className="alfred-chat-budgetRemaining"><span className="amount">{money(foodBudget?.remainingMinor ?? 0)}</span> left in the saved budget</p></section>
        <section className="alfred-chat-accounts"><h2>Included account balances</h2><ul>{balanceAccounts.map((account) => <li key={account.id}><span>{account.label}</span><strong className="tabular-nums">{money(toMinor(account.balance))}</strong></li>)}</ul><p>{balanceCount} included {balanceCount === 1 ? "account" : "accounts"} · Reported snapshots · Not live</p></section>
        <Link className="alfred-chat-reviewLink" href="/ui-preview/accounts?tab=needs-attention"><span><strong>{previewLedger.bank.needsLabel.length} {previewLedger.bank.needsLabel.length === 1 ? "payment needs" : "payments need"} a label</strong><small>Give your overview more context</small></span><span aria-hidden="true">↗</span></Link>
      </aside>
    </div>
    <NotebookPanel open={notebookPanel.open} onClose={() => notebookPanel.setOpen(false)} demo><ChatNotebookPreview/></NotebookPanel>
  </div>;
}
