import type { SupabaseSettings } from '@/lib/config';
import { query } from '@/lib/supabase/connection';
import type { Execute } from './store';

/** A previous healthy heartbeat cannot stand in for the current notice policy. */
export async function notificationPolicyAvailable(settings: SupabaseSettings, execute: Execute = query): Promise<boolean> {
  try {
    const rows = await execute<{ ready: boolean }>(settings,
      "select to_regprocedure('public.alfred_bank_notice_readiness(uuid,uuid,timestamp with time zone)') is not null as ready");
    return rows[0]?.ready === true;
  } catch { return false; }
}
