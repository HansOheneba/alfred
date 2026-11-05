import type { SupabaseSettings } from "@/lib/config";
import { accountBalances } from "@/lib/finance/accounting/accounts";
import { includedAccountCash, type IncludedAccountCash } from "@/lib/finance/accounting/cash-summary";
import { loadAccountingState } from "@/lib/finance/accounting/persisted-store";
import { logError } from "@/lib/log";

/** Read current accounting evidence without loading unrelated dashboard data. */
export async function loadIncludedAccountCash(settings: SupabaseSettings, ownerId: string, currency: string): Promise<IncludedAccountCash> {
  try {
    const accounting = await loadAccountingState(settings, ownerId);
    return includedAccountCash({ availability: accounting.availability, balances: accountBalances(accounting.state, currency) }, currency);
  } catch (error) {
    logError("investment_account_balances", error);
    return includedAccountCash(null, currency);
  }
}
