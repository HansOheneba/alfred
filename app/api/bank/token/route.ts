import { newIngestToken } from "@/lib/bank/store";
import { logError } from "@/lib/log";
import { query } from "@/lib/supabase/connection";
import { fail, requireOwner } from "@/lib/web/api";

/** Creates (or replaces) the person's forwarding key. The key is shown once and only its hash is kept. */
export async function POST(): Promise<Response> {
  const owner = await requireOwner();
  if (owner instanceof Response) return owner;
  try {
    const { token, hash } = newIngestToken();
    await query(
      owner.settings.supabase,
      `insert into public.ingest_tokens (owner_id, token_hash) values ($1::uuid, $2)
       on conflict (owner_id) do update set token_hash = excluded.token_hash, created_at = now(), last_used_at = null`,
      [owner.profile.profileId, hash],
    );
    return Response.json({ ok: true, token });
  } catch (error) {
    logError("ingest_token", error);
    return fail("A forwarding key could not be created.", 500);
  }
}

/** Turns off message forwarding until a new key is created. */
export async function DELETE(): Promise<Response> {
  const owner = await requireOwner();
  if (owner instanceof Response) return owner;
  try {
    await query(owner.settings.supabase, "delete from public.ingest_tokens where owner_id = $1::uuid", [owner.profile.profileId]);
    return Response.json({ ok: true });
  } catch (error) {
    logError("ingest_token_delete", error);
    return fail("Forwarding could not be turned off.", 500);
  }
}
