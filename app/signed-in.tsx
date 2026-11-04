import { openOwnerProfile } from "@/lib/accounts/settings-store";
import type { StudioSettings, UserProfile } from "@/lib/config";
import { getStudioSettings } from "@/lib/env";
import { NOT_INVITED } from "@/lib/auth/invites";
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
      <h1 className="font-display text-2xl font-medium tracking-tight">Alfred</h1>
      <p className="mt-3 text-sm leading-6 text-muted">
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
    const profile = await openOwnerProfile(settings.supabase, user);
    if (profile === "not_invited") return { kind: "error", message: NOT_INVITED };
    if (!profile) return { kind: "error", message: "Your profile is not ready yet." };
    return { kind: "ready", userId: user.id, profile, settings };
  } catch (error) {
    return {
      kind: "error",
      message: error instanceof Error ? error.message : "Alfred could not load your account.",
    };
  }
}
