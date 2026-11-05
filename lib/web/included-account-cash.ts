import type { SupabaseSettings } from "@/lib/config";
import { accountBalances } from "@/lib/finance/accounting/accounts";
import { includedAccountCash, type IncludedAccountCash } from "@/lib/finance/accounting/cash-summary";
import { loadAccountingReadModel } from "@/lib/finance/accounting/persisted-store";
import { logError } from "@/lib/log";
import { readDurableAccountFacts } from "./durable-secondary";
import { balanceForCurrency } from "@/lib/finance/accounting/accounts-model";
import { DurableDisplayUpdating } from "@/lib/finance/accounting/durable-read";

/** Read current accounting evidence without loading unrelated dashboard data. */
export async function loadIncludedAccountCash(settings: SupabaseSettings, ownerId: string, currency: string): Promise<IncludedAccountCash> {
  try {
    const durable=await readDurableAccountFacts(settings,ownerId);
    if(durable)return includedAccountCash({availability:durable.manifest.accounts.availability,balances:balanceForCurrency(durable.manifest.accounts.accountFacts,currency)},currency);
    const accounting = await loadAccountingReadModel(settings, ownerId);
    return includedAccountCash({ availability: accounting.availability, balances: accountBalances(accounting.state, currency) }, currency);
  } catch (error) {
    if(error instanceof DurableDisplayUpdating)throw error;
    logError("investment_account_balances", error);
    return includedAccountCash(null, currency);
  }
}
