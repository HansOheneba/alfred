import { redirect } from "next/navigation";
import { Suspense } from "react";

import { ChatPanel } from "@/app/chat/chat-panel";
import { ChatLoadingState } from "@/app/chat/chat-loading";
import { ChatDraftProvider } from "@/app/chat/chat-draft";
import { chatDraftScope } from "@/app/chat/chat-draft-scope";
import { ChatShell } from "@/app/chat/chat-shell";
import { AuthForm } from "@/app/auth-form";
import { paymentLinkId } from "@/app/chat/payment-link";
import { chatReadDeadline } from "@/app/chat/read-deadline";
import { MissingAuthConfig, publicAuthConfigured, signedInAccount } from "@/app/signed-in";

type ChatSearchParams = Promise<{ question?: string | string[]; payment?: string | string[] }>;

export default function ChatPage({ searchParams }: { searchParams: ChatSearchParams }) {
  if (!publicAuthConfigured()) return <MissingAuthConfig />;

  return (
    <ChatDraftProvider><Suspense fallback={<ChatLoading />}>
      <SignedInHome searchParams={searchParams} />
    </Suspense></ChatDraftProvider>
  );
}

function ChatLoading() {
  return (
    // Keep the app frame in the prefetched shell so a tab switch or launch shows navigation at once.
    <ChatShell name="">
      <ChatLoadingState />
    </ChatShell>
  );
}

async function SignedInHome({ searchParams }: { searchParams: ChatSearchParams }) {
  const params = await searchParams;
  const paymentId = paymentLinkId(params.payment);
  const account = await chatReadDeadline(signedInAccount(), 8000).catch(() => ({ kind: "error" as const, message: "Alfred couldn't check your sign-in. Please reload to try again." }));
  if (account.kind === "signed-out") {
    // Keep the opaque notification locator through the normal OTP/password
    // sign-in. No financial content is read before authentication.
    if (paymentId) return <AuthForm mode="sign-in" returnTo={`/chat?payment=${paymentId}`} />;
    redirect("/");
  }
  if (account.kind === "error") {
    return (
      <ChatShell name="">
        <h1 className="sr-only">Chat</h1>
        <p className="m-6 text-sm text-danger" role="alert">
          {account.message}
          <a className="mt-3 inline-flex min-h-10 items-center rounded-full border border-line px-4 text-sm text-ink" href={paymentId ? `/chat?payment=${paymentId}` : "/chat"}>Try again</a>
        </p>
      </ChatShell>
    );
  }

  const question = typeof params.question === "string" ? params.question.trim().slice(0, 2000) : "";
  const name = account.profile.preferredName.trim();
  return (
    <ChatShell key={`${account.userId}:${chatDraftScope(params.question, params.payment)}`} name={name} contextAvailable>
      <ChatPanel key={`${account.userId}:${paymentId || question || "conversation"}`} draftScope={chatDraftScope(params.question, params.payment)} initialQuestion={question} ownerId={account.userId} name={name} initialMessages={[]} initialPaymentEntry={params.payment !== undefined && !paymentId ? { state: "unavailable" } : null} initialPaymentTarget={paymentId} financialsEmpty={null} loadInitialThread />
    </ChatShell>
  );
}
