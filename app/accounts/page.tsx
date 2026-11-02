import { Suspense } from "react";
import { redirect } from "next/navigation";
import { AppShell } from "@/app/components/app-shell";
import { MissingAuthConfig, publicAuthConfigured, signedInAccount } from "@/app/signed-in";
import { AccountsClient } from "./accounts-client";
import { AccountsErrorState, AccountsLoading } from "./accounts-status";
import { BillsCard } from "@/app/dashboard/bills-card";
import { loadLedger, type Ledger } from "@/lib/web/ledger";

export default function AccountsPage() {
  if (!publicAuthConfigured()) return <MissingAuthConfig />;
  return <Suspense fallback={<AppShell current="accounts" name=""><AccountsLoading /></AppShell>}><AccountsScreen /></Suspense>;
}
async function AccountsScreen() {
  const account = await signedInAccount();
  if (account.kind === "signed-out") redirect("/");
  if (account.kind === "error") return <AppShell current="accounts" name=""><AccountsErrorState message={account.message} /></AppShell>;
  let ledger: Ledger | null = null;
  try {
    ledger = await loadLedger(account.profile, account.settings);
  } catch { /* Accounts remain available when the existing billing records cannot load. */ }
  const subscriptions = ledger ? <BillsCard showCategoryLink bills={ledger.bills ?? []} upcoming={ledger.upcomingBills ?? []} suggestions={ledger.renewalSuggestions ?? []} currency={ledger.currency} today={ledger.today} /> : <div className="alfred-accounts-message" role="alert"><p>Alfred could not load your subscriptions.</p><a href="/accounts?tab=subscriptions" className="text-accent underline">Reload subscriptions</a></div>;
  return <AppShell current="accounts" name={account.profile.preferredName.trim()}><AccountsClient defaultCurrency={account.profile.currency} subscriptions={subscriptions} /></AppShell>;
}
