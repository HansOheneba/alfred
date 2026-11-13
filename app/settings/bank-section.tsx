"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore, type ReactNode } from "react";

import { NeedsLabel } from "@/app/components/needs-label";
import { Spinner } from "@/app/components/status";
import { buttonClassName } from "@/app/components/button-styles";
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
          className="alfred-button--compact h-auto self-stretch"
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

export const MAC_PROVIDER_SENDERS = [
  { id: "absa", label: "Absa" }, { id: "mobilemoney", label: "MobileMoney" },
  { id: "hubtel", label: "Hubtel" }, { id: "paysmall", label: "PaySmall" },
  { id: "t-cash", label: "T-Cash" }, { id: "vf-cash", label: "VF-Cash" },
  { id: "t cash", label: "T Cash" }, { id: "stanchart", label: "StanChart" },
] as const;
export type MacProviderSender = (typeof MAC_PROVIDER_SENDERS)[number]["id"];
export const MAC_SETUP_STEPS = [
  { title: "Open Alfred Sync", body: "After installing the Mac app, open Alfred Sync from Applications. Connect your Alfred account and confirm the name and email shown there." },
  { title: "Allow Messages on this Mac", body: "Full Disk Access is a broad macOS permission. Alfred’s sender filter limits forwarding; it does not narrow that OS permission. Your Mac must already receive your iPhone SMS." },
  { title: "Start automatic sync", body: "Review your providers, then choose Start in Alfred Sync. It checks payment alerts every minute while your Mac is awake. Messages from before your first Start stay out." },
] as const;

export function MacAutomationCard({ preview = false, notificationsHref }: { preview?: boolean; notificationsHref?: string } = {}) {
  return (
    <Card title="Automatic sync">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-lg text-sm leading-6 text-muted">Payment alerts arrive through Alfred Sync on your Mac.</p>
        <span className="rounded-full bg-surface-2 px-2.5 py-1 text-xs font-medium text-muted">Managed on your Mac</span>
      </div>
      <details className="mt-3 border-t border-line pt-1">
        <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium text-accent">Manage sync</summary>
      <ol className="mt-2 flex flex-col gap-4 text-sm text-muted">
        {MAC_SETUP_STEPS.map((step, index) => <Step key={step.title} n={index + 1}><p className="font-medium text-ink">{step.title}</p><p className="mt-1 text-xs leading-5 text-muted">{step.body}</p></Step>)}
      </ol>
      <p className="mt-4 text-xs leading-5 text-muted">Choose Start or Pause in Alfred Sync. Your Mac must be awake and receiving your payment SMS.</p>
      <details className="mt-4 rounded-xl border border-line bg-bg px-3 py-1">
        <summary className="min-h-11 cursor-pointer py-3 text-xs font-medium text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">Providers, privacy and setup details</summary>
        <div className="space-y-3 pb-3 text-xs leading-5 text-muted">
          <p>These sender labels have been reviewed. Choose only the ones that match your own provider alerts:</p>
          <div className="flex flex-wrap gap-1.5" aria-label="Reviewed provider senders">{MAC_PROVIDER_SENDERS.map((provider) => <span key={provider.id} className="rounded-lg border border-line bg-surface px-2 py-1 text-ink">{provider.label}</span>)}</div>
          <p>GCB, generic MTN/Telecel and Achieve are not included until their sender scope is verified. This is not a list of every payment provider.</p>
          <p>Only selected-provider SMS received after your first Start are in scope. Pausing stops automatic sending. Starting again catches up on eligible alerts received while paused and retries saved alerts; it does not bring in messages from before your first Start.</p>
          <p>Alerts more than 24 hours old may update your records or appear in Review without a new chat announcement. Known credential-code patterns are filtered, but no filter can promise to identify every sensitive code.</p>
          <p>Forwarded alerts are stored in Alfred. Unfamiliar alerts may be processed by its AI provider, Anthropic (Claude), and recognized payments can update your records.</p>
          <p>If Telegram is already linked, Alfred’s existing payment summaries can still send payment details there, separately from the new chat and push choices. This setup does not link Telegram or change its permissions. Review that connection in <Link href={preview ? "#telegram" : "/settings#telegram"} className="font-medium text-accent underline underline-offset-4">Telegram settings</Link>.</p>
          <p>The local Mac beta targets Apple silicon Macs on macOS 27 only. Installation, Messages access and compatibility still need device validation before general distribution. This page cannot verify that it is installed, running or delivering. Your existing Money Dashboard is not changed by this setup.</p>
        </div>
      </details>
      <Link href={notificationsHref ?? (preview ? "#notification-choices" : "/settings#automations")} className="mt-3 inline-flex min-h-11 items-center text-xs font-medium text-accent underline underline-offset-4">Notification choices <span className="ml-2" aria-hidden="true">→</span></Link>
      </details>
    </Card>
  );
}

/** Settings → Bank messages: forwarding key, iPhone Shortcut guide, own account names, balances and held payments. */
export function BankSection({ bank, currency }: { bank: LedgerBank; currency: string }) {
  const router = useRouter();
  const origin = useSyncExternalStore(noSubscribe, () => window.location.origin, () => "https://alfred.designtechie.com");
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
          Send selected bank and mobile-money alerts to Alfred. He records the ones he recognises, asks about uncertain ones, and can mention new incoming alerts in chat.
        </p>

        {connected ? (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-2 rounded-full bg-success/10 px-3 py-1 text-xs font-medium text-success">
              <span className="size-1.5 rounded-full bg-success" aria-hidden="true" />
              Forwarding key ready
              {bank.lastUsedAt ? <span className="font-normal text-muted">· key used {relativeTime(bank.lastUsedAt)}</span> : <span className="font-normal text-muted">· not used yet</span>}
            </span>
            {bank.lastEmptyAt && bank.lastUsedAt && Date.parse(bank.lastEmptyAt) >= Date.parse(bank.lastUsedAt) - 10_000 ? (
              <p className="w-full text-xs leading-5 text-muted">
                Your iPhone ran the automation {relativeTime(bank.lastEmptyAt)} but sent no text. In the automation, tap <span className="font-medium text-ink">Run Shortcut</span> and set its{" "}
                <span className="font-medium text-ink">Input</span> to <span className="font-medium text-ink">Shortcut Input</span>.
              </p>
            ) : null}
          </div>
        ) : null}
        {connected ? <p className="mt-3 text-xs leading-5 text-muted">A forwarding key alone does not verify your Mac connection or a successful delivery.</p> : null}

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
            <Button variant="primary" className="alfred-button--mobileFull" onClick={() => void createKey()} disabled={busy} aria-busy={busy}>
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

      <p className="px-1 text-sm leading-6 text-muted">Automatic SMS capture and notification choices are now in <Link href="/settings#automations" className="font-medium text-accent underline underline-offset-4">Automations</Link>.</p>

      <Card title="Optional iPhone forwarding">
        <p className="mb-4 text-sm leading-6 text-muted">
          iPhone automation needs a separate review of its sender and message filters. This page does not configure those controls, and a currency word alone does not identify a bank alert.
        </p>
        <ol className="flex flex-col gap-3 text-sm text-muted">
          <Step n={1}>
            After approving iPhone forwarding, you can open{" "}
            <a href="/send-to-alfred.shortcut" className="font-medium text-accent underline underline-offset-2">
              the Send to Alfred shortcut
            </a>{" "}
            and tap <span className={em}>Add Shortcut</span>. When it asks, paste your forwarding key.
          </Step>
          <Step n={2}>
            Restrict the automation to the exact verified provider senders you choose. Do not use <span className={em}>Sender: Anyone</span>. If Shortcuts cannot select an exact provider label, leave that automation off.
          </Step>
          <Step n={3}>
            Verify that OTP, PIN, password, passcode and verification-code texts are excluded before <span className={em}>Run Shortcut</span>. Do not enable forwarding until the sender and credential filters have been checked.
          </Step>
          <Step n={4}>
            For the reviewed automation, set the <span className={em}>Send to Alfred</span> shortcut’s input to <span className={em}>Shortcut Input</span>. Only naturally arriving, approved provider alerts should be used to verify delivery in Alfred.
          </Step>
        </ol>
        <p className="mt-4 rounded-xl bg-surface-2 p-3 text-xs leading-5 text-muted">
          Alfred receives whatever a Shortcut forwards. A misconfigured automation can disclose personal texts or codes; the website cannot enforce its local sender filter. Keep it off until reviewed. You can reset or turn off the forwarding key at any time.
        </p>
      </Card>

      <Card title="Names on my accounts">
        <Field label="One name per line" hint="Money moving between these names counts as a transfer, not income or spending.">
          <textarea
            className={`${inputClass} h-auto min-h-24 py-2 leading-6`}
            value={names}
            maxLength={600}
            placeholder="Enter the name shown on your account"
            onChange={(event) => {
              setNames(event.target.value);
              setNamesState("idle");
            }}
          />
        </Field>
        <div className="alfred-buttonGroup--mobileStack mt-4 flex items-center justify-end gap-3">
          <p className="mr-auto text-sm" role="status" aria-live="polite">
            {typeof namesState === "object" ? (
              <span className="text-danger">{namesState.error}</span>
            ) : namesState === "saved" && !namesDirty ? (
              <span className="text-success">Saved ✓</span>
            ) : null}
          </p>
          <Button variant="primary" className="alfred-button--mobileFull" onClick={() => void saveNames()} disabled={namesState === "saving" || !namesDirty} aria-busy={namesState === "saving"}>
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
            <Link href="/review" className={buttonClassName({ variant: "ghost", size: "sm" })}>
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
          <li>Recognized alert templates use Alfred&apos;s own rules. Unfamiliar alerts from selected providers, including Absa, may be processed by its AI provider and may need your review.</li>
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
