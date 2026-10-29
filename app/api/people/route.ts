import { z } from "zod";

import { createSupabaseBankStore } from "@/lib/bank/store";
import { logError } from "@/lib/log";
import { createSupabasePeopleStore } from "@/lib/people/store";
import { fail, readBody, requireOwner } from "@/lib/web/api";

const saveBody = z.object({ name: z.string().trim().min(1).max(120), note: z.string().trim().min(1).max(300) });
const forgetBody = z.object({ personKey: z.string().trim().min(1).max(120), what: z.enum(["note", "filing"]) });

/** Saves what the person says about someone, from the People page. */
export async function POST(request: Request): Promise<Response> {
  const owner = await requireOwner();
  if (owner instanceof Response) return owner;
  const body = await readBody(request, saveBody);
  if (body instanceof Response) return body;
  try {
    const saved = await createSupabasePeopleStore(owner.settings.supabase).save(owner.profile.profileId, body);
    return Response.json({ ok: true, text: `Saved what you said about ${saved.name}.` });
  } catch (error) {
    logError("people_save", error);
    return fail("That note could not be saved.", 500);
  }
}

/** Forgets a note, or stops filing someone's payments automatically. */
export async function DELETE(request: Request): Promise<Response> {
  const owner = await requireOwner();
  if (owner instanceof Response) return owner;
  const body = await readBody(request, forgetBody);
  if (body instanceof Response) return body;
  try {
    if (body.what === "note") await createSupabasePeopleStore(owner.settings.supabase).remove(owner.profile.profileId, body.personKey);
    else await createSupabaseBankStore(owner.settings.supabase).deleteRule(owner.profile.profileId, body.personKey);
    return Response.json({ ok: true, text: body.what === "note" ? "Note forgotten." : "Alfred will ask about their payments again." });
  } catch (error) {
    logError("people_forget", error);
    return fail("That didn't work. Try again.", 500);
  }
}
