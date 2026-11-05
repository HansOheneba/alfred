import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AppShell } from "@/app/components/app-shell";
import { SettingsSkeleton } from "@/app/components/page-skeletons";
import { MissingAuthConfig, publicAuthConfigured, signedInAccount } from "@/app/signed-in";
import { SettingsView } from "@/app/settings/settings-view";
import { loadAccountSettings } from "@/lib/accounts/settings-store";
import { createSupabaseTeamStore } from "@/lib/team/store";
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
      <SettingsSkeleton />
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
      <AppShell current="settings" ownerId={account.userId} name={account.profile.preferredName.trim()}>
        <div className="mx-auto w-full max-w-5xl px-4 py-8">
          <p className="text-sm text-danger" role="alert">
            {error instanceof Error ? error.message : "Settings could not be loaded."}
          </p>
        </div>
      </AppShell>
    );
  }

  // The team's projects page, for the people who build Alfred only; a check that fails just hides the link.
  const teamMember = await createSupabaseTeamStore(account.settings.supabase).isMember(account.profile.profileId).catch(() => false);
  return (
    <AppShell current="settings" ownerId={account.userId} name={account.profile.preferredName.trim()}>
      {teamMember ? (
        <div className="mx-auto w-full max-w-5xl px-4 pt-6">
          <Link href="/projects" className="flex items-center justify-between gap-3 rounded-2xl border border-line bg-surface px-4 py-3 text-sm hover:border-accent">
            <span><strong className="font-semibold">Projects</strong><span className="block text-muted">Ideas and build notes, shared between the team</span></span>
            <span aria-hidden="true" className="text-accent">→</span>
          </Link>
        </div>
      ) : null}
      <SettingsView key={account.userId} ownerId={account.userId} refreshKey={data.refreshKey} initial={data.settings} home={data.home} />
    </AppShell>
  );
}

/** The read stamp invalidates deferred resources after an explicit server refresh. */
async function readSettingsInputs(database: Parameters<typeof loadAccountSettings>[0], ownerId: string) {
  const [settings, cookieStore] = await Promise.all([loadAccountSettings(database, ownerId), cookies()]);
  return { settings, home: readHome(cookieStore.get(HOME_COOKIE)?.value), refreshKey: randomUUID() };
}
