import { Suspense } from "react";
import { redirect } from "next/navigation";
import { AppShell } from "@/app/components/app-shell";
import { MissingAuthConfig, publicAuthConfigured, signedInAccount } from "@/app/signed-in";
import { AccountsClient } from "./accounts-client";
import { AccountsErrorState, AccountsLoading } from "./accounts-status";
import { type AccountsReadView } from "@/lib/finance/accounting/read-view";
import { loadAccountsReadView } from "@/lib/finance/accounting/durable-accounts";
import { DurableDisplayUpdating } from "@/lib/finance/accounting/durable-read";
import { paymentTargetRequest } from '@/lib/notifications/payment-target';

type PageProps = { searchParams?: Promise<{ payment?: string | string[] }> };
export default function AccountsPage({ searchParams }: PageProps = {}) {
  if (!publicAuthConfigured()) return <MissingAuthConfig />;
  return <Suspense fallback={<AppShell current="accounts" name=""><AccountsLoading /></AppShell>}><AccountsScreen searchParams={searchParams} /></Suspense>;
}
async function AccountsScreen({ searchParams }: PageProps = {}) {
  // Older installed workers and already delivered notifications used Accounts.
  // Preserve their opaque locator, but continue in the authenticated Chat flow.
  const requestedPayment = paymentTargetRequest((await searchParams)?.payment);
  if (requestedPayment.id) redirect(`/chat?payment=${requestedPayment.id}`);
  const account = await signedInAccount();
  if (account.kind === "signed-out") redirect("/");
  if (account.kind === "error") return <AppShell current="accounts" name=""><AccountsErrorState message={account.message} /></AppShell>;
  let initialView: AccountsReadView | null = null;
  const paymentRequest = requestedPayment;
  let initialError = "", initialUpdating = false;
  let version = "unavailable";
  try {
    initialView = await loadAccountsReadView(account.settings.supabase, account.profile.profileId, { currency: account.profile.currency, section: "activity", page: 0 });
    // A router refresh must install its newly read state, including legacy sources
    // that have no accounting source version yet. Nothing is cached between owners.
    version = crypto.randomUUID();
  } catch (error) { if (error instanceof DurableDisplayUpdating) { initialUpdating = true; initialError = error.message; } /* Never replace a failed read with empty financial records. */ }
  return <AppShell current="accounts" ownerId={account.userId} name={account.profile.preferredName.trim()}><AccountsClient key={`${account.profile.profileId}:${version}`} defaultCurrency={account.profile.currency} initialView={initialView} initialUpdating={initialUpdating} initialError={initialView ? "" : initialError || "Your account records could not be loaded. Try again shortly."} paymentRequest={paymentRequest} expectedOwnerId={account.profile.profileId} /></AppShell>;
}
