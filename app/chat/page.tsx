import { redirect } from "next/navigation";
import { Suspense } from "react";

import { ChatPanel } from "@/app/chat-panel";
import { AccountError, AccountShell, MissingAuthConfig, publicAuthConfigured, signedInAccount } from "@/app/signed-in";
import { createSupabaseMessageLog } from "@/lib/accounts/supabase-messages";
import { toThreadMessage } from "@/lib/accounts/thread";

export default function ChatPage() {
  if (!publicAuthConfigured()) return <MissingAuthConfig />;

  return (
    <Suspense fallback={<AccountShell current="chat" />}>
      <ChatScreen />
    </Suspense>
  );
}

async function ChatScreen() {
  const account = await signedInAccount();
  if (account.kind === "signed-out") redirect("/");
  if (account.kind === "error") return <AccountError message={account.message} />;

  let history;
  try {
    history = await createSupabaseMessageLog(account.settings.supabase).listRecent(account.userId, 80);
  } catch (error) {
    return <AccountError message={error instanceof Error ? error.message : "Alfred could not load the conversation."} />;
  }

  return (
    <AccountShell current="chat">
      <ChatPanel ownerId={account.userId} initialMessages={history.map(toThreadMessage)} />
    </AccountShell>
  );
}
