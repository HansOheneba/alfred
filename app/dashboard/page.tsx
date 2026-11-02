import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AppShell } from "@/app/components/app-shell";
import { Skeleton } from "@/app/components/status";
import { DashboardClient } from "@/app/dashboard/dashboard-client";
import { MissingAuthConfig, publicAuthConfigured, signedInAccount } from "@/app/signed-in";
import { loadLedger, type Ledger } from "@/lib/web/ledger";

export default function DashboardPage() {
  if (!publicAuthConfigured()) return <MissingAuthConfig />;

  return (
    <Suspense
      fallback={
        <AppShell current="dashboard" name="">
          <DashboardSkeleton />
        </AppShell>
      }
    >
      <DashboardScreen />
    </Suspense>
  );
}

function DashboardSkeleton() {
  return (
    <div className="alfred-ui-dashboard" aria-busy="true" aria-label="Loading your financial overview">
      <div className="alfred-ui-heading">
        <div><Skeleton className="h-4 w-24" /><Skeleton className="mt-2 h-8 w-48" /></div>
        <Skeleton className="h-12 w-64 rounded-xl" />
      </div>
      <div className="alfred-ui-overviewGrid">
        <div className="alfred-ui-totalBalance"><Skeleton className="h-4 w-40" /><Skeleton className="mt-4 h-12 w-52" /><Skeleton className="mt-4 h-4 w-32" /><Skeleton className="mt-6 h-20 w-full" /></div>
        <div className="alfred-ui-summary">
          {["spent", "income"].map((key) => <div key={key} className="alfred-ui-metric"><Skeleton className="h-4 w-16" /><Skeleton className="mt-4 h-8 w-28" /><Skeleton className="mt-2 h-4 w-32" /></div>)}
          <Skeleton className="col-span-full h-24 rounded-xl" />
        </div>
      </div>
      <div className="alfred-ui-insightsAndTrends">{["insights", "monthly", "daily"].map((key) => <Skeleton key={key} className="h-72 rounded-2xl" />)}</div>
      <Skeleton className="h-72 rounded-2xl" />
    </div>
  );
}

async function DashboardScreen() {
  const account = await signedInAccount();
  if (account.kind === "signed-out") redirect("/");
  if (account.kind === "error") {
    return (
      <AppShell current="dashboard" name="">
        <p className="alfred-ui-dashboard text-sm text-danger" role="alert">
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
        <p className="alfred-ui-dashboard text-sm text-danger" role="alert">
          {error instanceof Error ? error.message : "Alfred could not load your finances."}
        </p>
      </AppShell>
    );
  }

  return (
    <AppShell current="dashboard" name={name}>
      <DashboardClient ledger={ledger} name={name} timeZone={account.profile.timezone} />
    </AppShell>
  );
}
