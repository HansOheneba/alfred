import { z } from "zod";

import { splitNames } from "@/lib/bank/store";
import { logError } from "@/lib/log";
import { query } from "@/lib/supabase/connection";
import { fail, readBody, requireOwner } from "@/lib/web/api";

const namesBody = z.object({ accountNames: z.string().max(600) });

/** Saves the names on the person's own accounts, used to spot transfers between them. */
export async function POST(request: Request): Promise<Response> {
  const owner = await requireOwner();
  if (owner instanceof Response) return owner;
  const body = await readBody(request, namesBody);
  if (body instanceof Response) return body;
  const names = splitNames(body.accountNames);
  try {
    await query(owner.settings.supabase, "update public.profiles set account_names = $2, updated_at = now() where id = $1::uuid", [
      owner.profile.profileId,
      names.join("\n"),
    ]);
    return Response.json({ ok: true, accountNames: names });
  } catch (error) {
    logError("account_names", error);
    return fail("Those names could not be saved.", 500);
  }
}
