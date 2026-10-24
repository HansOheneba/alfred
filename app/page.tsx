import Link from "next/link";
import { Suspense } from "react";

import { ChatPanel } from "@/app/chat/chat-panel";
import { AlfredMark, AppShell } from "@/app/components/app-shell";
import { MissingAuthConfig, publicAuthConfigured, signedInAccount } from "@/app/signed-in";
import { createSupabaseMessageLog } from "@/lib/accounts/supabase-messages";
import { toThreadMessage } from "@/lib/accounts/thread";
import { loadLedger } from "@/lib/web/ledger";

export default function Home() {
  if (!publicAuthConfigured()) return <MissingAuthConfig />;

  return (
    <Suspense fallback={<ChatLoading />}>
      <SignedInHome />
    </Suspense>
  );
}

function ChatLoading() {
  return (
    <div className="grid h-dvh place-items-center bg-bg">
      <AlfredMark size="size-10" />
    </div>
  );
}

function SignedOut() {
  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden px-6 py-16 text-center">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-80 bg-[radial-gradient(ellipse_at_top,var(--gold-soft),transparent_70%)]" aria-hidden="true" />
      <AlfredMark size="size-14" />
      <h1 className="mt-6 text-3xl font-medium tracking-tight sm:text-4xl">Alfred keeps the books.</h1>
      <p className="mt-3 max-w-md text-[15px] leading-7 text-muted">
        Tell Alfred what you spend and earn, here or on Telegram. Ask where your money is going and get an honest answer, with charts to match.
      </p>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <Link href="/login" className="inline-flex h-11 items-center rounded-full bg-gold px-6 text-sm font-medium text-gold-ink hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold">
          Sign in
        </Link>
        <Link href="/signup" className="inline-flex h-11 items-center rounded-full border border-line-strong px-6 text-sm text-ink hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold">
          Create account
        </Link>
      </div>
    </main>
  );
}

async function SignedInHome() {
  const account = await signedInAccount();
  if (account.kind === "signed-out") return <SignedOut />;
  if (account.kind === "error") {
    return (
      <AppShell current="chat" name="">
        <p className="m-6 text-sm text-danger" role="alert">
          {account.message}
        </p>
      </AppShell>
    );
  }

  const name = account.profile.preferredName.trim();
  let history;
  let ledger;
  try {
    [history, ledger] = await Promise.all([
      createSupabaseMessageLog(account.settings.supabase).listRecent(account.userId, 80),
      loadLedger(account.profile, account.settings),
    ]);
  } catch (error) {
    return (
      <AppShell current="chat" name={name}>
        <p className="m-6 text-sm text-danger" role="alert">
          {error instanceof Error ? error.message : "Alfred could not load the conversation."}
        </p>
      </AppShell>
    );
  }

  return (
    <AppShell current="chat" name={name} fill>
      <ChatPanel ownerId={account.userId} name={name} initialMessages={history.map(toThreadMessage)} ledger={ledger} />
    </AppShell>
  );
}
