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
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 pt-6 pb-[calc(2.5rem+env(safe-area-inset-bottom))] sm:px-6" aria-busy="true">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Skeleton className="h-3 w-24" />
          <Skeleton className="mt-2 h-8 w-48" />
        </div>
        <Skeleton className="h-9 w-56 rounded-full" />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {["spent", "income", "kept", "daily"].map((key) => (
          <div key={key} className="rounded-2xl border border-line bg-surface p-4">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="mt-3 h-7 w-24" />
            <Skeleton className="mt-2 h-3 w-20" />
          </div>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-64 rounded-2xl" />
        <Skeleton className="h-64 rounded-2xl" />
      </div>
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
