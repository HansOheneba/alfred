import { redirect } from "next/navigation";
import { Suspense } from "react";

import { ChatPanel } from "@/app/chat/chat-panel";
import type { ChatNotebookData } from "@/app/chat/notebook-panel";
import { AlfredMark, AppShell } from "@/app/components/app-shell";
import { MissingAuthConfig, publicAuthConfigured, signedInAccount } from "@/app/signed-in";
import { createSupabaseMessageLog } from "@/lib/accounts/supabase-messages";
import { toThreadMessage } from "@/lib/accounts/thread";
import { createSupabaseNotebookStore } from "@/lib/notebook/store";
import { loadLedger } from "@/lib/web/ledger";
import { loadPeople } from "@/lib/web/people";

type ChatSearchParams = Promise<{ question?: string | string[] }>;

export default function ChatPage({ searchParams }: { searchParams: ChatSearchParams }) {
  if (!publicAuthConfigured()) return <MissingAuthConfig />;

  return (
    <Suspense fallback={<ChatLoading />}>
      <SignedInHome searchParams={searchParams} />
    </Suspense>
  );
}

function ChatLoading() {
  return (
    <div className="grid h-dvh place-items-center bg-bg" role="status" aria-label="Loading conversation" aria-busy="true">
      <AlfredMark size="size-10" />
      <p className="sr-only">Loading conversation…</p>
    </div>
  );
}

async function SignedInHome({ searchParams }: { searchParams: ChatSearchParams }) {
  const account = await signedInAccount();
  if (account.kind === "signed-out") redirect("/");
  if (account.kind === "error") {
    return (
      <AppShell current="chat" name="">
        <p className="m-6 text-sm text-danger" role="alert">
          {account.message}
        </p>
      </AppShell>
    );
  }

  const params = await searchParams;
  const question = typeof params.question === "string" ? params.question.trim().slice(0, 2000) : "";
  const name = account.profile.preferredName.trim();
  let history;
  let ledger;
  let notebook: ChatNotebookData;
  try {
    [history, ledger, notebook] = await Promise.all([
      createSupabaseMessageLog(account.settings.supabase).listRecent(account.userId, 80),
      loadLedger(account.profile, account.settings),
      Promise.all([
        loadPeople(account.profile, account.settings),
        createSupabaseNotebookStore(account.settings.supabase).list(account.profile.profileId),
      ]).then(([people, about]) => ({ people, about }), () => ({ people: [], about: [], error: "Alfred could not load your notebook. Try refreshing the page." })),
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
      <ChatPanel key={question || "conversation"} initialQuestion={question} ownerId={account.userId} name={name} initialMessages={history.map(toThreadMessage)} ledger={ledger} notebook={notebook} />
    </AppShell>
  );
}
