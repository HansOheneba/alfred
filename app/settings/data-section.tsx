"use client";

import { useState, type FormEvent } from "react";

import { Spinner } from "@/app/components/status";
import { Button, Card, ConfirmDialog, Field, inputClass, sendJson } from "@/app/components/ui";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

export function DataSection() {
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearStatus, setClearStatus] = useState<{ ok: boolean; text: string } | null>(null);

  async function clearHistory() {
    setClearing(true);
    try {
      await sendJson("/api/chat/history", "DELETE", { confirm: "clear" });
      setClearStatus({ ok: true, text: "Chat history cleared ✓" });
    } catch (error) {
      setClearStatus({ ok: false, text: error instanceof Error ? error.message : "The conversation could not be cleared." });
    } finally {
      setClearing(false);
      setConfirmClear(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card title="Your data">
        <div className="flex flex-col divide-y divide-line">
          <div className="flex flex-wrap items-center justify-between gap-3 pb-4">
            <div>
              <p className="text-sm font-medium">Download transactions</p>
              <p className="text-xs text-muted">Every active transaction as a CSV file you can open in a spreadsheet.</p>
            </div>
            <a
              href="/api/export"
              download
              className="inline-flex h-10 items-center rounded-full border border-line-strong bg-surface px-4 text-sm font-medium transition hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              Download CSV
            </a>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 pt-4">
            <div>
              <p className="text-sm font-medium">Clear chat history</p>
              <p className="text-xs text-muted">Removes the conversation on the website and Telegram. Your records stay.</p>
            </div>
            <Button variant="danger" onClick={() => setConfirmClear(true)}>
              Clear history
            </Button>
          </div>
        </div>
        {clearStatus ? (
          <p className={`mt-4 text-sm ${clearStatus.ok ? "text-success" : "text-danger"}`} role="status">
            {clearStatus.text}
          </p>
        ) : null}
        <ConfirmDialog
          open={confirmClear}
          title="Clear chat history?"
          body="This deletes every message between you and Alfred, on both the website and Telegram. Your transactions, budgets and goals are kept. This can't be undone."
          confirmLabel="Clear history"
          danger
          busy={clearing}
          onConfirm={() => void clearHistory()}
          onClose={() => (clearing ? undefined : setConfirmClear(false))}
        />
      </Card>
      <PasswordCard />
    </div>
  );
}

function PasswordCard() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSaved(false);
    if (password !== confirm) {
      setError("Those passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      const supabase = createSupabaseBrowserClient();
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) {
        setError(updateError.message);
        return;
      }
      setPassword("");
      setConfirm("");
      setSaved(true);
    } catch {
      setError("Alfred could not save that password.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Password">
      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        <p className="text-sm text-muted">Optional. You can keep signing in with an email code, or set a password for next time.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="New password" hint="At least 8 characters.">
            <input
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="Confirm password">
            <input
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              className={inputClass}
            />
          </Field>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3">
          <p className="mr-auto text-sm" role="status" aria-live="polite">
            {error ? <span className="text-danger">{error}</span> : saved ? <span className="text-success">Password saved ✓</span> : null}
          </p>
          <Button variant="primary" type="submit" disabled={busy} aria-busy={busy} aria-label="Set password">
            {busy ? <Spinner /> : "Set password"}
          </Button>
        </div>
      </form>
    </Card>
  );
}
