"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore, type ReactNode } from "react";

import { NeedsLabel } from "@/app/components/needs-label";
import { Spinner } from "@/app/components/status";
import { Button, Card, ConfirmDialog, EmptyState, Field, inputClass, sendJson } from "@/app/components/ui";
import { formatAmount } from "@/lib/finance/money";
import type { LedgerBank } from "@/lib/web/ledger";

const noSubscribe = () => () => {};

function relativeTime(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function shortDate(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <p className="mb-1 text-xs text-muted">{label}</p>
      <div className="flex items-stretch gap-2">
        <code className="min-w-0 flex-1 break-all rounded-xl border border-line-strong bg-bg px-3 py-2 font-mono text-xs leading-5 text-ink">{value}</code>
        <Button
          size="sm"
          className="h-auto self-stretch"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch {
              setCopied(false);
            }
          }}
          aria-label={`Copy ${label.toLowerCase()}`}
        >
          {copied ? "Copied ✓" : "Copy"}
        </Button>
      </div>
    </div>
  );
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent-soft text-xs font-medium text-accent">{n}</span>
      <div className="min-w-0 flex-1 leading-6">{children}</div>
    </li>
  );
}

const em = "text-ink";

/** Settings → Bank messages: forwarding key, iPhone Shortcut guide, own account names, balances and held payments. */
export function BankSection({ bank, currency }: { bank: LedgerBank; currency: string }) {
  const router = useRouter();
  const origin = useSyncExternalStore(noSubscribe, () => window.location.origin, () => "https://alfred.hansopoku.com");
  const endpoint = `${origin}/api/ingest/sms`;
  const [token, setToken] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"reset" | "off" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [names, setNames] = useState(bank.accountNames.join("\n"));
  const [namesState, setNamesState] = useState<"idle" | "saving" | "saved" | { error: string }>("idle");

  async function createKey() {
    setBusy(true);
    setError("");
    try {
      const result = await sendJson<{ token: string }>("/api/bank/token", "POST", {});
      setToken(result.token);
      setConfirm(null);
      router.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "A key could not be created.");
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    setError("");
    try {
      await sendJson("/api/bank/token", "DELETE", {});
      setToken(null);
      setConfirm(null);
      router.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Forwarding could not be turned off.");
    } finally {
      setBusy(false);
    }
  }

  async function saveNames() {
    setNamesState("saving");
    try {
      const result = await sendJson<{ accountNames: string[] }>("/api/bank/names", "POST", { accountNames: names });
      setNames(result.accountNames.join("\n"));
      setNamesState("saved");
      router.refresh();
    } catch (failure) {
      setNamesState({ error: failure instanceof Error ? failure.message : "Those names could not be saved." });
    }
  }

  const connected = bank.connected || token !== null;
  const namesDirty = names.trim() !== bank.accountNames.join("\n").trim();

  return (
    <div className="flex flex-col gap-5">
      <Card title="Bank messages">
        <p className="text-sm leading-6 text-muted">
          Your iPhone forwards MoMo and GCB texts to Alfred. He files the ones he recognises and asks you about the rest on Telegram.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          {connected ? (
            <span className="inline-flex items-center gap-2 rounded-full bg-success/10 px-3 py-1 text-xs font-medium text-success">
              <span className="size-1.5 rounded-full bg-success" aria-hidden="true" />
              Connected
              {bank.lastUsedAt ? <span className="font-normal text-muted">· last message {relativeTime(bank.lastUsedAt)}</span> : <span className="font-normal text-muted">· no messages yet</span>}
            </span>
          ) : (
            <span className="inline-flex items-center gap-2 rounded-full bg-surface-2 px-3 py-1 text-xs font-medium text-muted">
              <span className="size-1.5 rounded-full bg-faint" aria-hidden="true" />
              Not connected
            </span>
          )}
          {connected && bank.lastEmptyAt && bank.lastUsedAt && Date.parse(bank.lastEmptyAt) >= Date.parse(bank.lastUsedAt) - 10_000 ? (
            <p className="w-full text-xs leading-5 text-muted">
              Your iPhone ran the automation {relativeTime(bank.lastEmptyAt)} but sent no text. In the automation, tap <span className="font-medium text-ink">Run Shortcut</span> and set its{" "}
              <span className="font-medium text-ink">Input</span> to <span className="font-medium text-ink">Shortcut Input</span>.
            </p>
          ) : null}
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {connected ? (
            <>
              <Button onClick={() => setConfirm("reset")} disabled={busy}>
                Reset key
              </Button>
              <Button variant="ghost" onClick={() => setConfirm("off")} disabled={busy}>
                Turn off
              </Button>
            </>
          ) : (
            <Button variant="primary" onClick={() => void createKey()} disabled={busy} aria-busy={busy}>
              {busy ? <Spinner /> : null}
              Create forwarding key
            </Button>
          )}
        </div>
        {error ? (
          <p className="mt-3 text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}

        {token ? (
          <div className="mt-5 flex flex-col gap-3 rounded-2xl border border-accent/30 bg-accent-soft p-4">
            <p className="text-sm font-medium text-ink">Your forwarding key</p>
            <p className="text-xs leading-5 text-muted">Copy it into your Shortcut now. You won&apos;t see this key again; if you lose it, reset it here.</p>
            <CopyRow label="Key" value={token} />
            <CopyRow label="Endpoint URL" value={endpoint} />
          </div>
        ) : connected ? (
          <div className="mt-5">
            <CopyRow label="Endpoint URL" value={endpoint} />
          </div>
        ) : null}
      </Card>

      <Card title="Set up the iPhone Shortcut">
        <ol className="flex flex-col gap-3 text-sm text-muted">
          <Step n={1}>
            On your iPhone, open{" "}
            <a href="/send-to-alfred.shortcut" className="font-medium text-accent underline underline-offset-2">
              the Send to Alfred shortcut
            </a>{" "}
            and tap <span className={em}>Add Shortcut</span>. When it asks, paste your forwarding key.
          </Step>
          <Step n={2}>
            In <span className={em}>Shortcuts</span>, open the <span className={em}>Automation</span> tab → <span className={em}>New Automation (+)</span> →{" "}
            <span className={em}>Message</span>. Set <span className={em}>Message Contains</span> to{" "}
            <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-ink">GHS</code> and leave Sender as Anyone. Choose{" "}
            <span className={em}>Run Immediately</span>, turn off <span className={em}>Notify When Run</span>, then tap <span className={em}>Next</span>.
          </Step>
          <Step n={3}>
            Pick <span className={em}>New Blank Automation</span>, add the action <span className={em}>Run Shortcut</span> and choose{" "}
            <span className={em}>Send to Alfred</span>. Then tap ▸ on that action and set <span className={em}>Input</span> to{" "}
            <span className={em}>Shortcut Input</span>. This step matters most: without it the message never reaches Alfred.
          </Step>
          <Step n={4}>
            Tap <span className={em}>Done</span>, then repeat steps 2–3 with{" "}
            <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-ink">CEDIS</code>, for banks that write it out.
          </Step>
          <Step n={5}>Test it: wait for a MoMo or bank text, or have someone send you money. Alfred will message you on Telegram, or it&apos;ll show under &ldquo;Needs a label&rdquo; below.</Step>
        </ol>
        <p className="mt-4 rounded-xl bg-surface-2 p-3 text-xs leading-5 text-muted">
          Privacy: the Shortcut only sends texts containing GHS or CEDIS. Alfred keeps only alerts from banks, MoMo and merchants that moved your money; a friend&apos;s &ldquo;I&apos;ve sent you GHS 50&rdquo; is read and dropped, never stored. You can reset or turn off the key at any time.
        </p>
      </Card>

      <Card title="Names on my accounts">
        <Field label="One name per line" hint="Money moving between these names counts as a transfer, not income or spending.">
          <textarea
            className={`${inputClass} h-auto min-h-24 py-2 leading-6`}
            value={names}
            maxLength={600}
            placeholder="HANS OHENEBA ADUSE OPOKU"
            onChange={(event) => {
              setNames(event.target.value);
              setNamesState("idle");
            }}
          />
        </Field>
        <div className="mt-4 flex items-center justify-end gap-3">
          <p className="mr-auto text-sm" role="status" aria-live="polite">
            {typeof namesState === "object" ? (
              <span className="text-danger">{namesState.error}</span>
            ) : namesState === "saved" && !namesDirty ? (
              <span className="text-success">Saved ✓</span>
            ) : null}
          </p>
          <Button variant="primary" onClick={() => void saveNames()} disabled={namesState === "saving" || !namesDirty} aria-busy={namesState === "saving"}>
            {namesState === "saving" ? <Spinner /> : null}
            Save names
          </Button>
        </div>
      </Card>

      {bank.balances.length > 0 ? (
        <Card title="Balances">
          <ul className="grid gap-3 sm:grid-cols-2">
            {bank.balances.map((item) => (
              <li key={item.source} className="rounded-xl border border-line bg-bg p-3">
                <p className="text-xs text-muted">{item.label}</p>
                <p className="mt-1 font-display text-xl font-medium tabular-nums">{formatAmount(item.balance, currency)}</p>
                <p className="mt-1 text-xs text-faint">As of {shortDate(item.at)}</p>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-faint">From your bank&apos;s last message — not live.</p>
        </Card>
      ) : null}

      <Card
        title={`Needs a label${bank.needsLabel.length ? ` (${bank.needsLabel.length})` : ""}`}
        action={
          bank.needsLabel.length > 1 ? (
            <Link href="/review" className="text-xs text-accent underline-offset-4 hover:underline">
              Label several at once →
            </Link>
          ) : undefined
        }
      >
        {bank.needsLabel.length > 0 ? (
          <NeedsLabel items={bank.needsLabel} />
        ) : (
          <EmptyState>Nothing waiting. Alfred files payments he recognises on his own.</EmptyState>
        )}
      </Card>

      <Card title="How Alfred handles these">
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm leading-6 text-muted">
          <li>MoMo, GCB and Absa texts are read by Alfred&apos;s own rules. Any other bank&apos;s texts are read by AI, and Alfred checks every figure against the text; he asks you about the first few from a new bank.</li>
          <li>When a bank sends several texts for one payment (a debit, a transfer, a fee), it&apos;s counted once.</li>
          <li>A card payment on hold counts straight away. If the same amount leaves later, Alfred asks whether it&apos;s the same payment.</li>
          <li>Fees are logged automatically under Fees.</li>
          <li>Loan deposits are borrowed money, so they&apos;re not counted as income.</li>
          <li>Transfers between your own accounts aren&apos;t counted as income or spending.</li>
          <li>Unknown payees get a Telegram question (held from 10pm to 7am), and Alfred remembers your answer next time.</li>
          <li>If you already told Alfred about a payment, the bank message is linked to it instead of counted twice.</li>
        </ul>
      </Card>

      <ConfirmDialog
        open={confirm === "reset"}
        title="Reset your forwarding key?"
        body="Your current Shortcut will stop working until you paste the new key into it."
        confirmLabel="Reset key"
        busy={busy}
        onConfirm={() => void createKey()}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === "off"}
        title="Turn off bank messages?"
        body="Alfred will stop accepting forwarded texts. Payments already filed stay in your books."
        confirmLabel="Turn off"
        danger
        busy={busy}
        onConfirm={() => void turnOff()}
        onClose={() => setConfirm(null)}
      />
    </div>
  );
}
