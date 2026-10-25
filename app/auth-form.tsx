"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type FormEvent, type ReactNode, type RefObject } from "react";
import { useRouter } from "next/navigation";

import { AuthScreen } from "@/app/components/auth-screen";
import { Spinner } from "@/app/components/status";
import type { OtpVerifyType } from "@/lib/auth/issue-otp";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

type AuthMode = "sign-in" | "sign-up";
type Method = "code" | "password";
type Screen = "credentials" | "verify" | "recover";

type OtpResponse = {
  ok?: boolean;
  text?: string;
  verifyType?: OtpVerifyType;
};

function isVerifyType(value: string | undefined): value is OtpVerifyType {
  return value === "magiclink" || value === "signup";
}

export function AuthForm({ mode }: { mode: AuthMode }) {
  const router = useRouter();
  const signUp = mode === "sign-up";
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [method, setMethod] = useState<Method>("code");
  const [screen, setScreen] = useState<Screen>("credentials");
  const [recovery, setRecovery] = useState(false);
  const [verifyType, setVerifyType] = useState<OtpVerifyType>("magiclink");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const seenScreen = useRef(screen);
  const fieldId = useId();

  useEffect(() => {
    if (seenScreen.current === screen) return;
    seenScreen.current = screen;
    if (screen === "verify") codeRef.current?.focus();
    else emailRef.current?.focus();
  }, [screen]);

  function clearFeedback() {
    setError("");
    setNotice("");
  }

  async function issueCode(): Promise<OtpVerifyType | null> {
    const response = await fetch("/api/auth/otp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, mode }),
    });
    const body = (await response.json()) as OtpResponse;
    if (!response.ok || !body.ok || !isVerifyType(body.verifyType)) {
      setError(body.text || "Alfred could not send that code.");
      return null;
    }
    return body.verifyType;
  }

  async function onRequestCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    clearFeedback();
    try {
      const issued = await issueCode();
      if (!issued) return;
      setVerifyType(issued);
      setCode("");
      if (screen !== "recover") setRecovery(false);
      setScreen("verify");
    } catch {
      setError("Alfred could not reach the sign-in service.");
    } finally {
      setBusy(false);
    }
  }

  async function onResend() {
    setBusy(true);
    clearFeedback();
    try {
      const issued = await issueCode();
      if (!issued) return;
      setVerifyType(issued);
      setCode("");
      setNotice("A new code is on its way.");
      codeRef.current?.focus();
    } catch {
      setError("Alfred could not reach the sign-in service.");
    } finally {
      setBusy(false);
    }
  }

  async function onVerify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    clearFeedback();
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

  async function onPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    clearFeedback();
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

  function chooseMethod(next: Method) {
    if (next === method) return;
    setMethod(next);
    setRecovery(false);
    clearFeedback();
  }

  const invalid = error ? true : undefined;

  return (
    <AuthScreen mode={mode}>
      <div key={screen} className="auth-swap">
        <ScreenHeading screen={screen} method={method} recovery={recovery} signUp={signUp} email={email} />
        {screen === "credentials" && !signUp ? <MethodSwitch method={method} disabled={busy} onChange={chooseMethod} /> : null}
        {screen === "verify" ? (
          <form className="mt-8 flex flex-col gap-5" onSubmit={onVerify} aria-busy={busy}>
            <Field label="Code" hint="From the email Alfred just sent.">
              <input
                ref={codeRef}
                id={`${fieldId}-code`}
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoCapitalize="none"
                spellCheck={false}
                required
                pattern="[0-9]{6,8}"
                title="Enter the 6 to 8 digit code from your email."
                value={code}
                aria-invalid={invalid}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 8))}
                className={`${inputClass} text-center text-lg tabular-nums tracking-[0.18em]`}
              />
            </Field>
            <Feedback error={error} notice={notice} />
            <button type="submit" disabled={busy} aria-busy={busy} aria-label={signUp ? "Create account" : "Sign in"} className={primaryButtonClass}>
              {busy ? <Spinner className="size-4" /> : signUp ? "Create account" : "Sign in"}
            </button>
            <div className="flex items-center justify-between gap-4">
              <QuietButton disabled={busy} onClick={() => void onResend()}>
                Resend code
              </QuietButton>
              <QuietButton
                disabled={busy}
                onClick={() => {
                  setCode("");
                  clearFeedback();
                  setScreen(recovery ? "recover" : "credentials");
                }}
              >
                Change email
              </QuietButton>
            </div>
          </form>
        ) : screen === "recover" ? (
          <form className="mt-8 flex flex-col gap-5" onSubmit={onRequestCode} aria-busy={busy}>
            <EmailField id={`${fieldId}-email`} email={email} invalid={invalid} inputRef={emailRef} onChange={setEmail} />
            <Feedback error={error} notice={notice} />
            <button type="submit" disabled={busy} aria-busy={busy} aria-label="Send code" className={primaryButtonClass}>
              {busy ? <Spinner className="size-4" /> : "Send code"}
            </button>
            <QuietButton
              disabled={busy}
              onClick={() => {
                setMethod("password");
                setRecovery(false);
                clearFeedback();
                setScreen("credentials");
              }}
            >
              Back to password
            </QuietButton>
          </form>
        ) : method === "password" ? (
          <form className="mt-8 flex flex-col gap-5" onSubmit={onPassword} aria-busy={busy}>
            <EmailField id={`${fieldId}-email`} email={email} invalid={invalid} inputRef={emailRef} onChange={setEmail} />
            <Field label="Password" hint="At least 8 characters.">
              <div className="relative">
                <input
                  id={`${fieldId}-password`}
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  required
                  minLength={8}
                  value={password}
                  aria-invalid={invalid}
                  onChange={(event) => setPassword(event.target.value)}
                  className={`${inputClass} pr-16`}
                />
                <button
                  type="button"
                  aria-pressed={showPassword}
                  onClick={() => setShowPassword((value) => !value)}
                  className="absolute inset-y-0 right-0 px-3 text-xs font-medium text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-gold"
                >
                  {showPassword ? "Hide" : "Show"}
                </button>
              </div>
            </Field>
            <div className="-mt-2 flex justify-end">
              <QuietButton
                disabled={busy}
                onClick={() => {
                  setRecovery(true);
                  clearFeedback();
                  setScreen("recover");
                }}
              >
                Forgot password?
              </QuietButton>
            </div>
            <Feedback error={error} notice={notice} />
            <button type="submit" disabled={busy} aria-busy={busy} aria-label="Sign in" className={primaryButtonClass}>
              {busy ? <Spinner className="size-4" /> : "Sign in"}
            </button>
          </form>
        ) : (
          <form className="mt-8 flex flex-col gap-5" onSubmit={onRequestCode} aria-busy={busy}>
            <EmailField id={`${fieldId}-email`} email={email} invalid={invalid} inputRef={emailRef} onChange={setEmail} />
            <Feedback error={error} notice={notice} />
            <button type="submit" disabled={busy} aria-busy={busy} aria-label="Send code" className={primaryButtonClass}>
              {busy ? <Spinner className="size-4" /> : "Send code"}
            </button>
          </form>
        )}
      </div>
      {signUp ? (
        <p className="mt-8 text-sm text-muted">
          Already have an account?{" "}
          <Link href="/login" className={textLinkClass}>
            Sign in
          </Link>
        </p>
      ) : null}
    </AuthScreen>
  );
}

function ScreenHeading({
  screen,
  method,
  recovery,
  signUp,
  email,
}: {
  screen: Screen;
  method: Method;
  recovery: boolean;
  signUp: boolean;
  email: string;
}) {
  if (screen === "verify") {
    return (
      <header>
        <h1 className={headingClass}>Enter your code</h1>
        <p className={supportClass}>
          We sent it to <span className="break-all text-ink">{email}</span>.
          {recovery ? " After you sign in, set a new password in Settings." : signUp ? "" : " It expires shortly."}
        </p>
      </header>
    );
  }
  if (screen === "recover") {
    return (
      <header>
        <h1 className={headingClass}>Forgot your password?</h1>
        <p className={supportClass}>We&apos;ll email you a sign-in code. Once you&apos;re in, set a new password in Settings.</p>
      </header>
    );
  }
  if (signUp) {
    return (
      <header>
        <h1 className={headingClass}>Create an account</h1>
        <p className={supportClass}>We&apos;ll email you a code. You can set a password later in Settings.</p>
      </header>
    );
  }
  if (method === "password") {
    return (
      <header>
        <h1 className={headingClass}>Sign in</h1>
        <p className={supportClass}>Use the email and password on your account.</p>
      </header>
    );
  }
  return (
    <header>
      <h1 className={headingClass}>Sign in</h1>
      <p className={supportClass}>We&apos;ll email you a code. No password needed.</p>
    </header>
  );
}

function MethodSwitch({ method, disabled, onChange }: { method: Method; disabled: boolean; onChange: (method: Method) => void }) {
  return (
    <div className="mt-6 grid grid-cols-2 gap-1 rounded-xl bg-surface-2 p-1 ring-1 ring-line" role="group" aria-label="Sign-in method">
      <MethodButton pressed={method === "code"} disabled={disabled} onClick={() => onChange("code")}>
        Email code
      </MethodButton>
      <MethodButton pressed={method === "password"} disabled={disabled} onClick={() => onChange("password")}>
        Password
      </MethodButton>
    </div>
  );
}

function MethodButton({
  pressed,
  disabled,
  onClick,
  children,
}: {
  pressed: boolean;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={`h-11 rounded-lg text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-gold disabled:opacity-50 ${
        pressed ? "bg-bg text-ink ring-1 ring-gold/70" : "text-muted hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

function EmailField({
  id,
  email,
  invalid,
  inputRef,
  onChange,
}: {
  id: string;
  email: string;
  invalid: true | undefined;
  inputRef: RefObject<HTMLInputElement | null>;
  onChange: (value: string) => void;
}) {
  return (
    <Field label="Email">
      <input
        ref={inputRef}
        id={id}
        name="email"
        type="email"
        autoComplete="email"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        required
        value={email}
        aria-invalid={invalid}
        onChange={(event) => onChange(event.target.value)}
        className={inputClass}
      />
    </Field>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-2 text-sm text-ink">
      <span>{label}</span>
      {children}
      {hint ? <span className="text-xs text-faint">{hint}</span> : null}
    </label>
  );
}

function Feedback({ error, notice }: { error: string; notice: string }) {
  return (
    <div className="min-h-5" aria-live="polite">
      {error ? (
        <p className="text-sm leading-5 text-danger" role="alert">
          {error}
        </p>
      ) : notice ? (
        <p className="text-sm leading-5 text-success" role="status">
          {notice}
        </p>
      ) : null}
    </div>
  );
}

function QuietButton({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...props} type="button" className={quietButtonClass}>
      {children}
    </button>
  );
}

const headingClass = "font-display text-[1.65rem] font-medium leading-tight tracking-tight text-ink";
const supportClass = "mt-2 text-sm leading-6 text-muted";
const inputClass =
  "h-12 w-full rounded-xl border border-line-strong bg-surface px-3.5 text-base text-ink placeholder:text-faint transition-colors hover:border-gold/40 focus:border-gold focus:outline-none focus:ring-2 focus:ring-gold-soft";
const primaryButtonClass =
  "inline-flex h-12 w-full items-center justify-center rounded-xl bg-gold text-[15px] font-medium text-gold-ink transition hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold disabled:cursor-not-allowed disabled:opacity-50";
const quietButtonClass =
  "text-sm text-muted underline decoration-line-strong underline-offset-4 transition hover:text-gold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold disabled:opacity-50";
const textLinkClass = "text-gold underline decoration-gold/40 underline-offset-4 hover:decoration-gold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold";
