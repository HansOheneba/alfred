import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AppShell } from "@/app/components/app-shell";
import { Skeleton } from "@/app/components/status";
import { MissingAuthConfig, publicAuthConfigured, signedInAccount } from "@/app/signed-in";
import { SettingsView } from "@/app/settings/settings-view";
import { loadAccountSettings } from "@/lib/accounts/settings-store";
import { HOME_COOKIE, readHome } from "@/lib/web/home";

export default function SettingsPage() {
  if (!publicAuthConfigured()) return <MissingAuthConfig />;

  return (
    <Suspense fallback={<SettingsFallback />}>
      <SettingsContent />
    </Suspense>
  );
}

function SettingsFallback() {
  return (
    <AppShell current="settings" name="">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 sm:py-8" aria-busy="true">
        <div>
          <Skeleton className="h-8 w-36" />
          <Skeleton className="mt-2 h-4 w-72 max-w-full" />
        </div>
        <div className="flex flex-col gap-6 md:flex-row">
          <div className="flex gap-2 md:w-52 md:flex-col">
            {["profile", "replies", "budgets", "goals"].map((key) => (
              <Skeleton key={key} className="h-9 w-28 md:w-full" />
            ))}
          </div>
          <div className="min-w-0 flex-1 rounded-2xl border border-line bg-surface p-5">
            <Skeleton className="h-4 w-24" />
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <Skeleton className="h-16" />
              <Skeleton className="h-16" />
              <Skeleton className="h-16 sm:col-span-2" />
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

async function SettingsContent() {
  const account = await signedInAccount();
  if (account.kind === "signed-out") redirect("/");
  if (account.kind === "error") {
    return (
      <AppShell current="settings" name="">
        <div className="mx-auto w-full max-w-5xl px-4 py-8">
          <p className="text-sm text-danger" role="alert">
            {account.message}
          </p>
        </div>
      </AppShell>
    );
  }

  let data;
  try {
    data = await readSettingsInputs(account.settings.supabase, account.userId);
  } catch (error) {
    return (
      <AppShell current="settings" name={account.profile.preferredName.trim()}>
        <div className="mx-auto w-full max-w-5xl px-4 py-8">
          <p className="text-sm text-danger" role="alert">
            {error instanceof Error ? error.message : "Settings could not be loaded."}
          </p>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell current="settings" name={account.profile.preferredName.trim()}>
      <SettingsView key={account.userId} ownerId={account.userId} refreshKey={data.refreshKey} initial={data.settings} home={data.home} />
    </AppShell>
  );
}

/** The read stamp invalidates deferred resources after an explicit server refresh. */
async function readSettingsInputs(database: Parameters<typeof loadAccountSettings>[0], ownerId: string) {
  const [settings, cookieStore] = await Promise.all([loadAccountSettings(database, ownerId), cookies()]);
  return { settings, home: readHome(cookieStore.get(HOME_COOKIE)?.value), refreshKey: randomUUID() };
}
