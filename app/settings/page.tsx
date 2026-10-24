import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AppShell } from "@/app/components/app-shell";
import { MissingAuthConfig, publicAuthConfigured, signedInAccount } from "@/app/signed-in";
import { SettingsView } from "@/app/settings/settings-view";
import { loadAccountSettings } from "@/lib/accounts/settings-store";
import { telegramBotUsername } from "@/lib/telegram/bot-info";
import { loadLedger } from "@/lib/web/ledger";

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
      <div className="mx-auto w-full max-w-5xl px-4 py-8">
        <h1 className="text-2xl font-medium tracking-tight">Settings</h1>
        <p className="mt-2 text-sm text-muted">Loading your settings…</p>
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
    const [settings, ledger, botUsername] = await Promise.all([
      loadAccountSettings(account.settings.supabase, account.userId),
      loadLedger(account.profile, account.settings),
      telegramBotUsername(),
    ]);
    data = { settings, ledger, botUsername };
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
      <SettingsView initial={data.settings} ledger={data.ledger} botUsername={data.botUsername} />
    </AppShell>
  );
}
