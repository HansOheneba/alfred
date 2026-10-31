import { z } from "zod";

import { logError } from "@/lib/log";
import { createSupabaseNotebookStore } from "@/lib/notebook/store";
import { fail, readBody, requireOwner } from "@/lib/web/api";

const addBody = z.object({ note: z.string().trim().min(1).max(300) });
const removeBody = z.object({ id: z.string().uuid() });

/** Adds something to what Alfred knows about the person, from the Notebook page. */
export async function POST(request: Request): Promise<Response> {
  const owner = await requireOwner();
  if (owner instanceof Response) return owner;
  const body = await readBody(request, addBody);
  if (body instanceof Response) return body;
  try {
    await createSupabaseNotebookStore(owner.settings.supabase).add(owner.profile.profileId, { note: body.note });
    return Response.json({ ok: true, text: "Added to your notebook." });
  } catch (error) {
    logError("notebook_add", error);
    return fail("That note could not be saved.", 500);
  }
}

/** Forgets a note; for an ignored account, Alfred reads its texts again. */
export async function DELETE(request: Request): Promise<Response> {
  const owner = await requireOwner();
  if (owner instanceof Response) return owner;
  const body = await readBody(request, removeBody);
  if (body instanceof Response) return body;
  try {
    await createSupabaseNotebookStore(owner.settings.supabase).remove(owner.profile.profileId, body.id);
    return Response.json({ ok: true, text: "Forgotten." });
  } catch (error) {
    logError("notebook_remove", error);
    return fail("That didn't work. Try again.", 500);
  }
}
