import { splitNames } from "@/lib/bank/store";
import { sourceName, type BankSource } from "@/lib/bank/parse";
import type { SupabaseSettings } from "@/lib/config";
import { query } from "@/lib/supabase/connection";
import type { LedgerBank } from "./ledger";

// These independent ancillary reads share one statement snapshot and one pool
// checkout. Select forwarding timestamps only; never transfer token credentials.
export const LEDGER_BANK_METADATA_SQL = `select
  (select to_jsonb(token_row) from (
    select last_used_at,last_empty_at from public.ingest_tokens where owner_id=$1::uuid
  ) token_row) as token,
  coalesce((select account_names from public.profiles where id=$1::uuid),'') as account_names,
  coalesce((select jsonb_agg(balance_row order by source) from (
    select distinct on (source) source,balance::text,occurred_at
    from public.bank_messages where owner_id=$1::uuid and balance is not null
    order by source,occurred_at desc,created_at desc
  ) balance_row),'[]'::jsonb) as balances`;

type BankMetadataRow = {
  token: { last_used_at: string | null; last_empty_at: string | null } | null;
  account_names: string;
  balances: { source: BankSource; balance: string; occurred_at: string }[];
};

/** Fresh display metadata only. Accounting sources retain their own coherent read boundary. */
export async function loadLedgerBankMetadata(settings: SupabaseSettings, ownerId: string): Promise<Omit<LedgerBank, "needsLabel">> {
  const [row] = await query<BankMetadataRow>(settings, LEDGER_BANK_METADATA_SQL, [ownerId]);
  if (!row) throw new Error("Bank connection details could not be loaded.");
  return {
    connected: row.token !== null,
    lastUsedAt: row.token?.last_used_at ? new Date(row.token.last_used_at).toISOString() : null,
    lastEmptyAt: row.token?.last_empty_at ? new Date(row.token.last_empty_at).toISOString() : null,
    accountNames: splitNames(row.account_names),
    balances: row.balances.map(balance => ({
      source: balance.source, label: sourceName(balance.source), balance: Number(balance.balance).toFixed(2),
      at: new Date(balance.occurred_at).toISOString(),
    })),
  };
}
