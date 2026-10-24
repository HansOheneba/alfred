import { z } from "zod";

import { logError } from "@/lib/log";
import { query } from "@/lib/supabase/connection";
import { fail, readBody, requireOwner } from "@/lib/web/api";

const clearBody = z.object({ confirm: z.literal("clear") });

/** Clears the conversation on both the website and Telegram. Records are untouched. */
export async function DELETE(request: Request): Promise<Response> {
  const owner = await requireOwner();
  if (owner instanceof Response) return owner;
  const body = await readBody(request, clearBody);
  if (body instanceof Response) return body;
  try {
    await query(owner.settings.supabase, "delete from public.messages where owner_id = $1::uuid", [owner.profile.profileId]);
    return Response.json({ ok: true });
  } catch (error) {
    logError("chat_clear", error);
    return fail("The conversation could not be cleared.", 500);
  }
}
