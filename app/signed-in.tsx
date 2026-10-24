import { ensureAccount } from "@/lib/accounts/settings-store";
import { createSupabaseAccountDirectory } from "@/lib/accounts/supabase-directory";
import type { StudioSettings, UserProfile } from "@/lib/config";
import { getStudioSettings } from "@/lib/env";
import { getAuthUser } from "@/lib/supabase/session";

export function publicAuthConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY),
  );
}

export function MissingAuthConfig() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Alfred</h1>
      <p className="mt-3 text-sm leading-6 text-neutral-600 dark:text-neutral-400">
        The website sign-in is not configured yet. Add the public Supabase URL and anon key on the server.
      </p>
    </main>
  );
}

export type SignedInAccount =
  | { kind: "signed-out" }
  | { kind: "error"; message: string }
  | { kind: "ready"; userId: string; profile: UserProfile; settings: StudioSettings };

export async function signedInAccount(): Promise<SignedInAccount> {
  const user = await getAuthUser();
  if (!user) return { kind: "signed-out" };
  try {
    const settings = getStudioSettings();
    await ensureAccount(settings.supabase, user.id);
    const profile = await createSupabaseAccountDirectory(settings.supabase).loadOwner(user.id);
    if (!profile) return { kind: "error", message: "Your profile is not ready yet." };
    return { kind: "ready", userId: user.id, profile, settings };
  } catch (error) {
    return {
      kind: "error",
      message: error instanceof Error ? error.message : "Alfred could not load your account.",
    };
  }
}
