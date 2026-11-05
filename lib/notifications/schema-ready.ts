import type { SupabaseSettings } from '@/lib/config';
import { query } from '@/lib/supabase/connection';
import type { Execute } from './store';

/** A previous healthy heartbeat cannot stand in for the current notice policy. */
export async function notificationPolicyAvailable(settings: SupabaseSettings, execute: Execute = query): Promise<boolean> {
  try {
    const rows = await execute<{ ready: boolean }>(settings,
      `select to_regprocedure('public.alfred_bank_notice_readiness(uuid,uuid,timestamp with time zone)') is not null
        and exists(select 1 from pg_attribute where attrelid=to_regclass('public.notification_preferences')
          and attname='card_activity_push_since' and not attisdropped and attnotnull and atthasdef and atttypid='timestamptz'::regtype) as ready`);
    return rows[0]?.ready === true;
  } catch { return false; }
}
