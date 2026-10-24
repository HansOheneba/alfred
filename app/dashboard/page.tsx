import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AppShell } from "@/app/components/app-shell";
import { DashboardClient } from "@/app/dashboard/dashboard-client";
import { MissingAuthConfig, publicAuthConfigured, signedInAccount } from "@/app/signed-in";
import { loadLedger, type Ledger } from "@/lib/web/ledger";

export default function DashboardPage() {
  if (!publicAuthConfigured()) return <MissingAuthConfig />;

  return (
    <Suspense
      fallback={
        <AppShell current="dashboard" name="">
          <div className="mx-auto w-full max-w-6xl px-4 py-8 text-sm text-muted">Loading your dashboard…</div>
        </AppShell>
      }
    >
      <DashboardScreen />
    </Suspense>
  );
}

async function DashboardScreen() {
  const account = await signedInAccount();
  if (account.kind === "signed-out") redirect("/");
  if (account.kind === "error") {
    return (
      <AppShell current="dashboard" name="">
        <p className="mx-auto w-full max-w-6xl px-4 py-8 text-sm text-danger" role="alert">
          {account.message}
        </p>
      </AppShell>
    );
  }

  const name = account.profile.preferredName.trim();
  let ledger: Ledger;
  try {
    ledger = await loadLedger(account.profile, account.settings);
  } catch (error) {
    return (
      <AppShell current="dashboard" name={name}>
        <p className="mx-auto w-full max-w-6xl px-4 py-8 text-sm text-danger" role="alert">
          {error instanceof Error ? error.message : "Alfred could not load your finances."}
        </p>
      </AppShell>
    );
  }

  return (
    <AppShell current="dashboard" name={name}>
      <DashboardClient ledger={ledger} name={name} />
    </AppShell>
  );
}
