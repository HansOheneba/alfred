"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { AlfredMark } from "@/app/components/app-shell";
import type { OtpVerifyType } from "@/lib/auth/issue-otp";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

export function AuthForm({ mode }: { mode: "sign-in" | "sign-up" }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [usePassword, setUsePassword] = useState(false);
  const [sent, setSent] = useState(false);
  const [verifyType, setVerifyType] = useState<OtpVerifyType>("magiclink");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const signUp = mode === "sign-up";

  async function sendCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/otp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, mode }),
      });
      const body = (await response.json()) as { ok?: boolean; text?: string; verifyType?: OtpVerifyType };
      if (!response.ok || !body.ok || (body.verifyType !== "magiclink" && body.verifyType !== "signup")) {
        setError(body.text || "Alfred could not send that code.");
        return;
      }
      setVerifyType(body.verifyType);
      setSent(true);
    } catch {
      setError("Alfred could not reach the sign-in service.");
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const supabase = createSupabaseBrowserClient();
      const { error: verifyError } = await supabase.auth.verifyOtp({
        email,
        token: code.trim(),
        type: verifyType,
      });
      if (verifyError) {
        setError(verifyError.message);
        return;
      }
      router.push("/");
      router.refresh();
    } catch {
      setError("Alfred could not reach the sign-in service.");
    } finally {
      setBusy(false);
    }
  }

  async function signInWithPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const supabase = createSupabaseBrowserClient();
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
      if (signInError) {
        setError(signInError.message);
        return;
      }
      router.push("/");
      router.refresh();
    } catch {
      setError("Alfred could not reach the sign-in service.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-6 py-16">
      <Link href="/" className="mb-8 self-start rounded-full focus-visible:outline-2 focus-visible:outline-gold" aria-label="Alfred home">
        <AlfredMark size="size-11" />
      </Link>
      <h1 className="text-2xl font-medium tracking-tight">{signUp ? "Create your Alfred account" : "Sign in"}</h1>
      <p className="mt-2 text-sm text-muted">
        {sent
          ? `Enter the code sent to ${email}.`
          : signUp
            ? "We'll email you a code. You can set a password later in Settings."
            : "We'll email you a code. No password is required."}
      </p>
      {sent ? (
        <form className="mt-8 flex flex-col gap-4" onSubmit={verifyCode}>
          <label className="flex flex-col gap-1 text-sm">
            Email code
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              pattern="[0-9]{6,8}"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              className={`${inputClass} tracking-widest`}
            />
          </label>
          <Status error={error} />
          <button type="submit" disabled={busy} className={buttonClass}>
            {busy ? "Please wait…" : "Continue"}
          </button>
          <button
            type="button"
            className="text-sm text-muted underline underline-offset-4 hover:text-ink"
            onClick={() => {
              setSent(false);
              setCode("");
              setError("");
            }}
          >
            Use a different email
          </button>
        </form>
      ) : usePassword ? (
        <form className="mt-8 flex flex-col gap-4" onSubmit={signInWithPassword}>
          <EmailField email={email} onChange={setEmail} />
          <label className="flex flex-col gap-1 text-sm">
            Password
            <input
              type="password"
              autoComplete="current-password"
              required
              minLength={8}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className={inputClass}
            />
          </label>
          <Status error={error} />
          <button type="submit" disabled={busy} className={buttonClass}>
            {busy ? "Please wait…" : "Sign in"}
          </button>
          <button
            type="button"
            className="text-sm text-muted underline underline-offset-4 hover:text-ink"
            onClick={() => {
              setUsePassword(false);
              setError("");
            }}
          >
            Email me a code instead
          </button>
        </form>
      ) : (
        <form className="mt-8 flex flex-col gap-4" onSubmit={sendCode}>
          <EmailField email={email} onChange={setEmail} />
          <Status error={error} />
          <button type="submit" disabled={busy} className={buttonClass}>
            {busy ? "Please wait…" : "Email me a code"}
          </button>
          {signUp ? null : (
            <button
              type="button"
              className="text-sm text-muted underline underline-offset-4 hover:text-ink"
              onClick={() => {
                setUsePassword(true);
                setError("");
              }}
            >
              Sign in with a password
            </button>
          )}
        </form>
      )}
      <p className="mt-6 text-sm text-muted">
        {signUp ? (
          <Link href="/login" className="text-gold underline underline-offset-4">
            Already have an account? Sign in
          </Link>
        ) : (
          <Link href="/signup" className="text-gold underline underline-offset-4">
            Create an account
          </Link>
        )}
      </p>
    </main>
  );
}

function EmailField({ email, onChange }: { email: string; onChange: (value: string) => void }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      Email
      <input
        type="email"
        autoComplete="email"
        required
        value={email}
        onChange={(event) => onChange(event.target.value)}
        className={inputClass}
      />
    </label>
  );
}

function Status({ error }: { error: string }) {
  if (!error) return null;
  return (
    <p className="text-sm text-danger" role="alert">
      {error}
    </p>
  );
}

const inputClass =
  "h-11 rounded-xl border border-line-strong bg-bg px-3 text-ink placeholder:text-faint focus:border-gold focus:outline-none focus:ring-2 focus:ring-gold-soft";
const buttonClass =
  "h-11 rounded-full bg-gold px-4 text-sm font-medium text-gold-ink hover:brightness-110 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold";
