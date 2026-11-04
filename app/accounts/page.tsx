import { Suspense } from "react";
import { redirect } from "next/navigation";
import { AppShell } from "@/app/components/app-shell";
import { MissingAuthConfig, publicAuthConfigured, signedInAccount } from "@/app/signed-in";
import { AccountsClient, type AccountsPayload } from "./accounts-client";
import { AccountsErrorState, AccountsLoading } from "./accounts-status";
import { browserAccountingState } from "@/lib/finance/accounting/browser-state";
import { loadAccountingState } from "@/lib/finance/accounting/persisted-store";
import { ownedPaymentMovement, paymentTargetRequest } from '@/lib/notifications/payment-target';

type PageProps = { searchParams?: Promise<{ payment?: string | string[] }> };
export default function AccountsPage({ searchParams }: PageProps = {}) {
  if (!publicAuthConfigured()) return <MissingAuthConfig />;
  return <Suspense fallback={<AppShell current="accounts" name=""><AccountsLoading /></AppShell>}><AccountsScreen searchParams={searchParams} /></Suspense>;
}
async function AccountsScreen({ searchParams }: PageProps = {}) {
  const account = await signedInAccount();
  if (account.kind === "signed-out") redirect("/");
  if (account.kind === "error") return <AppShell current="accounts" name=""><AccountsErrorState message={account.message} /></AppShell>;
  let initialPayload: AccountsPayload | null = null;
  let paymentRequest = paymentTargetRequest((await searchParams)?.payment);
  let version = "unavailable";
  try {
    const result = await loadAccountingState(account.settings.supabase, account.profile.profileId);
    initialPayload = { ok: true, state: browserAccountingState(result.state), availability: result.availability };
    if (paymentRequest.requested && !ownedPaymentMovement(result.state, account.profile.profileId, paymentRequest.id)) {
      paymentRequest = { requested: true, id: null };
    }
    // A router refresh must install its newly read state, including legacy sources
    // that have no accounting source version yet. Nothing is cached between owners.
    version = crypto.randomUUID();
  } catch { /* A failed read is an error, never an empty financial state. */ }
  return <AppShell current="accounts" name={account.profile.preferredName.trim()}><AccountsClient key={`${account.profile.profileId}:${version}`} defaultCurrency={account.profile.currency} initialPayload={initialPayload} initialError={initialPayload ? "" : "Your account records could not be loaded. Try again shortly."} paymentRequest={paymentRequest} expectedOwnerId={account.profile.profileId} /></AppShell>;
}
