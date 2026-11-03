import type { SupabaseSettings } from "@/lib/config";
import { query } from "@/lib/supabase/connection";
import type { Execute } from "@/lib/notifications/store";

/** Catalog-only readiness for automatic capture plus in/out announcements.
 * It neither creates schema nor reads a user's messages or financial records.
 * Device push is independent: missing VAPID/recovery configuration does not
 * prevent private chat announcements or durable collector acknowledgements. */
export async function collectorSetupReady(settings: SupabaseSettings, execute: Execute = query): Promise<boolean> {
  try {
    const rows = await execute<{ ready: boolean }>(settings, `select (
      to_regclass('public.bank_messages') is not null
      and to_regclass('public.collector_event_receipts') is not null
      and to_regclass('public.bank_notice_receipts') is not null
      and to_regprocedure('public.alfred_claim_collector_event(uuid,text,text)') is not null
      and to_regprocedure('public.alfred_complete_collector_event(uuid,text,text,uuid,uuid[])') is not null
      and to_regprocedure('public.alfred_release_collector_event(uuid,text,text,uuid)') is not null
      and to_regprocedure('public.alfred_record_bank_activity_notice(uuid,uuid,text,text,boolean,text,uuid,boolean,jsonb,jsonb)') is not null
      and (select count(*) from information_schema.columns where table_schema='public' and table_name='notification_preferences'
        and ((column_name in ('payment_mentions','outgoing_mentions') and data_type='boolean')
          or (column_name in ('payment_mentions_since','outgoing_mentions_since') and data_type='timestamp with time zone'))) = 4
    ) as ready`, []);
    return rows.length === 1 && rows[0].ready === true;
  } catch {
    // An unavailable catalog is not permission to start capture. Never expose
    // database details or replace a failed check with a cached success.
    return false;
  }
}
