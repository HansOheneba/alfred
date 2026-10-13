import Link from "next/link";
import { Suspense } from "react";

import { ChatPanel } from "@/app/chat-panel";
import { toThreadMessage } from "@/lib/accounts/thread";
import { createSupabaseMessageLog } from "@/lib/accounts/supabase-messages";
import { ensureAccount } from "@/lib/accounts/settings-store";
import { getStudioSettings } from "@/lib/env";
import { getAuthUser } from "@/lib/supabase/session";

export default function Home() {
  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)
  ) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center px-6">
        <h1 className="text-2xl font-semibold tracking-tight">Alfred</h1>
        <p className="mt-3 text-sm leading-6 text-neutral-600 dark:text-neutral-400">
          The website sign-in is not configured yet. Add the public Supabase URL and anon key on the server.
        </p>
      </main>
    );
  }

  return (
    <Suspense fallback={<Shell title="Alfred" />}>
      <SignedInHome />
    </Suspense>
  );
}

function Shell({ title }: { title: string }) {
  return (
    <main className="mx-auto flex h-dvh w-full max-w-3xl flex-col">
      <header className="border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <h1 className="text-base font-semibold tracking-tight">{title}</h1>
      </header>
    </main>
  );
}

async function SignedInHome() {
  const user = await getAuthUser();
  if (!user) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center px-6">
        <h1 className="text-2xl font-semibold tracking-tight">Alfred</h1>
        <p className="mt-3 text-sm leading-6 text-neutral-600 dark:text-neutral-400">
          A personal finance assistant for the website and Telegram. Your records stay on your account.
        </p>
        <div className="mt-8 flex gap-3">
          <Link
            href="/login"
            className="rounded-full bg-neutral-900 px-4 py-2 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900"
          >
            Sign in
          </Link>
          <Link href="/signup" className="rounded-full border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700">
            Create account
          </Link>
        </div>
      </main>
    );
  }

  let initialMessages: ReturnType<typeof toThreadMessage>[] = [];
  let configError = "";
  try {
    const settings = getStudioSettings();
    await ensureAccount(settings.supabase, user.id);
    const history = await createSupabaseMessageLog(settings.supabase).listRecent(user.id, 80);
    initialMessages = history.map(toThreadMessage);
  } catch (error) {
    configError = error instanceof Error ? error.message : "Alfred could not load the conversation.";
  }

  return (
    <main className="flex h-dvh flex-col bg-black text-neutral-100">
      <header className="shrink-0 border-b border-white/10">
        <div className="mx-auto flex h-14 w-full max-w-[840px] items-center justify-between gap-4 px-4">
          <div className="flex items-center gap-3">
            <span className="grid size-8 place-items-center rounded-full border border-white/15 text-xs font-medium tracking-wide text-neutral-200" aria-hidden="true">
              A
            </span>
            <div>
              <h1 className="text-sm font-medium tracking-tight">Alfred</h1>
              <p className="text-xs text-neutral-500">Personal finance</p>
            </div>
          </div>
          <nav className="flex items-center gap-4 text-sm text-neutral-400">
            <Link href="/settings" className="rounded-sm underline-offset-4 hover:text-white hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-400">
              Settings
            </Link>
            <form action="/api/sign-out" method="post">
              <button type="submit" className="rounded-sm underline-offset-4 hover:text-white hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-400">
                Sign out
              </button>
            </form>
          </nav>
        </div>
      </header>
      {configError ? (
        <div className="mx-auto flex w-full max-w-[840px] flex-col gap-3 px-4 py-6">
          <p className="text-sm text-red-300" role="alert">
            {configError}
          </p>
          <Link href="/" className="text-sm text-neutral-300 underline-offset-4 hover:underline">
            Try again
          </Link>
        </div>
      ) : (
        <ChatPanel ownerId={user.id} initialMessages={initialMessages} />
      )}
    </main>
  );
}
