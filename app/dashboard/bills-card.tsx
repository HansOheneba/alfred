"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { buttonClassName } from "@/app/components/button-styles";
import { Spinner } from "@/app/components/status";
import { Select } from "@/app/components/select";
import { Button, Card, Dialog, DialogActions, EmptyState, Field, inputClass, sendJson } from "@/app/components/ui";
import { TemporalInput } from "@/app/components/temporal-input";
import type { BillCadence, BillRecord, RenewalSuggestion, UpcomingBill } from "@/lib/finance/bills";
import type { BillAction } from "@/lib/finance/bill-schedule";
import { renewalSuggestionBillDraft } from "@/lib/finance/bill-renewals";
import { formatDisplayDate, isRealDate } from "@/lib/finance/dates";
import { canonicalizeAmount, formatAmount, formatMinor, toMinor } from "@/lib/finance/money";
import "./bills-card.css";

export type { BillAction } from "@/lib/finance/bill-schedule";

type BillDraft = Partial<BillRecord> & { suggestionId?: string; variableEstimate?: boolean; lastPayment?: { amount?: string; date?: string } };
type SavedBillDetails = Pick<BillRecord, "name" | "nextDate" | "amount" | "currency" | "cadence">;

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
  onAction,
  showCategoryLink = false,
  reminderNote = "Confirmed bills get a Telegram reminder the day before they renew.",
}: {
  bills: BillRecord[];
  upcoming: UpcomingBill[];
  suggestions: RenewalSuggestion[];
  currency: string;
  today: string;
  onAction?: (action: BillAction) => Promise<unknown>;
  reminderNote?: string;
  showCategoryLink?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<BillDraft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [formBusy, setFormBusy] = useState(false);
  const [savedBill, setSavedBill] = useState<SavedBillDetails | null>(null);
  const [receiptOpen, setReceiptOpen] = useState(false);

  function confirmSuggestion(item: RenewalSuggestion) {
    setEditing({ ...renewalSuggestionBillDraft(item), suggestionId: item.id, variableEstimate: item.expectedAmount === null, lastPayment: { amount: item.lastAmount, date: item.lastDate } });
    setOpen(true);
  }

  const knownUpcoming = upcoming.filter((item) => item.amount !== null);
  const variableCount = upcoming.length - knownUpcoming.length;
  const fixedTotals = new Map<string, number>();
  for (const bill of knownUpcoming) fixedTotals.set(bill.currency, (fixedTotals.get(bill.currency) ?? 0) + toMinor(bill.amount!));

  function close() {
    setOpen(false);
    setEditing(null);
    setError("");
  }

  async function act(key: string, body: BillAction) {
    setBusy(key);
    setError("");
    try {
      if (onAction) await onAction(body);
      else {
        await sendJson("/api/bills", "POST", body);
        router.refresh();
      }
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
        <div className="alfred-bills-headerActions flex flex-wrap items-center justify-end gap-2">
          {suggestions.length > 0 ? (
            <button
              type="button"
              onClick={() => setOpen(true)}
              className={buttonClassName({ variant: "soft", size: "sm" })}
            >
              {suggestions.length} suggested
            </button>
          ) : null}
          <button type="button" onClick={() => setOpen(true)} className={buttonClassName({ variant: "ghost", size: "sm" })}>
            Manage ({bills.length})
          </button>
        </div>
      }
    >
      {savedBill ? (
        <div className="alfred-bills-saveNotice">
          <p role="status"><strong>{savedBill.name}</strong> bill saved.</p>
          <Button size="sm" variant="ghost" onClick={() => setReceiptOpen(true)}>View bill</Button>
        </div>
      ) : null}
      {upcoming.length === 0 && suggestions.length === 0 ? (
        <div className="alfred-bills-emptyAction">
          <p>Keep the next payment date and amount in one place.</p>
          <Button
            variant="primary"
            aria-haspopup="dialog"
            onClick={() => {
              setEditing({ name: "", nextDate: today, amount: "", cadence: "monthly" });
              setOpen(true);
            }}
          >
            Add a bill
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {upcoming.length > 0 ? (
            <>
              <div className="rounded-xl bg-surface-2 px-4 py-3">
                <p className="text-xs text-muted">Confirmed bills · fixed amounts</p>
                <p className="mt-1 text-lg font-medium tabular-nums">
                  {knownUpcoming.length > 0
                    ? [...fixedTotals].map(([unit, minor]) => formatMinor(minor, unit)).join(" + ")
                    : "No fixed amounts"}
                </p>
                {variableCount > 0 ? <p className="mt-1 text-xs text-muted">{variableCount} variable {variableCount === 1 ? "bill is" : "bills are"} not included in this total.</p> : null}
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
              <p className="mt-1 text-xs text-muted">Unconfirmed suggestions. Estimates are not included in your planned total.</p>
              <ul className="mt-2 flex flex-col gap-2">
                {suggestions.slice(0, 2).map((item) => (
                  <li key={item.id} className="alfred-bills-suggestion flex items-center justify-between gap-2 text-xs">
                    <div className="min-w-0">
                      <span className="font-medium text-ink">{item.name}</span>
                      <span className="text-muted"> · next around {formatDisplayDate(item.expectedDate)}</span>
                    </div>
                    <Button
                      size="sm"
                      onClick={() => confirmSuggestion(item)}
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

      {showCategoryLink ? <Link href="/accounts?tab=needs-attention" className={buttonClassName({ variant: "ghost", className: "mt-4 w-full justify-between" })}><span>Missing a category? Categorise an incoming payment</span><span aria-hidden="true">↗</span></Link> : null}

      <Dialog
        open={open}
        onClose={close}
        title={editing ? (editing.suggestionId ? "Confirm bill" : editing.id ? "Edit bill" : "Add a bill") : "Bills & renewals"}
        dismissible={busy === null && !formBusy}
      >
        {editing ? (
          <BillForm
            key={JSON.stringify([editing.id ?? editing.suggestionId ?? "new", editing.name, editing.nextDate, editing.amount, editing.cadence, editing.currency, editing.variableEstimate, editing.lastPayment])}
            initial={editing}
            currency={editing.currency ?? currency}
            today={today}
            onAction={onAction}
            onBusyChange={setFormBusy}
            onCancel={() => setEditing(null)}
            onSaved={(bill) => {
              setSavedBill(bill);
              setEditing(null);
              setOpen(false);
              if (!onAction) router.refresh();
            }}
          />
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="min-w-0 flex-1 text-xs text-muted">{reminderNote}</p>
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
                  <li key={bill.id} className="alfred-bills-savedRow flex items-center justify-between gap-3 rounded-xl border border-line bg-bg p-3 text-sm">
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
                    <div className="alfred-bills-rowActions flex shrink-0 items-center gap-1">
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
                    <li key={item.id} className="alfred-bills-suggestion flex items-center justify-between gap-3 rounded-xl border border-line bg-bg p-3 text-xs">
                      <div className="min-w-0">
                        <p className="font-medium text-sm text-ink">{item.name}</p>
                        <p className="text-muted">
                          {item.basis} Next est. {formatDisplayDate(item.expectedDate)}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        onClick={() => confirmSuggestion(item)}
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
      <Dialog open={receiptOpen} onClose={() => setReceiptOpen(false)} title="Saved bill details">
        {savedBill ? (
          <div className="alfred-bills-savedDetails">
            <p>This is a saved bill plan, not a recorded payment.</p>
            <dl>
              <div><dt>Bill</dt><dd>{savedBill.name}</dd></div>
              <div><dt>Next payment date</dt><dd>{formatDisplayDate(savedBill.nextDate)}</dd></div>
              <div><dt>Repeats</dt><dd>{CADENCE_LABELS[savedBill.cadence]}</dd></div>
              <div><dt>Expected amount</dt><dd className="tabular-nums">{savedBill.amount === null ? "Amount varies" : formatAmount(savedBill.amount, savedBill.currency)}</dd></div>
            </dl>
            {savedBill.amount === null ? <p>Future amounts are unknown. This bill is excluded from fixed planned totals.</p> : null}
            <DialogActions><Button variant="primary" onClick={() => setReceiptOpen(false)}>Done</Button></DialogActions>
          </div>
        ) : null}
      </Dialog>
    </Card>
  );
}

export function BillForm({
  initial,
  currency,
  today,
  onCancel,
  onSaved,
  onAction,
  onBusyChange,
}: {
  initial: BillDraft;
  currency: string;
  today: string;
  onCancel: () => void;
  onSaved: (bill: SavedBillDetails) => void;
  onAction?: (action: BillAction) => Promise<unknown>;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [name, setName] = useState(initial.name ?? "");
  const [nextDate, setNextDate] = useState(initial.nextDate ?? today);
  const [cadence, setCadence] = useState<BillCadence>(initial.cadence ?? "monthly");
  const [varies, setVaries] = useState(initial.id ? initial.amount === null : false);
  const [amount, setAmount] = useState(initial.amount ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    if (busy) return;
    setBusy(true);
    onBusyChange?.(true);
    setError("");
    try {
      const action: BillAction = {
        action: "save",
        ...(initial.id ? { id: initial.id } : {}),
        name: name.trim(),
        nextDate,
        cadence,
        amount: varies ? null : amount.trim() || null,
      };
      if (onAction) await onAction(action);
      else await sendJson("/api/bills", "POST", action);
      onSaved({ name: action.name, nextDate: action.nextDate, cadence: action.cadence, amount: action.amount ? canonicalizeAmount(action.amount) : null, currency });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That bill could not be saved.");
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  }

  return (
    <form
      className="alfred-bill-form flex flex-col gap-3"
      aria-busy={busy}
      data-preview-local-form={onAction ? "true" : undefined}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Field label="Name">
        <input className={inputClass} value={name} maxLength={80} placeholder="e.g. Netflix, Home internet, Rent" onChange={(e) => setName(e.target.value)} required disabled={busy} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Next payment date">
          <TemporalInput type="date" value={nextDate} onChange={(e) => setNextDate(e.target.value)} required disabled={busy} />
        </Field>
        <Field label="Repeats">
          <Select className={inputClass} value={cadence} onChange={(e) => setCadence(e.target.value as BillCadence)} disabled={busy}>
            <option value="once">One time</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="yearly">Yearly</option>
          </Select>
        </Field>
      </div>
      {!varies ? (
        <Field label={`Expected amount (${currency})`} hint={initial.variableEstimate ? "Recent amounts varied. This is the latest payment; review it or choose “Amount varies each time”." : undefined}>
          <input className={inputClass} inputMode="decimal" value={amount} placeholder="0.00" onChange={(e) => setAmount(e.target.value)} required={!varies} disabled={busy} />
        </Field>
      ) : null}
      <label className="flex items-center gap-2 text-xs text-muted">
        <input type="checkbox" className="size-4 accent-[var(--color-accent)]" checked={varies} onChange={(e) => setVaries(e.target.checked)} disabled={busy} />
        Amount varies each time (e.g. electricity or water)
      </label>
      {varies ? (
        <div className="alfred-bill-lastPayment" aria-label="Previous payment reference">
          {initial.lastPayment?.amount ? (
            <>
              <dl>
                <div><dt>Last recorded payment</dt><dd className="tabular-nums">{formatAmount(initial.lastPayment.amount, currency)}</dd></div>
                <div><dt>Paid on</dt><dd>{initial.lastPayment.date && isRealDate(initial.lastPayment.date) ? <time dateTime={initial.lastPayment.date}>{formatDisplayDate(initial.lastPayment.date)}</time> : "Date not available"}</dd></div>
              </dl>
              <p>Reference only. Future amounts may differ; this is not a fixed planned amount.</p>
            </>
          ) : <p>No previous payment details are available for this bill. Future amounts are excluded from fixed planned totals.</p>}
        </div>
      ) : null}
      {busy ? <p className="alfred-bill-saveStatus" role="status">Saving your bill…</p> : null}
      {error ? (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      ) : null}
      <DialogActions className="mt-2">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Back
        </Button>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? <><Spinner />Saving…</> : initial.suggestionId ? "Confirm bill" : "Save bill"}
        </Button>
      </DialogActions>
    </form>
  );
}
