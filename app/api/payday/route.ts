import { z } from "zod";

import { createSupabasePaydayStore } from "@/lib/finance/payday-store";
import { logError } from "@/lib/log";
import { fail, readBody, requireOwner } from "@/lib/web/api";

/** A day of the month, or null for no regular payday. */
const body = z.strictObject({ day: z.number().int().min(1).max(31).nullable() });

/** Confirms or changes the signed-in owner's payday. Only the setting changes; the books don't. */
export async function POST(request: Request): Promise<Response> {
  const owner = await requireOwner();
  if (owner instanceof Response) return owner;
  const input = await readBody(request, body);
  if (input instanceof Response) return input;
  try {
    await createSupabasePaydayStore(owner.settings.supabase).set(owner.profile.profileId, input.day === null ? { day: null, regular: false } : { day: input.day, regular: true });
    return Response.json({ ok: true }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    logError("payday_set", error);
    return fail("Payday couldn't be saved.", 500);
  }
}
