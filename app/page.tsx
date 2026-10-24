import Link from "next/link";
import { Suspense } from "react";

import { DashboardView } from "@/app/dashboard-view";
import { AccountError, AccountShell, MissingAuthConfig, publicAuthConfigured, signedInAccount } from "@/app/signed-in";
import { buildDashboard } from "@/lib/finance/dashboard";
import { zonedYmd } from "@/lib/finance/dates";
import { createSupabaseFinanceStore } from "@/lib/supabase/finance-store";

export default function Home() {
  if (!publicAuthConfigured()) return <MissingAuthConfig />;

  return (
    <Suspense fallback={<AccountShell current="dashboard" />}>
      <SignedInHome />
    </Suspense>
  );
}

function SignedOut() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Alfred</h1>
      <p className="mt-3 text-sm leading-6 text-neutral-600 dark:text-neutral-400">
        A personal finance assistant for the website and Telegram. Your records stay on your account.
      </p>
      <div className="mt-8 flex gap-3">
        <Link
          href="/login"
          className="rounded-full bg-neutral-900 px-4 py-2 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900"
        >
          Sign in
        </Link>
        <Link href="/signup" className="rounded-full border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700">
          Create account
        </Link>
      </div>
    </main>
  );
}

async function SignedInHome() {
  const account = await signedInAccount();
  if (account.kind === "signed-out") return <SignedOut />;
  if (account.kind === "error") return <AccountError message={account.message} />;

  let snapshot;
  try {
    const store = createSupabaseFinanceStore(account.settings.supabase);
    const [transactions, budgets, goals] = await Promise.all([
      store.listTransactions(account.profile.profileId),
      store.listBudgets(account.profile.profileId),
      store.listSavingsGoals(account.profile.profileId),
    ]);
    snapshot = buildDashboard({
      userId: account.profile.profileId,
      currency: account.profile.currency,
      today: zonedYmd(new Date(), account.profile.timezone),
      transactions,
      budgets,
      goals,
    });
  } catch (error) {
    return <AccountError message={error instanceof Error ? error.message : "Alfred could not load your finances."} />;
  }

  return (
    <AccountShell current="dashboard" scroll>
      <DashboardView snapshot={snapshot} name={account.profile.preferredName.trim()} />
    </AccountShell>
  );
}
