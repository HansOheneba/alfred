import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AppShell } from "@/app/components/app-shell";
import { Skeleton } from "@/app/components/status";
import { ReviewClient } from "@/app/review/review-client";
import { MissingAuthConfig, publicAuthConfigured, signedInAccount } from "@/app/signed-in";
import { loadReview, type ReviewItem } from "@/lib/web/review";

export default function ReviewPage() {
  if (!publicAuthConfigured()) return <MissingAuthConfig />;

  return (
    <Suspense
      fallback={
        <AppShell current="dashboard" name="">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 py-6 sm:px-6" aria-busy="true">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-4 w-72 max-w-full" />
            {[0, 1, 2, 3].map((key) => (
              <Skeleton key={key} className="h-20 rounded-2xl" />
            ))}
          </div>
        </AppShell>
      }
    >
      <ReviewScreen />
    </Suspense>
  );
}

async function ReviewScreen() {
  const account = await signedInAccount();
  if (account.kind === "signed-out") redirect("/");
  const name = account.kind === "error" ? "" : account.profile.preferredName.trim();
  if (account.kind === "error") {
    return (
      <AppShell current="dashboard" name="">
        <p className="mx-auto w-full max-w-3xl px-4 py-8 text-sm text-danger" role="alert">
          {account.message}
        </p>
      </AppShell>
    );
  }

  let items: ReviewItem[];
  try {
    items = await loadReview(account.profile, account.settings);
  } catch (error) {
    return (
      <AppShell current="dashboard" name={name}>
        <p className="mx-auto w-full max-w-3xl px-4 py-8 text-sm text-danger" role="alert">
          {error instanceof Error ? error.message : "Alfred could not load your payments."}
        </p>
      </AppShell>
    );
  }

  return (
    <AppShell current="dashboard" name={name}>
      <ReviewClient items={items} timeZone={account.profile.timezone} />
    </AppShell>
  );
}
