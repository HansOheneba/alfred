import Link from "next/link";
import { Suspense } from "react";

import { PasswordForm } from "@/app/password-form";
import { SettingsForm } from "@/app/settings-form";
import { loadAccountSettings } from "@/lib/accounts/settings-store";
import { getStudioSettings } from "@/lib/env";
import { getAuthUser } from "@/lib/supabase/session";

export default function SettingsPage() {
  return (
    <Suspense
      fallback={
        <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col px-6 py-8">
          <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        </main>
      }
    >
      <SettingsContent />
    </Suspense>
  );
}

async function SettingsContent() {
  const user = await getAuthUser();
  if (!user) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center px-6">
        <p className="text-sm">
          <Link href="/login" className="underline">
            Sign in
          </Link>{" "}
          to change your Alfred settings.
        </p>
      </main>
    );
  }

  let settings;
  try {
    settings = await loadAccountSettings(getStudioSettings().supabase, user.id);
  } catch (error) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center px-6">
        <p className="text-sm text-red-700 dark:text-red-400" role="alert">
          {error instanceof Error ? error.message : "Settings could not be loaded."}
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-xl flex-col px-6 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <div className="flex gap-4 text-sm">
          <Link href="/" className="underline">
            Dashboard
          </Link>
          <Link href="/chat" className="underline">
            Chat
          </Link>
        </div>
      </div>
      <SettingsForm initial={settings} />
      <PasswordForm />
    </main>
  );
}
