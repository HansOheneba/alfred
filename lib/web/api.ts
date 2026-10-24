import type { z } from "zod";

import { createSupabaseAccountDirectory } from "@/lib/accounts/supabase-directory";
import { ensureAccount } from "@/lib/accounts/settings-store";
import type { StudioSettings, UserProfile } from "@/lib/config";
import { getStudioSettings } from "@/lib/env";
import type { FinanceStore } from "@/lib/finance/store";
import { createSupabaseFinanceStore } from "@/lib/supabase/finance-store";
import { getAuthUser } from "@/lib/supabase/session";

export type Owner = { profile: UserProfile; settings: StudioSettings; store: FinanceStore };

/** The signed-in user's profile and ledger, or a JSON error response. */
export async function requireOwner(): Promise<Owner | Response> {
  const user = await getAuthUser();
  if (!user) return fail("Sign in first.", 401);
  const settings = getStudioSettings();
  await ensureAccount(settings.supabase, user.id);
  const profile = await createSupabaseAccountDirectory(settings.supabase).loadOwner(user.id);
  if (!profile) return fail("Your profile is not ready yet.", 500);
  return { profile, settings, store: createSupabaseFinanceStore(settings.supabase) };
}

export async function readBody<T>(request: Request, schema: z.ZodType<T>): Promise<T | Response> {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return fail("That request could not be read.", 400);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Check the values and try again.", 400);
  return parsed.data;
}

export function fail(text: string, status: number): Response {
  return Response.json({ ok: false, text }, { status });
}
