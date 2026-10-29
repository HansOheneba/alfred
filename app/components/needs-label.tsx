"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Spinner } from "@/app/components/status";
import { inputClass, sendJson } from "@/app/components/ui";
import type { LedgerBankItem } from "@/lib/web/ledger";

// Mirrors OUT_CHOICES and IN_CHOICES in lib/bank/ingest.ts. That module uses
// node:crypto, so it can't be imported into browser code.
const OUT_CHOICES = ["Food", "Transport", "People", "Personal", "Utilities", "Social", "Subscriptions", "Misc"];
const IN_CHOICES = ["Salary", "Business", "Gift", "Refund", "Other"];

type Body = { action: "category" | "transfer" | "skip"; category?: string };

function Item({ item, compact }: { item: LedgerBankItem; compact: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [reply, setReply] = useState<{ ok: boolean; text: string } | null>(null);
  const choices = item.direction === "out" ? OUT_CHOICES : IN_CHOICES;

  async function label(key: string, body: Body) {
    setBusy(key);
    setReply(null);
    try {
      const result = await sendJson<{ text: string }>("/api/bank/label", "POST", {
        messageId: item.id,
        ...body,
        ...(body.action === "category" && note.trim() ? { description: note.trim() } : {}),
      });
      setReply({ ok: true, text: result.text });
      router.refresh();
    } catch (error) {
      setReply({ ok: false, text: error instanceof Error ? error.message : "That didn't work. Try again." });
    } finally {
      setBusy(null);
    }
  }

  if (reply?.ok) {
    return (
      <li className="rounded-xl border border-line bg-surface p-3 text-sm text-success" role="status">
        ✓ {reply.text}
      </li>
    );
  }

  const chip =
    "inline-flex h-8 items-center gap-1.5 rounded-full border border-line-strong px-3 text-xs text-ink transition hover:border-gold/50 hover:bg-gold-soft focus-visible:outline-2 focus-visible:outline-gold disabled:opacity-50";

  return (
    <li className="rounded-xl border border-line bg-surface p-3">
      <p className={`leading-6 text-ink ${compact ? "text-sm" : "text-[15px]"}`}>{item.question}</p>
      <div className="mt-2.5 flex flex-wrap gap-1.5" role="group" aria-label="What was it?">
        {choices.map((category) => (
          <button key={category} type="button" className={chip} disabled={busy !== null} onClick={() => void label(category, { action: "category", category })}>
            {busy === category ? <Spinner className="size-3" /> : null}
            {category}
          </button>
        ))}
        {item.direction === "in" ? (
          <button type="button" className={chip} disabled={busy !== null} onClick={() => void label("transfer", { action: "transfer" })}>
            {busy === "transfer" ? <Spinner className="size-3" /> : null}
            My own money
          </button>
        ) : null}
      </div>
      {noteOpen ? (
        <label className="mt-2.5 block">
          <span className="sr-only">Note for this payment</span>
          <input
            className={`${inputClass} h-9`}
            value={note}
            maxLength={200}
            placeholder="e.g. Lunch with Kofi, then pick a category"
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
      ) : null}
      <div className="mt-2 flex items-center gap-4 text-xs">
        {!noteOpen ? (
          <button type="button" className="text-muted underline-offset-4 hover:text-ink hover:underline" onClick={() => setNoteOpen(true)}>
            Add a note
          </button>
        ) : null}
        <button
          type="button"
          className="inline-flex items-center gap-1.5 text-muted underline-offset-4 hover:text-ink hover:underline disabled:opacity-50"
          disabled={busy !== null}
          onClick={() => void label("skip", { action: "skip" })}
        >
          {busy === "skip" ? <Spinner className="size-3" /> : null}
          Skip
        </button>
      </div>
      {reply && !reply.ok ? (
        <p className="mt-2 text-xs text-danger" role="alert">
          {reply.text}
        </p>
      ) : null}
    </li>
  );
}

/** Payments read from bank messages that Alfred couldn't place yet. Renders nothing when empty. */
export function NeedsLabel({ items, compact = false, limit }: { items: LedgerBankItem[]; compact?: boolean; limit?: number }) {
  if (items.length === 0) return null;
  const shown = limit ? items.slice(0, limit) : items;
  const hidden = items.length - shown.length;
  return (
    <div>
      <ul className="flex flex-col gap-2">
        {shown.map((item) => (
          <Item key={item.id} item={item} compact={compact} />
        ))}
      </ul>
      {hidden > 0 ? (
        <Link href="/review" className="mt-2 inline-block text-xs text-gold underline-offset-4 hover:underline">
          Review all {items.length} →
        </Link>
      ) : null}
    </div>
  );
}
