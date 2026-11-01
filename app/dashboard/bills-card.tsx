"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Spinner } from "@/app/components/status";
import { Button, Card, Dialog, EmptyState, Field, inputClass, sendJson } from "@/app/components/ui";
import type { BillCadence, BillRecord, RenewalSuggestion, UpcomingBill } from "@/lib/finance/bills";
import { formatDisplayDate } from "@/lib/finance/dates";
import { formatAmount, formatMinor, toMinor } from "@/lib/finance/money";

const CADENCE_LABELS: Record<BillCadence, string> = {
  once: "One time",
  weekly: "Weekly",
  monthly: "Monthly",
  yearly: "Yearly",
};

export function BillsCard({
  bills,
  upcoming,
  suggestions,
  currency,
  today,
}: {
  bills: BillRecord[];
  upcoming: UpcomingBill[];
  suggestions: RenewalSuggestion[];
  currency: string;
  today: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Partial<BillRecord> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  const knownUpcoming = upcoming.filter((item) => item.amount !== null);
  const variableCount = upcoming.length - knownUpcoming.length;
  const upcomingMinor = knownUpcoming.reduce((sum, item) => sum + toMinor(item.amount!), 0);

  async function act(key: string, body: Record<string, unknown>) {
    setBusy(key);
    setError("");
    try {
      await sendJson("/api/bills", "POST", body);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That bill could not be updated.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card
      title="Bills & renewals · next 30 days"
      action={
        <div className="flex items-center gap-2">
          {suggestions.length > 0 ? (
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-accent hover:underline"
            >
              {suggestions.length} suggested
            </button>
          ) : null}
          <button type="button" onClick={() => setOpen(true)} className="text-xs text-muted underline-offset-2 hover:text-ink hover:underline">
            Manage ({bills.length})
          </button>
        </div>
      }
    >
      {upcoming.length === 0 && suggestions.length === 0 ? (
        <EmptyState>
          No upcoming bills in the next 30 days.{" "}
          <button
            type="button"
            onClick={() => {
              setEditing({ name: "", nextDate: today, amount: "", cadence: "monthly" });
              setOpen(true);
            }}
            className="text-accent underline-offset-2 hover:underline"
          >
            Add a bill
          </button>
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-3">
          {upcoming.length > 0 ? (
            <>
              <div className="rounded-xl bg-surface-2 px-3.5 py-2.5">
                <p className="text-xs text-muted">Planned in the next 30 days</p>
                <p className="mt-0.5 text-lg font-medium tabular-nums">
                  {knownUpcoming.length > 0
                    ? `${formatMinor(upcomingMinor, currency)}${variableCount > 0 ? ` + ${variableCount} variable` : ""}`
                    : "Amount varies"}
                </p>
              </div>
              <ul className="flex flex-col gap-2">
                {upcoming.slice(0, 4).map((bill) => (
                  <li key={bill.id} className="flex items-center justify-between gap-3 text-sm">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{bill.name}</p>
                      <p className="text-xs text-muted">
                        Due {formatDisplayDate(bill.renewalDate)} · {CADENCE_LABELS[bill.cadence]}
                      </p>
                    </div>
                    <span className="shrink-0 tabular-nums text-sm">
                      {bill.amount ? formatAmount(bill.amount, bill.currency) : <span className="text-xs text-muted">Varies</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          {suggestions.length > 0 ? (
            <div className="rounded-xl border border-accent/25 bg-accent-soft/60 p-3">
              <p className="text-xs font-medium text-accent">Spotted in your payments</p>
              <ul className="mt-2 flex flex-col gap-2">
                {suggestions.slice(0, 2).map((item) => (
                  <li key={item.id} className="flex items-center justify-between gap-2 text-xs">
                    <div className="min-w-0">
                      <span className="font-medium text-ink">{item.name}</span>
                      <span className="text-muted"> · next around {formatDisplayDate(item.expectedDate)}</span>
                    </div>
                    <Button
                      size="sm"
                      onClick={() => {
                        setEditing({
                          name: item.name,
                          nextDate: item.expectedDate,
                          amount: item.expectedAmount ?? "",
                          cadence: item.cadence,
                        });
                        setOpen(true);
                      }}
                    >
                      Confirm
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}

      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
          setEditing(null);
          setError("");
        }}
        title={editing ? (editing.id ? "Edit bill" : "Add a bill") : "Bills & renewals"}
      >
        {editing ? (
          <BillForm
            initial={editing}
            currency={currency}
            today={today}
            onCancel={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              router.refresh();
            }}
          />
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted">Confirmed bills get a Telegram reminder the day before they renew.</p>
              <Button size="sm" variant="primary" onClick={() => setEditing({ name: "", nextDate: today, amount: "", cadence: "monthly" })}>
                + Add bill
              </Button>
            </div>

            {error ? (
              <p className="text-xs text-danger" role="alert">
                {error}
              </p>
            ) : null}

            {bills.length === 0 ? (
              <EmptyState>No saved bills yet.</EmptyState>
            ) : (
              <ul className="flex max-h-64 flex-col gap-2 overflow-y-auto">
                {bills.map((bill) => (
                  <li key={bill.id} className="flex items-center justify-between gap-3 rounded-xl border border-line bg-bg p-3 text-sm">
                    <div className="min-w-0">
                      <p className="truncate font-medium">
                        {bill.name}
                        {!bill.active ? <span className="ml-2 text-xs text-muted">(Paused)</span> : null}
                      </p>
                      <p className="text-xs text-muted">
                        {CADENCE_LABELS[bill.cadence]} · next {formatDisplayDate(bill.nextDate)} ·{" "}
                        <span className="tabular-nums">{bill.amount ? formatAmount(bill.amount, bill.currency) : "Amount varies"}</span>
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setEditing(bill)}>
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy !== null}
                        onClick={() => void act(`toggle:${bill.id}`, { action: bill.active ? "pause" : "resume", id: bill.id })}
                      >
                        {busy === `toggle:${bill.id}` ? <Spinner className="size-3" /> : bill.active ? "Pause" : "Resume"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy !== null}
                        onClick={() => void act(`del:${bill.id}`, { action: "delete", id: bill.id })}
                      >
                        Delete
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {suggestions.length > 0 ? (
              <div>
                <h3 className="mb-2 text-xs font-medium text-muted">Suggested from your history</h3>
                <ul className="flex flex-col gap-2">
                  {suggestions.map((item) => (
                    <li key={item.id} className="flex items-center justify-between gap-3 rounded-xl border border-line bg-bg p-3 text-xs">
                      <div className="min-w-0">
                        <p className="font-medium text-sm text-ink">{item.name}</p>
                        <p className="text-muted">
                          {item.basis} Next est. {formatDisplayDate(item.expectedDate)}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        onClick={() =>
                          setEditing({
                            name: item.name,
                            nextDate: item.expectedDate,
                            amount: item.expectedAmount ?? "",
                            cadence: item.cadence,
                          })
                        }
                      >
                        Add
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        )}
      </Dialog>
    </Card>
  );
}

function BillForm({
  initial,
  currency,
  today,
  onCancel,
  onSaved,
}: {
  initial: Partial<BillRecord>;
  currency: string;
  today: string;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial.name ?? "");
  const [nextDate, setNextDate] = useState(initial.nextDate ?? today);
  const [cadence, setCadence] = useState<BillCadence>(initial.cadence ?? "monthly");
  const [varies, setVaries] = useState(initial.id ? initial.amount === null : false);
  const [amount, setAmount] = useState(initial.amount ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setBusy(true);
    setError("");
    try {
      await sendJson("/api/bills", "POST", {
        action: "save",
        ...(initial.id ? { id: initial.id } : {}),
        name: name.trim(),
        nextDate,
        cadence,
        amount: varies ? null : amount.trim() || null,
      });
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That bill could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Field label="Name">
        <input className={inputClass} value={name} maxLength={80} placeholder="e.g. Netflix, Home internet, Rent" onChange={(e) => setName(e.target.value)} required />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Next payment date">
          <input className={inputClass} type="date" value={nextDate} onChange={(e) => setNextDate(e.target.value)} required />
        </Field>
        <Field label="Repeats">
          <select className={inputClass} value={cadence} onChange={(e) => setCadence(e.target.value as BillCadence)}>
            <option value="once">One time</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="yearly">Yearly</option>
          </select>
        </Field>
      </div>
      {!varies ? (
        <Field label={`Expected amount (${currency})`}>
          <input className={inputClass} inputMode="decimal" value={amount} placeholder="0.00" onChange={(e) => setAmount(e.target.value)} required={!varies} />
        </Field>
      ) : null}
      <label className="flex items-center gap-2 text-xs text-muted">
        <input type="checkbox" className="size-3.5 accent-[var(--color-accent)]" checked={varies} onChange={(e) => setVaries(e.target.checked)} />
        Amount varies each time (e.g. electricity or water)
      </label>
      {error ? (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      ) : null}
      <div className="mt-2 flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Back
        </Button>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? <Spinner /> : "Save bill"}
        </Button>
      </div>
    </form>
  );
}
