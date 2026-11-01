import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AppShell } from "@/app/components/app-shell";
import { Skeleton } from "@/app/components/status";
import { InvestmentsClient, type InvestmentsData } from "@/app/investments/investments-client";
import { MissingAuthConfig, publicAuthConfigured, signedInAccount } from "@/app/signed-in";
import { sourceName } from "@/lib/bank/parse";
import { createSupabaseBankStore } from "@/lib/bank/store";
import { zonedYmd } from "@/lib/finance/dates";
import { loadPortfolio } from "@/lib/investments/actions";
import { createSupabaseInvestmentStore } from "@/lib/investments/store";

export default function InvestmentsPage() {
  if (!publicAuthConfigured()) return <MissingAuthConfig />;

  return (
    <Suspense
      fallback={
        <AppShell current="investments" name="">
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-6 sm:px-8" aria-busy="true">
            <Skeleton className="h-36 rounded-2xl" />
            <div className="grid gap-4 md:grid-cols-2">
              {[0, 1, 2, 3].map((key) => (
                <Skeleton key={key} className="h-40 rounded-2xl" />
              ))}
            </div>
          </div>
        </AppShell>
      }
    >
      <InvestmentsScreen />
    </Suspense>
  );
}

async function InvestmentsScreen() {
  const account = await signedInAccount();
  if (account.kind === "signed-out") redirect("/");
  if (account.kind === "error") {
    return (
      <AppShell current="investments" name="">
        <p className="mx-auto w-full max-w-5xl px-4 py-8 text-sm text-danger" role="alert">
          {account.message}
        </p>
      </AppShell>
    );
  }
  const name = account.profile.preferredName.trim();
  const ownerId = account.profile.profileId;
  const store = createSupabaseInvestmentStore(account.settings.supabase);

  let data: InvestmentsData;
  try {
    const [portfolio, contributions, balances] = await Promise.all([
      loadPortfolio(store, ownerId, zonedYmd(new Date(), account.profile.timezone), { fetchMissing: true }),
      store.contributions(ownerId),
      createSupabaseBankStore(account.settings.supabase).latestBalances(ownerId),
    ]);
    const names = new Map(portfolio.items.map((item) => [item.investment.id, item.investment.name]));
    data = {
      portfolio,
      cash: balances.map((item) => ({ label: sourceName(item.source), balance: Number(item.balance), at: item.at })),
      contributions: contributions
        .filter((item) => names.has(item.investmentId))
        .slice(-12)
        .reverse()
        .map((item) => ({ ...item, investment: names.get(item.investmentId)! })),
    };
  } catch (error) {
    return (
      <AppShell current="investments" name={name}>
        <p className="mx-auto w-full max-w-5xl px-4 py-8 text-sm text-danger" role="alert">
          {error instanceof Error ? error.message : "Alfred could not load your investments."}
        </p>
      </AppShell>
    );
  }

  return (
    <AppShell current="investments" name={name}>
      <InvestmentsClient initial={data} />
    </AppShell>
  );
}
