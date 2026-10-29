"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { Spinner } from "@/app/components/status";
import { Button, EmptyState, inputClass, sendJson } from "@/app/components/ui";
import { formatAmount } from "@/lib/finance/money";
import type { ReviewItem } from "@/lib/web/review";

// Mirrors OUT_CHOICES and IN_CHOICES in lib/bank/ingest.ts. That module uses
// node:crypto, so it can't be imported into browser code.
const OUT_CHOICES = ["Food", "Transport", "People", "Personal", "Utilities", "Social", "Subscriptions", "Misc"];
const IN_CHOICES = ["Salary", "Business", "Gift", "Refund", "Other"];

type Action = "category" | "chip_in" | "transfer" | "skip" | "lent" | "repaid" | "borrowed" | "paid_back";
type Group = { key: string; who: string; items: ReviewItem[] };

const cents = (value: string) => Math.round(Number(value) * 100);

/** Payments to the same person sit together, so one tick covers all of them. */
function groupByPayee(items: ReviewItem[]): Group[] {
  const groups = new Map<string, Group>();
  for (const item of items) {
    const key = item.payeeKey ? `${item.direction}:${item.payeeKey}` : `one:${item.id}`;
    const group = groups.get(key) ?? { key, who: item.who, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function ReviewClient({ items, timeZone }: { items: ReviewItem[]; timeZone: string }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [note, setNote] = useState("");
  const [person, setPerson] = useState("");
  const [remember, setRemember] = useState(true);
  // Money in that's someone's share of a bill is filed against the bill's category.
  const [share, setShare] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string; undo: boolean } | null>(null);

  const groups = useMemo(() => groupByPayee(items), [items]);
  const chosen = items.filter((item) => selected.has(item.id));
  const directions = new Set(chosen.map((item) => item.direction));
  const direction = directions.size === 1 ? [...directions][0] : null;
  const currency = items[0]?.currency ?? "GHS";
  const total = chosen.reduce((sum, item) => sum + cents(item.amount), 0);
  const lendable = direction === "out" && chosen.every((item) => item.payee !== "card");
  const needsPerson = direction === "out" && chosen.some((item) => item.payee === "channel");
  const repayable = direction === "in" && chosen.some((item) => item.owed);
  const borrowable = direction === "in" && chosen.every((item) => item.payee === "person");
  const payable = direction === "out" && chosen.some((item) => item.owe);
  const day = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone });

  function toggle(ids: string[], on: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  async function run(key: string, body: Record<string, unknown>) {
    setBusy(key);
    setResult(null);
    try {
      const response = await sendJson<{ text: string; sorted: number }>("/api/bank/review", "POST", body);
      setResult({ ok: true, text: response.text, undo: response.sorted > 0 });
      setSelected(new Set());
      setShare(false);
      setNote("");
      setPerson("");
      router.refresh();
    } catch (error) {
      setResult({ ok: false, text: error instanceof Error ? error.message : "That didn't work. Try again.", undo: false });
    } finally {
      setBusy(null);
    }
  }

  function label(key: string, action: Action, category?: string) {
    void run(key, {
      action,
      messageIds: chosen.map((item) => item.id),
      remember,
      ...(category ? { category } : {}),
      ...(note.trim() ? { description: note.trim() } : {}),
      ...(person.trim() ? { person: person.trim() } : {}),
    });
  }

  const chip =
    "inline-flex h-9 items-center gap-1.5 rounded-full border border-line-strong px-3.5 text-sm text-ink transition hover:border-gold/50 hover:bg-gold-soft focus-visible:outline-2 focus-visible:outline-gold disabled:opacity-50";

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6 pb-72 sm:px-6">
      <div>
        <p className="text-xs uppercase tracking-wide text-muted">
          <Link href="/dashboard" className="hover:text-ink">
            Dashboard
          </Link>{" "}
          / Review
        </p>
        <h1 className="mt-1 font-display text-2xl font-medium leading-tight tracking-tight text-ink">Needs a label</h1>
        <p className="mt-1 text-sm text-muted">
          {items.length === 0
            ? "Everything from your bank texts is sorted."
            : `${items.length} payment${items.length === 1 ? "" : "s"} from your bank texts. Tick the ones that belong together and say what they were once.`}
        </p>
      </div>

      {result ? (
        <div
          className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm ${result.ok ? "border-success/30 text-success" : "border-danger/30 text-danger"}`}
          role={result.ok ? "status" : "alert"}
        >
          <span>{result.ok ? `✓ ${result.text}` : result.text}</span>
          {result.undo ? (
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void run("undo", { action: "undo" })}>
              {busy === "undo" ? <Spinner className="size-3" /> : null}
              Undo
            </Button>
          ) : null}
        </div>
      ) : null}

      {items.length === 0 ? (
        <EmptyState>
          Nothing is waiting. New payments Alfred can&rsquo;t place on its own will show up here.{" "}
          <Link href="/dashboard" className="text-gold underline-offset-2 hover:underline">
            Back to the dashboard
          </Link>
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-3">
          {groups.map((group) => {
            const ids = group.items.map((item) => item.id);
            const all = ids.every((id) => selected.has(id));
            const some = !all && ids.some((id) => selected.has(id));
            const sum = group.items.reduce((value, item) => value + cents(item.amount), 0);
            const first = group.items[0];
            return (
              <li key={group.key} className={`rounded-2xl border bg-surface transition ${all ? "border-gold/60" : "border-line"}`}>
                <label className="flex cursor-pointer items-center gap-3 px-4 py-3">
                  <input
                    type="checkbox"
                    className="size-4 accent-[var(--color-gold)]"
                    checked={all}
                    ref={(element) => {
                      if (element) element.indeterminate = some;
                    }}
                    onChange={(event) => toggle(ids, event.target.checked)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] text-ink">
                      {first.direction === "in" ? "From " : "To "}
                      {group.who}
                    </span>
                    <span className="block text-xs text-muted">
                      {group.items.length > 1 ? `${group.items.length} payments` : day.format(new Date(first.occurredAt))}
                      {first.payee === "channel" ? " · the text doesn't say who received it" : ""}
                      {first.owed ? ` · owes you ${formatAmount(first.owed, first.currency)}` : ""}
                      {first.owe ? ` · you owe them ${formatAmount(first.owe, first.currency)}` : ""}
                      {group.items.length === 1 && first.purpose ? ` · “${first.purpose}”` : ""}
                    </span>
                  </span>
                  <span className={`shrink-0 tabular-nums text-[15px] font-medium ${first.direction === "in" ? "text-success" : "text-ink"}`}>
                    {first.direction === "in" ? "+" : ""}
                    {formatAmount((sum / 100).toFixed(2), first.currency)}
                  </span>
                </label>
                {group.items.length > 1 ? (
                  <ul className="border-t border-line px-4 py-1">
                    {group.items.map((item) => (
                      <li key={item.id}>
                        <label className="flex cursor-pointer items-center gap-3 py-2 pl-7 text-sm">
                          <input
                            type="checkbox"
                            className="size-3.5 accent-[var(--color-gold)]"
                            checked={selected.has(item.id)}
                            onChange={(event) => toggle([item.id], event.target.checked)}
                          />
                          <span className="flex-1 text-muted">
                            {day.format(new Date(item.occurredAt))}
                            {item.purpose ? ` · “${item.purpose}”` : ""}
                          </span>
                          <span className="tabular-nums text-ink">{formatAmount(item.amount, item.currency)}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {chosen.length > 0 ? (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 shadow-2xl backdrop-blur md:left-60">
          <div className="mx-auto flex max-w-3xl flex-col gap-3">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="text-ink">
                {chosen.length} selected
                {direction ? <span className="tabular-nums text-muted"> · {formatAmount((total / 100).toFixed(2), currency)}</span> : null}
              </span>
              <button type="button" className="text-xs text-muted underline-offset-4 hover:text-ink hover:underline" onClick={() => setSelected(new Set())}>
                Clear
              </button>
            </div>
            {direction ? (
              <>
                {share ? (
                  <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Which bill was it a share of?">
                    <span className="mr-1 text-xs text-muted">Their share of which bill?</span>
                    {OUT_CHOICES.map((category) => (
                      <button key={category} type="button" className={chip} disabled={busy !== null} onClick={() => label(`share:${category}`, "chip_in", category)}>
                        {busy === `share:${category}` ? <Spinner className="size-3" /> : null}
                        {category}
                      </button>
                    ))}
                    <button type="button" className="text-xs text-muted underline-offset-4 hover:text-ink hover:underline" onClick={() => setShare(false)}>
                      Back
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label="What were they?">
                    {(direction === "out" ? OUT_CHOICES : IN_CHOICES).map((category) => (
                      <button key={category} type="button" className={chip} disabled={busy !== null} onClick={() => label(category, "category", category)}>
                        {busy === category ? <Spinner className="size-3" /> : null}
                        {category}
                      </button>
                    ))}
                    {direction === "in" ? (
                      <button type="button" className={chip} disabled={busy !== null} onClick={() => setShare(true)}>
                        Their share of a bill
                      </button>
                    ) : null}
                    {lendable ? (
                      <button type="button" className={chip} disabled={busy !== null || (needsPerson && !person.trim())} onClick={() => label("lent", "lent")}>
                        {busy === "lent" ? <Spinner className="size-3" /> : null}I lent it
                      </button>
                    ) : null}
                    {repayable ? (
                      <button type="button" className={chip} disabled={busy !== null} onClick={() => label("repaid", "repaid")}>
                        {busy === "repaid" ? <Spinner className="size-3" /> : null}Paying me back
                      </button>
                    ) : null}
                    {borrowable ? (
                      <button type="button" className={chip} disabled={busy !== null} onClick={() => label("borrowed", "borrowed")}>
                        {busy === "borrowed" ? <Spinner className="size-3" /> : null}Lent to me
                      </button>
                    ) : null}
                    {payable ? (
                      <button type="button" className={chip} disabled={busy !== null} onClick={() => label("paid_back", "paid_back")}>
                        {busy === "paid_back" ? <Spinner className="size-3" /> : null}Paying them back
                      </button>
                    ) : null}
                    <button type="button" className={chip} disabled={busy !== null} onClick={() => label("transfer", "transfer")}>
                      {busy === "transfer" ? <Spinner className="size-3" /> : null}My own money
                    </button>
                    <button type="button" className={chip} disabled={busy !== null} onClick={() => label("skip", "skip")}>
                      {busy === "skip" ? <Spinner className="size-3" /> : null}Skip
                    </button>
                  </div>
                )}
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <label className="flex-1">
                    <span className="sr-only">Note</span>
                    <input className={`${inputClass} h-9`} value={note} maxLength={200} placeholder={share ? "Which bill, e.g. Fibre (optional)" : "Note, e.g. Office snacks (optional)"} onChange={(event) => setNote(event.target.value)} />
                  </label>
                  {needsPerson || share ? (
                    <label className="sm:w-48">
                      <span className="sr-only">{share ? "Whose share it is" : "Who received it"}</span>
                      <input
                        className={`${inputClass} h-9`}
                        value={person}
                        maxLength={120}
                        placeholder={share ? "Whose share, if sent for someone" : "Who, if you lent it"}
                        onChange={(event) => setPerson(event.target.value)}
                      />
                    </label>
                  ) : null}
                  <label className="flex items-center gap-2 text-xs text-muted">
                    <input type="checkbox" className="size-3.5 accent-[var(--color-gold)]" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
                    Remember these people
                  </label>
                </div>
              </>
            ) : (
              <p className="text-xs text-muted">You&rsquo;ve picked money in and money out. Pick one kind at a time to label them together.</p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
