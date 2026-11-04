"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { buttonClassName } from "@/app/components/button-styles";
import { Select } from "@/app/components/select";
import { Spinner } from "@/app/components/status";
import { Button, Dialog, DialogActions, Field, inputClass, sendJson } from "@/app/components/ui";
import { EXPENSE_CATEGORIES, normalizeCategory } from "@/lib/finance/categories";
import { formatDisplayDate } from "@/lib/finance/dates";
import { canonicalizeAmount, formatAmount } from "@/lib/finance/money";
import { amountSchema, isoDateSchema, nonNegativeAmountSchema, yearMonthSchema } from "@/lib/finance/schemas";
import type { LedgerBudget } from "@/lib/web/ledger";
import "./overview-quick-actions.css";

type BudgetDraft = { kind: "budget"; category: string; amount: string; period: string };
type GoalDraft = { kind: "goal"; name: string; targetAmount: string; currentAmount: string; targetDate: string };
export type OverviewPlanDraft = BudgetDraft | GoalDraft;
export type OverviewPlanReview =
  | { kind: "budget"; payload: { category: string; amount: string; period: string }; previousAmount?: string }
  | { kind: "goal"; payload: { name: string; targetAmount: string; currentAmount: string; targetDate: string } };

/** Validate a proposed change without saving. Owner and currency remain server-derived in the existing APIs. */
export function prepareOverviewPlan(draft: OverviewPlanDraft, currency: string, budgets: LedgerBudget[] = []): { ok: true; review: OverviewPlanReview } | { ok: false; error: string } {
  if (draft.kind === "budget") {
    const category = normalizeCategory(draft.category, "expense");
    const amount = canonicalizeAmount(draft.amount);
    if (!category) return { ok: false, error: "Choose an expense category." };
    if (!amount || !amountSchema.safeParse(amount).success) return { ok: false, error: "Enter a positive amount with up to two decimals." };
    if (!yearMonthSchema.safeParse(draft.period).success) return { ok: false, error: "Choose a valid month." };
    const existing = budgets.find(budget => budget.category === category && budget.period === draft.period && budget.currency === currency);
    return { ok: true, review: { kind: "budget", payload: { category, amount, period: draft.period }, ...(existing ? { previousAmount: existing.amount } : {}) } };
  }
  const name = draft.name.trim();
  const targetAmount = canonicalizeAmount(draft.targetAmount);
  const currentAmount = canonicalizeAmount(draft.currentAmount || "0", { allowZero: true });
  if (!name || name.length > 80) return { ok: false, error: "Give the goal a name of 80 characters or fewer." };
  if (!targetAmount || !amountSchema.safeParse(targetAmount).success) return { ok: false, error: "Enter a positive target with up to two decimals." };
  if (!currentAmount || !nonNegativeAmountSchema.safeParse(currentAmount).success) return { ok: false, error: "Enter a saved amount of zero or more, with up to two decimals." };
  if (draft.targetDate && !isoDateSchema.safeParse(draft.targetDate).success) return { ok: false, error: "Choose a valid target date, or leave it blank." };
  return { ok: true, review: { kind: "goal", payload: { name, targetAmount, currentAmount, targetDate: draft.targetDate } } };
}

export const LOAN_START_HREF = `/chat?question=${encodeURIComponent("Help me record money I lent someone. Ask who, how much and when, then confirm the loan before saving it.")}`;

export function OverviewQuickAction({ kind, currency, today, budgets = [] }: { kind: "budget" | "goal" | "loan"; currency: string; today: string; budgets?: LedgerBudget[] }) {
  if (kind === "loan") return <div className="alfred-overview-emptyAction"><p>No money is owed to you right now.</p><Link href={LOAN_START_HREF} className={buttonClassName({ variant: "primary" })}>Record money lent</Link><p className="alfred-overview-actionHint">Alfred will ask for the details in Chat and confirm before saving.</p></div>;
  return <OverviewPlanAction kind={kind} currency={currency} today={today} budgets={budgets} />;
}

function OverviewPlanAction({ kind, currency, today, budgets }: { kind: "budget" | "goal"; currency: string; today: string; budgets: LedgerBudget[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<OverviewPlanDraft>(() => initialDraft(kind, today));
  const [review, setReview] = useState<OverviewPlanReview | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const close = () => { if (!saving.current) setOpen(false); };
  function begin() { setDraft(initialDraft(kind, today)); setReview(null); setError(""); setNotice(""); setOpen(true); }
  function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = prepareOverviewPlan(draft, currency, budgets);
    if (!result.ok) { setError(result.error); return; }
    setError(""); setReview(result.review);
  }
  async function save() {
    if (!review || saving.current) return;
    saving.current = true; setBusy(true); setError("");
    try {
      await sendJson(review.kind === "budget" ? "/api/budgets" : "/api/goals", "POST", review.payload);
      setOpen(false); setNotice(review.kind === "budget" ? "Budget saved." : "Savings goal created."); router.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "That could not be saved. Please try again."); }
    finally { saving.current = false; setBusy(false); }
  }
  const title = kind === "budget" ? "Add budget" : "Create savings goal";
  const updateBudget = review?.kind === "budget" && review.previousAmount !== undefined;
  return <div className="alfred-overview-emptyAction">
    <p>{kind === "budget" ? "Set a monthly limit for a category." : "Choose something to save towards."}</p>
    <Button variant="primary" onClick={begin} aria-haspopup="dialog">{kind === "budget" ? "Add budget" : "Create goal"}</Button>
    {notice ? <p role="status">{notice}</p> : null}
    <Dialog open={open} onClose={close} dismissible={!busy} title={review ? kind === "budget" ? "Review budget" : "Review savings goal" : title}>
      {open ? review ? <div className="alfred-overview-quickReview">
        <OverviewPlanSummary review={review} currency={currency} />
        {error ? <p className="alfred-overview-actionError" role="alert">{error}</p> : null}
        <DialogActions><Button onClick={() => { setReview(null); setError(""); }} disabled={busy}>Back</Button><Button variant="primary" onClick={() => void save()} disabled={busy} aria-busy={busy}>{busy ? <><Spinner />Saving…</> : kind === "goal" ? "Create goal" : updateBudget ? "Update budget" : "Set budget"}</Button></DialogActions>
      </div> : <form className="alfred-overview-quickForm" onSubmit={prepare}>
        {draft.kind === "budget" ? <>
          <Field label="Category"><Select value={draft.category} onChange={event => setDraft({ ...draft, category: event.target.value })}>{EXPENSE_CATEGORIES.map(category => <option key={category} value={category}>{category}</option>)}</Select></Field>
          <Field label={`Monthly amount (${currency})`}><input className={inputClass} autoFocus inputMode="decimal" required value={draft.amount} onChange={event => setDraft({ ...draft, amount: event.target.value })} placeholder="0.00" /></Field>
          <Field label="Month"><input className={inputClass} type="month" required value={draft.period} onChange={event => setDraft({ ...draft, period: event.target.value })} /></Field>
        </> : <>
          <Field label="Goal name"><input className={inputClass} autoFocus required maxLength={80} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} placeholder="e.g. A new laptop" /></Field>
          <Field label={`Target amount (${currency})`}><input className={inputClass} inputMode="decimal" required value={draft.targetAmount} onChange={event => setDraft({ ...draft, targetAmount: event.target.value })} placeholder="0.00" /></Field>
          <Field label={`Saved so far (${currency})`}><input className={inputClass} inputMode="decimal" value={draft.currentAmount} onChange={event => setDraft({ ...draft, currentAmount: event.target.value })} /></Field>
          <Field label="Target date (optional)"><input className={inputClass} type="date" value={draft.targetDate} onChange={event => setDraft({ ...draft, targetDate: event.target.value })} /></Field>
        </>}
        {error ? <p className="alfred-overview-actionError" role="alert">{error}</p> : null}
        <DialogActions><Button onClick={close}>Cancel</Button><Button variant="primary" type="submit">Review</Button></DialogActions>
      </form> : null}
    </Dialog>
  </div>;
}

function initialDraft(kind: "budget" | "goal", today: string): OverviewPlanDraft {
  return kind === "budget" ? { kind, category: EXPENSE_CATEGORIES[0], amount: "", period: today.slice(0, 7) } : { kind, name: "", targetAmount: "", currentAmount: "0", targetDate: "" };
}

export function OverviewPlanSummary({ review, currency }: { review: OverviewPlanReview; currency: string }) {
  return <><p>{review.kind === "budget" ? review.previousAmount !== undefined ? "Update this monthly spending limit?" : "Set this monthly spending limit?" : "Create this savings goal?"}</p><dl className="alfred-overview-quickFacts">
    {review.kind === "budget" ? <>
      <div><dt>Category</dt><dd>{review.payload.category}</dd></div>
      <div><dt>Month</dt><dd>{new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${review.payload.period}-01T00:00:00Z`))}</dd></div>
      {review.previousAmount !== undefined ? <div><dt>Current limit</dt><dd className="tabular-nums">{formatAmount(review.previousAmount, currency)}</dd></div> : null}
      <div><dt>{review.previousAmount !== undefined ? "New limit" : "Limit"}</dt><dd className="tabular-nums">{formatAmount(review.payload.amount, currency)}</dd></div>
    </> : <>
      <div><dt>Name</dt><dd>{review.payload.name}</dd></div>
      <div><dt>Target</dt><dd className="tabular-nums">{formatAmount(review.payload.targetAmount, currency)}</dd></div>
      <div><dt>Saved so far</dt><dd className="tabular-nums">{formatAmount(review.payload.currentAmount, currency)}</dd></div>
      <div><dt>Target date</dt><dd>{review.payload.targetDate ? formatDisplayDate(review.payload.targetDate) : "No date set"}</dd></div>
    </>}
  </dl><p className="alfred-overview-actionHint">{review.kind === "budget" ? "Your transactions and account balances stay the same." : "This tracks your goal. It does not change your account balance."}</p></>;
}
