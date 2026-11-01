"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";

import { Button, Card, ConfirmDialog, Dialog, EmptyState, Field, inputClass, sendJson } from "@/app/components/ui";
import { EXPENSE_CATEGORIES } from "@/lib/finance/categories";
import { canonicalizeAmount, formatAmount, formatMinor, toMinor } from "@/lib/finance/money";
import type { Ledger, LedgerBudget, LedgerGoal } from "@/lib/web/ledger";

type Pending = { title: string; body: ReactNode; confirmLabel: string; danger?: boolean; run: () => Promise<unknown> };

/** Shared confirm-then-save flow: every budget and goal change is restated before it is sent. */
function useConfirmedChange() {
  const router = useRouter();
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function confirm() {
    if (!pending) return;
    setBusy(true);
    setError("");
    try {
      await pending.run();
      setNotice("Saved ✓");
      setPending(null);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That didn't work. Try again.");
      setPending(null);
    } finally {
      setBusy(false);
    }
  }

  const dialog = (
    <ConfirmDialog
      open={pending != null}
      title={pending?.title ?? ""}
      body={pending?.body}
      confirmLabel={pending?.confirmLabel ?? "Confirm"}
      danger={pending?.danger}
      busy={busy}
      onConfirm={() => void confirm()}
      onClose={() => (busy ? undefined : setPending(null))}
    />
  );
  const status = (
    <p className="text-sm" role="status" aria-live="polite">
      {error ? <span className="text-danger">{error}</span> : notice ? <span className="text-success">{notice}</span> : null}
    </p>
  );
  return {
    ask: (next: Pending) => {
      setNotice("");
      setError("");
      setPending(next);
    },
    dialog,
    status,
  };
}

function monthName(period: string): string {
  const [year, month] = period.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, 1)));
}

function displayDate(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, day)));
}

function Progress({ value, over = false }: { value: number; over?: boolean }) {
  const width = Math.max(0, Math.min(100, value));
  return (
    <div className="h-2 overflow-hidden rounded-full bg-surface-2" role="presentation">
      <div className={`h-full rounded-full ${over ? "bg-danger" : width >= 80 ? "bg-accent" : "bg-success"}`} style={{ width: `${width}%` }} />
    </div>
  );
}

// ---------- Budgets ----------

type BudgetDraft = { category: string; amount: string; period: string; existing?: LedgerBudget };

export function BudgetsSection({ ledger }: { ledger: Ledger }) {
  const thisMonth = ledger.today.slice(0, 7);
  const [showPast, setShowPast] = useState(false);
  const [draft, setDraft] = useState<BudgetDraft | null>(null);
  const [draftError, setDraftError] = useState("");
  const change = useConfirmedChange();

  const current = ledger.budgets.filter((item) => item.period >= thisMonth);
  const past = ledger.budgets.filter((item) => item.period < thisMonth);
  const shown = showPast ? ledger.budgets : current;

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    const amount = canonicalizeAmount(draft.amount);
    if (!amount) {
      setDraftError("Enter a positive amount with up to two decimals.");
      return;
    }
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(draft.period)) {
      setDraftError("Pick a month.");
      return;
    }
    const existing =
      draft.existing ?? ledger.budgets.find((item) => item.category === draft.category && item.period === draft.period && item.currency === ledger.currency);
    const money = formatAmount(amount, ledger.currency);
    const body = existing ? (
      <>
        Change your <strong className="text-ink">{draft.category}</strong> budget for {monthName(draft.period)} from{" "}
        {formatAmount(existing.amount, existing.currency)} to <strong className="text-ink">{money}</strong>?
      </>
    ) : (
      <>
        Set your <strong className="text-ink">{draft.category}</strong> budget for {monthName(draft.period)} to <strong className="text-ink">{money}</strong>?
      </>
    );
    const payload = { category: draft.category, amount, period: draft.period };
    setDraft(null);
    change.ask({
      title: existing ? "Change budget?" : "Set budget?",
      body,
      confirmLabel: existing ? "Change budget" : "Set budget",
      run: () => sendJson("/api/budgets", "POST", payload),
    });
  }

  function remove(budget: LedgerBudget) {
    change.ask({
      title: "Delete budget?",
      body: (
        <>
          Delete your <strong className="text-ink">{budget.category}</strong> budget of {formatAmount(budget.amount, budget.currency)} for{" "}
          {monthName(budget.period)}? Your transactions stay as they are.
        </>
      ),
      confirmLabel: "Delete budget",
      danger: true,
      run: () => sendJson("/api/budgets", "DELETE", { budgetId: budget.budgetId }),
    });
  }

  return (
    <Card
      title="Budgets"
      action={
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            setDraftError("");
            setDraft({ category: EXPENSE_CATEGORIES[0], amount: "", period: thisMonth });
          }}
        >
          Add budget
        </Button>
      }
    >
      <p className="mb-4 text-sm text-muted">
        Monthly spending limits per category. You can also just tell Alfred, “set a food budget of 800”. He&apos;ll check with you before saving.
      </p>

      {shown.length === 0 ? (
        <EmptyState>No budgets for this month yet. Add one here or ask Alfred in chat.</EmptyState>
      ) : (
        <ul className="flex flex-col gap-3">
          {shown.map((budget) => {
            const used = budget.budgetMinor > 0 ? Math.round((budget.spentMinor / budget.budgetMinor) * 100) : 0;
            const over = budget.remainingMinor < 0;
            return (
              <li key={budget.budgetId} className="rounded-xl border border-line bg-bg p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium">{budget.category}</p>
                    <p className="text-xs text-muted">{monthName(budget.period)}</p>
                  </div>
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setDraftError("");
                        setDraft({ category: budget.category, amount: budget.amount, period: budget.period, existing: budget });
                      }}
                    >
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" className="hover:text-danger" onClick={() => remove(budget)}>
                      Delete
                    </Button>
                  </div>
                </div>
                <div className="mt-3">
                  <Progress value={used} over={over} />
                </div>
                <div className="mt-2 flex flex-wrap justify-between gap-2 text-xs tabular-nums">
                  <span className="text-muted">
                    {formatMinor(budget.spentMinor, budget.currency)} of {formatAmount(budget.amount, budget.currency)} ({used}%)
                  </span>
                  <span className={over ? "text-danger" : "text-success"}>
                    {over ? `${formatMinor(-budget.remainingMinor, budget.currency)} over` : `${formatMinor(budget.remainingMinor, budget.currency)} left`}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        {change.status}
        {past.length > 0 ? (
          <Button size="sm" variant="ghost" onClick={() => setShowPast((value) => !value)}>
            {showPast ? "Hide past months" : `Show past months (${past.length})`}
          </Button>
        ) : null}
      </div>

      <Dialog open={draft != null} onClose={() => setDraft(null)} title={draft?.existing ? "Edit budget" : "Add budget"}>
        {draft ? (
          <form className="flex flex-col gap-4" onSubmit={review}>
            <Field label="Category">
              <select
                value={draft.category}
                disabled={Boolean(draft.existing)}
                onChange={(event) => setDraft({ ...draft, category: event.target.value })}
                className={`${inputClass} disabled:opacity-60`}
              >
                {EXPENSE_CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={`Amount (${ledger.currency})`}>
              <input
                inputMode="decimal"
                value={draft.amount}
                autoFocus
                onChange={(event) => setDraft({ ...draft, amount: event.target.value })}
                className={inputClass}
                placeholder="800"
              />
            </Field>
            <Field label="Month">
              <input
                type="month"
                value={draft.period}
                disabled={Boolean(draft.existing)}
                onChange={(event) => setDraft({ ...draft, period: event.target.value })}
                className={`${inputClass} disabled:opacity-60`}
              />
            </Field>
            {draftError ? (
              <p className="text-sm text-danger" role="alert">
                {draftError}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setDraft(null)}>
                Cancel
              </Button>
              <Button variant="primary" type="submit">
                Review
              </Button>
            </div>
          </form>
        ) : null}
      </Dialog>
      {change.dialog}
    </Card>
  );
}

// ---------- Savings goals ----------

type GoalDraft = { name: string; targetAmount: string; currentAmount: string; targetDate: string; completed: boolean; existing?: LedgerGoal };

export function GoalsSection({ ledger }: { ledger: Ledger }) {
  const [draft, setDraft] = useState<GoalDraft | null>(null);
  const [draftError, setDraftError] = useState("");
  const change = useConfirmedChange();

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    const name = draft.name.trim();
    const target = canonicalizeAmount(draft.targetAmount);
    const current = canonicalizeAmount(draft.currentAmount || "0", { allowZero: true });
    if (!name) return setDraftError("Give the goal a name.");
    if (!target) return setDraftError("Enter a positive target amount.");
    if (!current) return setDraftError("Enter the amount saved so far, or 0.");
    const currency = draft.existing?.currency ?? ledger.currency;
    const money = (value: string) => formatAmount(value, currency);
    const existing = draft.existing;
    let body: ReactNode;
    if (existing) {
      const lines: string[] = [];
      if (name !== existing.name) lines.push(`Name: ${existing.name} → ${name}`);
      if (target !== existing.targetAmount) lines.push(`Target: ${money(existing.targetAmount)} → ${money(target)}`);
      if (current !== existing.currentAmount) lines.push(`Saved: ${money(existing.currentAmount)} → ${money(current)}`);
      if (draft.targetDate !== existing.targetDate) lines.push(`By: ${draft.targetDate ? displayDate(draft.targetDate) : "no date"}`);
      const status = draft.completed ? "completed" : "active";
      if (status !== existing.status) lines.push(`Status: ${existing.status} → ${status}`);
      if (lines.length === 0) return setDraftError("Nothing has changed yet.");
      body = (
        <>
          <p>
            Update <strong className="text-ink">{existing.name}</strong>?
          </p>
          <ul className="mt-2 list-disc pl-5">
            {lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </>
      );
    } else {
      body = (
        <>
          Create a savings goal <strong className="text-ink">{name}</strong> with a target of <strong className="text-ink">{money(target)}</strong>
          {toMinor(current) > 0 ? `, ${money(current)} saved so far` : ""}
          {draft.targetDate ? `, by ${displayDate(draft.targetDate)}` : ""}?
        </>
      );
    }
    const fields = { name, targetAmount: target, currentAmount: current, targetDate: draft.targetDate };
    const run = existing
      ? () => sendJson("/api/goals", "PATCH", { ...fields, goalId: existing.goalId, status: draft.completed ? "completed" : "active" })
      : () => sendJson("/api/goals", "POST", fields);
    setDraft(null);
    change.ask({ title: existing ? "Update goal?" : "Create goal?", body, confirmLabel: existing ? "Update goal" : "Create goal", run });
  }

  function remove(goal: LedgerGoal) {
    change.ask({
      title: "Delete goal?",
      body: (
        <>
          Delete <strong className="text-ink">{goal.name}</strong> ({formatAmount(goal.currentAmount, goal.currency)} of {formatAmount(goal.targetAmount, goal.currency)})?
          Your transactions stay as they are.
        </>
      ),
      confirmLabel: "Delete goal",
      danger: true,
      run: () => sendJson("/api/goals", "DELETE", { goalId: goal.goalId }),
    });
  }

  return (
    <Card
      title="Savings goals"
      action={
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            setDraftError("");
            setDraft({ name: "", targetAmount: "", currentAmount: "0", targetDate: "", completed: false });
          }}
        >
          New goal
        </Button>
      }
    >
      <p className="mb-4 text-sm text-muted">Track progress towards things you&apos;re saving for. This records progress; it isn&apos;t a bank balance.</p>
      {ledger.goals.length === 0 ? (
        <EmptyState>No savings goals yet. Create one here or tell Alfred what you&apos;re saving for.</EmptyState>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {ledger.goals.map((goal) => {
            const target = toMinor(goal.targetAmount);
            const saved = toMinor(goal.currentAmount);
            const percent = target > 0 ? Math.round((saved / target) * 100) : 0;
            return (
              <li key={goal.goalId} className="flex flex-col rounded-xl border border-line bg-bg p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{goal.name}</p>
                    <p className="text-xs text-muted">
                      {goal.status === "completed" ? "Completed 🎉" : goal.targetDate ? `By ${displayDate(goal.targetDate)}` : "No target date"}
                    </p>
                  </div>
                  <span className="text-sm font-medium tabular-nums text-accent">{percent}%</span>
                </div>
                <div className="mt-3">
                  <Progress value={percent} />
                </div>
                <p className="mt-2 text-xs tabular-nums text-muted">
                  {formatAmount(goal.currentAmount, goal.currency)} of {formatAmount(goal.targetAmount, goal.currency)}
                </p>
                <div className="mt-3 flex gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setDraftError("");
                      setDraft({
                        name: goal.name,
                        targetAmount: goal.targetAmount,
                        currentAmount: goal.currentAmount,
                        targetDate: goal.targetDate,
                        completed: goal.status === "completed",
                        existing: goal,
                      });
                    }}
                  >
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" className="hover:text-danger" onClick={() => remove(goal)}>
                    Delete
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-4">{change.status}</div>

      <Dialog open={draft != null} onClose={() => setDraft(null)} title={draft?.existing ? "Edit goal" : "New savings goal"}>
        {draft ? (
          <form className="flex flex-col gap-4" onSubmit={review}>
            <Field label="Name">
              <input
                value={draft.name}
                maxLength={80}
                autoFocus
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                className={inputClass}
                placeholder="New laptop"
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={`Target (${draft.existing?.currency ?? ledger.currency})`}>
                <input
                  inputMode="decimal"
                  value={draft.targetAmount}
                  onChange={(event) => setDraft({ ...draft, targetAmount: event.target.value })}
                  className={inputClass}
                  placeholder="3000"
                />
              </Field>
              <Field label="Saved so far">
                <input
                  inputMode="decimal"
                  value={draft.currentAmount}
                  onChange={(event) => setDraft({ ...draft, currentAmount: event.target.value })}
                  className={inputClass}
                />
              </Field>
            </div>
            <Field label="Target date (optional)">
              <input type="date" value={draft.targetDate} onChange={(event) => setDraft({ ...draft, targetDate: event.target.value })} className={inputClass} />
            </Field>
            {draft.existing ? (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.completed}
                  onChange={(event) => setDraft({ ...draft, completed: event.target.checked })}
                  className="size-4 accent-[var(--accent)]"
                />
                Mark as completed
              </label>
            ) : null}
            {draftError ? (
              <p className="text-sm text-danger" role="alert">
                {draftError}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setDraft(null)}>
                Cancel
              </Button>
              <Button variant="primary" type="submit">
                Review
              </Button>
            </div>
          </form>
        ) : null}
      </Dialog>
      {change.dialog}
    </Card>
  );
}
