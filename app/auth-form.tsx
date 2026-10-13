"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

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
      <h1 className="text-2xl font-semibold tracking-tight">{signUp ? "Create your Alfred account" : "Sign in"}</h1>
      <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
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
              className="rounded-xl border border-neutral-300 bg-transparent px-3 py-2 tracking-widest dark:border-neutral-700"
            />
          </label>
          <Status error={error} />
          <button type="submit" disabled={busy} className={buttonClass}>
            {busy ? "Please wait…" : "Continue"}
          </button>
          <button
            type="button"
            className="text-sm text-neutral-600 underline dark:text-neutral-400"
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
            className="text-sm text-neutral-600 underline dark:text-neutral-400"
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
              className="text-sm text-neutral-600 underline dark:text-neutral-400"
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
      <p className="mt-6 text-sm text-neutral-600 dark:text-neutral-400">
        {signUp ? (
          <Link href="/login" className="underline">
            Already have an account? Sign in
          </Link>
        ) : (
          <Link href="/signup" className="underline">
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
    <p className="text-sm text-red-700 dark:text-red-400" role="alert">
      {error}
    </p>
  );
}

const inputClass = "rounded-xl border border-neutral-300 bg-transparent px-3 py-2 dark:border-neutral-700";
const buttonClass =
  "rounded-full bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900";
