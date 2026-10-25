import { Suspense } from "react";

import { AuthForm } from "@/app/auth-form";
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
  return <AuthForm mode="sign-in" />;
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
