import { z } from "zod";

import { loadAccountSettings, saveAccountSettings, type AccountSettings } from "@/lib/accounts/settings-store";
import { getStudioSettings } from "@/lib/env";
import { logError } from "@/lib/log";
import { getAuthUser } from "@/lib/supabase/session";

const settingsBody = z.object({
  preferredName: z.string().trim().max(80),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  timezone: z.string().trim().min(1).max(80),
  communicationPreference: z.enum(["concise", "detailed"]),
  financialGoals: z.string().max(2000),
  telegramUserId: z.string().max(20),
  telegramLocked: z.boolean(),
  morningEnabled: z.boolean(),
  commuteEnabled: z.boolean(),
  eveningEnabled: z.boolean(),
  morningTime: z.string(),
  commuteTime: z.string(),
  eveningTime: z.string(),
});

export async function POST(request: Request): Promise<Response> {
  const user = await getAuthUser();
  if (!user) return Response.json({ ok: false, text: "Sign in to change settings." }, { status: 401 });

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return Response.json({ ok: false, text: "Those settings could not be read." }, { status: 400 });
  }
  const parsed = settingsBody.safeParse(json);
  if (!parsed.success) return Response.json({ ok: false, text: "Check the currency, name, and reminder times." }, { status: 400 });
  try {
    Intl.DateTimeFormat("en-US", { timeZone: parsed.data.timezone }).format(0);
  } catch {
    return Response.json({ ok: false, text: "That timezone is not recognized." }, { status: 400 });
  }

  const next: AccountSettings = parsed.data;
  try {
    const saved = await saveAccountSettings(getStudioSettings().supabase, user.id, next);
    if (!saved.ok) return Response.json({ ok: false, text: saved.message }, { status: 400 });
    const settings = await loadAccountSettings(getStudioSettings().supabase, user.id);
    return Response.json({ ok: true, settings });
  } catch (error) {
    logError("settings_save", error);
    return Response.json({ ok: false, text: "Those settings could not be saved." }, { status: 500 });
  }
}
