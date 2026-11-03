import type { SupabaseSettings } from "@/lib/config";
import { query } from "@/lib/supabase/connection";

const READY_SQL = "select to_regclass('public.accounting_states') is not null and to_regprocedure('public.alfred_write_accounting_state(uuid,bigint,text,text,text,jsonb)') is not null as ready, to_regclass('public.imported_finance_sources') is not null as portability_ready";

const hasState = (key: string) => `jsonb_array_length(coalesce(state->'${key}','[]'::jsonb))>0`;

/**
 * The cheap form of `getGettingStartedState(ledger).isEmpty`: true only when the owner has
 * no record in any table a ledger is built from. It never reads or projects the ledger itself.
 * Every source that can make a ledger non-empty must be listed here; the agreement test in
 * tests/finance-empty-check.test.ts compares it with the full rule.
 * Some stored rows still give an empty ledger (a deleted goal's source, a settled loan, a skipped
 * bank alert), so this may report "not empty" there. It never reports "empty" for an owner with records.
 */
export async function financeLooksEmpty(settings: SupabaseSettings, ownerId: string): Promise<boolean> {
  const [readiness] = await query<{ ready: boolean; portability_ready: boolean }>(settings, READY_SQL);
  // Get Started is only offered once account storage is available, as in the full rule.
  if (!readiness?.ready) return false;
  const sources = [
    "select 1 from public.transactions where owner_id=$1::uuid and status='active'",
    "select 1 from public.budgets where owner_id=$1::uuid",
    "select 1 from public.savings_goals where owner_id=$1::uuid and status<>'deleted'",
    "select 1 from public.loans where owner_id=$1::uuid",
    "select 1 from public.bills where owner_id=$1::uuid",
    "select 1 from public.bank_messages where owner_id=$1::uuid",
    `select 1 from public.accounting_states where owner_id=$1::uuid and (${["accounts", "movements", "snapshots", "transfers", "settlements"].map(hasState).join(" or ")})`,
    ...(readiness.portability_ready ? ["select 1 from public.imported_finance_sources where owner_id=$1::uuid"] : []),
  ];
  const [row] = await query<{ empty: boolean }>(settings, `select ${sources.map((source) => `not exists(${source})`).join(" and ")} as empty`, [ownerId]);
  return row?.empty === true;
}
