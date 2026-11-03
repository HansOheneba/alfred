import { hashIngestToken } from "@/lib/bank/store";
import type { SupabaseSettings } from "@/lib/config";
import { query } from "@/lib/supabase/connection";

export type CollectorAccount = { ownerId: string; preferredName: string; email: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pairing is a read, never a delivery/last-used ping or financial operation. */
export async function collectorAccount(settings: SupabaseSettings, token: string): Promise<CollectorAccount | null> {
  if (!/^alf_[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const rows = await query<{ owner_id: string; preferred_name: string; email: string | null }>(settings,
    `select p.id::text as owner_id, p.preferred_name, u.email
     from public.ingest_tokens i join public.profiles p on p.id=i.owner_id
     join auth.users u on u.id=p.id where i.token_hash=$1`, [hashIngestToken(token)]);
  if (rows.length !== 1) return null;
  const row = rows[0];
  if (!row || !UUID.test(row.owner_id) || !row.email || row.email.length > 254 || !/^[^\s<>@\p{Cc}\p{Cf}]+@[^\s<>@\p{Cc}\p{Cf}]+\.[^\s<>@\p{Cc}\p{Cf}]+$/u.test(row.email)) return null;
  const preferredName = row.preferred_name.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Alfred account";
  return { ownerId: row.owner_id.toLowerCase(), preferredName, email: row.email };
}
