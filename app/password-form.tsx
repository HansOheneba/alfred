"use client";

import { useState, type FormEvent } from "react";

import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

export function PasswordForm() {
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
    <form className="mt-10 flex flex-col gap-4 border-t border-neutral-200 pt-8 dark:border-neutral-800" onSubmit={onSubmit}>
      <fieldset className="flex flex-col gap-4">
        <legend className="text-sm font-medium">Password</legend>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Optional. You can keep signing in with an email code, or set a password for next time.
        </p>
        <label className="flex flex-col gap-1 text-sm">
          New password
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="rounded-xl border border-neutral-300 bg-transparent px-3 py-2 dark:border-neutral-700"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Confirm password
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            className="rounded-xl border border-neutral-300 bg-transparent px-3 py-2 dark:border-neutral-700"
          />
        </label>
      </fieldset>
      {error ? (
        <p className="text-sm text-red-700 dark:text-red-400" role="alert">
          {error}
        </p>
      ) : null}
      {saved ? <p className="text-sm text-neutral-600 dark:text-neutral-400">Password saved.</p> : null}
      <button
        type="submit"
        disabled={busy}
        className="rounded-full bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
      >
        {busy ? "Saving…" : "Set password"}
      </button>
    </form>
  );
}
