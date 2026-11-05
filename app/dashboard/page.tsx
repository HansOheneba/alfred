import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AppShell } from "@/app/components/app-shell";
import { DashboardSkeleton } from "@/app/components/page-skeletons";
import { DashboardClient } from "@/app/dashboard/dashboard-client";
import { MissingAuthConfig, publicAuthConfigured, signedInAccount } from "@/app/signed-in";
import { loadOverview } from "@/lib/web/overview";
import { parseOverviewTransactionFilters } from "@/lib/web/activity-handoff";
import { overviewViewFromParams } from "./overview-view";

type DashboardSearchParams = Promise<Record<string, string | string[] | undefined>>;

export default function DashboardPage({ searchParams }: { searchParams?: DashboardSearchParams } = {}) {
  if (!publicAuthConfigured()) return <MissingAuthConfig />;

  return (
    <Suspense
      fallback={
        <AppShell current="dashboard" name="">
          <DashboardSkeleton />
        </AppShell>
      }
    >
      <DashboardScreen searchParams={searchParams} />
    </Suspense>
  );
}

async function DashboardScreen({ searchParams }: { searchParams?: DashboardSearchParams }) {
  const values = await searchParams ?? {};
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (typeof value === "string") params.set(key, value);
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
  let overview: Awaited<ReturnType<typeof loadOverview>>;
  try {
    const view = overviewViewFromParams(params);
    overview = await loadOverview(account.profile, account.settings, { preset: view.preset, category: view.category, filters: parseOverviewTransactionFilters(params.toString()) });
  } catch (error) {
    return (
      <AppShell current="dashboard" ownerId={account.userId} name={name}>
        <p className="alfred-ui-dashboard text-sm text-danger" role="alert">
          {error instanceof Error ? error.message : "Alfred could not load your finances."}
        </p>
      </AppShell>
    );
  }

  return (
    <AppShell current="dashboard" ownerId={account.userId} name={name}>
      <DashboardClient ledger={overview.ledger} overview={overview.summary} transactions={{ ownerId: account.profile.profileId, initialPage: overview.firstPage }} name={name} timeZone={account.profile.timezone} initialView={overviewViewFromParams(params)} initialTransactionFilters={parseOverviewTransactionFilters(params.toString())} />
    </AppShell>
  );
}
