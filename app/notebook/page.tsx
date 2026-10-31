import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AppShell } from "@/app/components/app-shell";
import { Skeleton } from "@/app/components/status";
import { NotebookClient } from "@/app/notebook/notebook-client";
import { MissingAuthConfig, publicAuthConfigured, signedInAccount } from "@/app/signed-in";
import { createSupabaseNotebookStore, type AboutNote } from "@/lib/notebook/store";
import { loadPeople, type KnownPerson } from "@/lib/web/people";

export default function NotebookPage() {
  if (!publicAuthConfigured()) return <MissingAuthConfig />;

  return (
    <Suspense
      fallback={
        <AppShell current="notebook" name="">
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
      <NotebookScreen />
    </Suspense>
  );
}

async function NotebookScreen() {
  const account = await signedInAccount();
  if (account.kind === "signed-out") redirect("/");
  const name = account.kind === "error" ? "" : account.profile.preferredName.trim();
  if (account.kind === "error") {
    return (
      <AppShell current="notebook" name="">
        <p className="mx-auto w-full max-w-3xl px-4 py-8 text-sm text-danger" role="alert">
          {account.message}
        </p>
      </AppShell>
    );
  }

  let people: KnownPerson[];
  let about: AboutNote[];
  try {
    [people, about] = await Promise.all([
      loadPeople(account.profile, account.settings),
      createSupabaseNotebookStore(account.settings.supabase).list(account.profile.profileId),
    ]);
  } catch (error) {
    return (
      <AppShell current="notebook" name={name}>
        <p className="mx-auto w-full max-w-3xl px-4 py-8 text-sm text-danger" role="alert">
          {error instanceof Error ? error.message : "Alfred could not load your notebook."}
        </p>
      </AppShell>
    );
  }

  return (
    <AppShell current="notebook" name={name}>
      <NotebookClient people={people} about={about} />
    </AppShell>
  );
}
