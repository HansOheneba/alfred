import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AppShell } from "@/app/components/app-shell";
import { InvestmentsSkeleton } from "@/app/components/page-skeletons";
import { InvestmentsClient, type InvestmentsData } from "@/app/investments/investments-client";
import { MissingAuthConfig, publicAuthConfigured, signedInAccount } from "@/app/signed-in";
import { zonedYmd } from "@/lib/finance/dates";
import { loadPortfolioDetails } from "@/lib/investments/actions";
import { createSupabaseInvestmentStore } from "@/lib/investments/store";
import { loadIncludedAccountCash } from "@/lib/web/included-account-cash";

/** Slow remote quotes must not hold this read-only page behind their full retry chain. */
const MISSING_PRICE_WAIT_MS = 2000;

export default function InvestmentsPage() {
  if (!publicAuthConfigured()) return <MissingAuthConfig />;

  return (
    <Suspense
      fallback={
        <AppShell current="investments" name="">
          <InvestmentsSkeleton />
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
    const [{ portfolio, contributions }, cash] = await Promise.all([
      loadPortfolioDetails(store, ownerId, zonedYmd(new Date(), account.profile.timezone), { fetchMissing: true, missingPriceBudgetMs: MISSING_PRICE_WAIT_MS }),
      loadIncludedAccountCash(account.settings.supabase, ownerId, account.profile.currency),
    ]);
    const names = new Map(portfolio.items.map((item) => [item.investment.id, item.investment.name]));
    data = {
      portfolio,
      cash,
      timeZone: account.profile.timezone,
      contributions: contributions
        .filter((item) => names.has(item.investmentId))
        .slice(-12)
        .reverse()
        .map((item) => ({ ...item, investment: names.get(item.investmentId)! })),
    };
  } catch (error) {
    return (
      <AppShell current="investments" ownerId={account.userId} name={name}>
        <p className="mx-auto w-full max-w-5xl px-4 py-8 text-sm text-danger" role="alert">
          {error instanceof Error ? error.message : "Alfred could not load your investments."}
        </p>
      </AppShell>
    );
  }

  return (
    <AppShell current="investments" ownerId={account.userId} name={name}>
      <InvestmentsClient initial={data} />
    </AppShell>
  );
}
