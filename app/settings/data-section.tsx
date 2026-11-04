"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { buttonClassName } from "@/app/components/button-styles";
import { Spinner } from "@/app/components/status";
import { Button, Card, ConfirmDialog, inputClass, sendJson } from "@/app/components/ui";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { PortabilitySection } from "@/app/settings/portability-section";
import "./password-card.css";

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
      <PortabilitySection />
      <Card title="More options">
        <div className="flex flex-col divide-y divide-line">
          <div className="flex flex-wrap items-center justify-between gap-3 pb-4">
            <div>
              <p className="text-sm font-medium">Download a spreadsheet</p>
              <p className="text-xs text-muted">Your current transactions in a spreadsheet.</p>
            </div>
            <a
              href="/api/export"
              download
              className={buttonClassName()}
            >
              Download spreadsheet
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
  const fieldId = useId();
  const manageButton = useRef<HTMLButtonElement>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [showPasswords, setShowPasswords] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (editing) passwordInput.current?.focus();
  }, [editing]);

  function closeEditor() {
    setPassword("");
    setConfirm("");
    setShowPasswords(false);
    setEditing(false);
    requestAnimationFrame(() => manageButton.current?.focus());
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
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
      closeEditor();
      setSaved(true);
    } catch {
      setError("Alfred could not save that password.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Password" className="alfred-password-card">
      {editing ? (
        <form id={`${fieldId}-editor`} className="alfred-password-form" onSubmit={onSubmit} aria-busy={busy} aria-label="Manage password">
          <div className="alfred-password-formHeading">
            <p id={`${fieldId}-hint`}>Choose a password with at least 8 characters. You can still sign in with an email code.</p>
            <button
              type="button"
              className={buttonClassName({ variant: "ghost", size: "sm", className: "alfred-button--compact alfred-password-reveal" })}
              aria-pressed={showPasswords}
              aria-controls={`${fieldId}-password ${fieldId}-confirm`}
              onClick={() => setShowPasswords((value) => !value)}
              disabled={busy}
            >
              {showPasswords ? "Hide passwords" : "Show passwords"}
            </button>
          </div>
          <div className="alfred-password-fields">
            <label className="alfred-password-field" htmlFor={`${fieldId}-password`}>
              <span>New password</span>
              <input
                ref={passwordInput}
                id={`${fieldId}-password`}
                name="new-password"
                type={showPasswords ? "text" : "password"}
                autoComplete="new-password"
                required
                minLength={8}
                value={password}
                disabled={busy}
                aria-describedby={`${fieldId}-hint${error ? ` ${fieldId}-feedback` : ""}`}
                aria-invalid={Boolean(error)}
                onChange={(event) => { setPassword(event.target.value); setError(""); }}
                className={`${inputClass} alfred-password-input`}
              />
            </label>
            <label className="alfred-password-field" htmlFor={`${fieldId}-confirm`}>
              <span>Confirm new password</span>
              <input
                id={`${fieldId}-confirm`}
                name="confirm-password"
                type={showPasswords ? "text" : "password"}
                autoComplete="new-password"
                required
                minLength={8}
                value={confirm}
                disabled={busy}
                aria-describedby={error ? `${fieldId}-feedback` : undefined}
                aria-invalid={Boolean(error)}
                onChange={(event) => { setConfirm(event.target.value); setError(""); }}
                className={`${inputClass} alfred-password-input`}
              />
            </label>
          </div>
          <div className="alfred-password-actions">
            <Button variant="ghost" onClick={() => { setError(""); closeEditor(); }} disabled={busy}>Cancel</Button>
            <Button variant="primary" type="submit" disabled={busy || !password || !confirm} aria-busy={busy} aria-label="Save password">
              {busy ? <><Spinner /> Saving…</> : "Save password"}
            </Button>
          </div>
        </form>
      ) : (
        <div className="alfred-password-summary">
          <span className="alfred-password-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/></svg></span>
          <div className="alfred-password-summaryCopy">
            <p>Sign in with a password</p>
            <p>Create or update your password. Email codes stay available.</p>
          </div>
          <button
            type="button"
            className={buttonClassName({ className: "alfred-password-manage" })}
            ref={manageButton}
            onClick={() => { setError(""); setSaved(false); setEditing(true); }}
          >
            Manage password
          </button>
        </div>
      )}
      <p id={`${fieldId}-feedback`} className="alfred-password-feedback" role="status" aria-live="polite">
        {error ? <span className="text-danger">{error}</span> : saved ? <span className="text-success">Password saved.</span> : null}
      </p>
    </Card>
  );
}
