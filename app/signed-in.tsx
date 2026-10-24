import Link from "next/link";
import type { ReactNode } from "react";

import { ensureAccount } from "@/lib/accounts/settings-store";
import { createSupabaseAccountDirectory } from "@/lib/accounts/supabase-directory";
import type { StudioSettings, UserProfile } from "@/lib/config";
import { getStudioSettings } from "@/lib/env";
import { getAuthUser } from "@/lib/supabase/session";

export function publicAuthConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY),
  );
}

export function MissingAuthConfig() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Alfred</h1>
      <p className="mt-3 text-sm leading-6 text-neutral-600 dark:text-neutral-400">
        The website sign-in is not configured yet. Add the public Supabase URL and anon key on the server.
      </p>
    </main>
  );
}

export type SignedInAccount =
  | { kind: "signed-out" }
  | { kind: "error"; message: string }
  | { kind: "ready"; userId: string; profile: UserProfile; settings: StudioSettings };

export async function signedInAccount(): Promise<SignedInAccount> {
  const user = await getAuthUser();
  if (!user) return { kind: "signed-out" };
  try {
    const settings = getStudioSettings();
    await ensureAccount(settings.supabase, user.id);
    const profile = await createSupabaseAccountDirectory(settings.supabase).loadOwner(user.id);
    if (!profile) return { kind: "error", message: "Your profile is not ready yet." };
    return { kind: "ready", userId: user.id, profile, settings };
  } catch (error) {
    return {
      kind: "error",
      message: error instanceof Error ? error.message : "Alfred could not load your account.",
    };
  }
}

const linkClass =
  "rounded-sm underline-offset-4 hover:text-white hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-400";

export function AccountShell({
  current,
  children,
  scroll = false,
}: {
  current: "dashboard" | "chat";
  children?: ReactNode;
  scroll?: boolean;
}) {
  return (
    <main className={scroll ? "min-h-dvh bg-black text-neutral-100" : "flex h-dvh flex-col bg-black text-neutral-100"}>
      <header className="shrink-0 border-b border-white/10">
        <div className="mx-auto flex min-h-14 w-full max-w-5xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2">
          <div className="flex items-center gap-5">
            <Link href="/" className="flex items-center gap-3 rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-400">
              <span className="grid size-8 place-items-center rounded-full border border-white/15 text-xs font-medium tracking-wide text-neutral-200" aria-hidden="true">
                A
              </span>
              <span className="text-sm font-medium tracking-tight">Alfred</span>
            </Link>
            <nav className="flex items-center gap-4 text-sm" aria-label="Account">
              <Link href="/" className={current === "dashboard" ? "text-white" : `text-neutral-400 ${linkClass}`} aria-current={current === "dashboard" ? "page" : undefined}>
                Dashboard
              </Link>
              <Link href="/chat" className={current === "chat" ? "text-white" : `text-neutral-400 ${linkClass}`} aria-current={current === "chat" ? "page" : undefined}>
                Chat
              </Link>
            </nav>
          </div>
          <nav className="flex items-center gap-4 text-sm text-neutral-400">
            <Link href="/settings" className={linkClass}>
              Settings
            </Link>
            <form action="/api/sign-out" method="post">
              <button type="submit" className={linkClass}>
                Sign out
              </button>
            </form>
          </nav>
        </div>
      </header>
      {children}
    </main>
  );
}

export function AccountError({ message }: { message: string }) {
  return (
    <AccountShell current="dashboard" scroll>
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-3 px-4 py-6">
        <p className="text-sm text-red-300" role="alert">
          {message}
        </p>
        <Link href="/" className="text-sm text-neutral-300 underline-offset-4 hover:underline">
          Try again
        </Link>
      </div>
    </AccountShell>
  );
}
