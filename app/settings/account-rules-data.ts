import type { AccountRuleCommand, AccountRuleResult } from "@/lib/account-rules/types";
import { requestAccountsView } from "@/app/accounts/read-request";

export type RuleAccount = { id: string; label: string; provider: string; currency: string };
export type AccountRulesData = AccountRuleResult & { accounts: RuleAccount[] };
export type AccountRulesTransport = { load: (ownerId?: string) => Promise<AccountRulesData>; save: (command: AccountRuleCommand) => Promise<AccountRuleResult> };

/** Rule forms need account identities, never an editable copy of the accounting ledger. */
export async function loadAccountRulesInputs(ownerId: string | undefined, request: typeof fetch = fetch): Promise<AccountRulesData> {
  if (!ownerId) throw new Error("Reload Settings to check your signed-in account.");
  const [rulesResponse, accounting] = await Promise.all([
    request("/api/account-rules", { cache: "no-store", credentials: "same-origin" }),
    requestAccountsView({ ownerId, query: "section=activity&page=0", request }),
  ]);
  const rules = await rulesResponse.json().catch(() => null) as (AccountRuleResult & { ok?: boolean; text?: string }) | null;
  if (!rulesResponse.ok || rules?.ok !== true || !rules.state || !Array.isArray(rules.state.rules) || !Array.isArray(rules.state.bindings)
    || !Number.isSafeInteger(rules.state.revision) || rules.state.revision < 0 || !["ready", "migration-required"].includes(rules.availability)) throw new Error(rules?.text || "Account rules could not be loaded.");
  if (rules.state.ownerId !== ownerId) throw new Error("Your signed-in account changed. Reload Settings.");
  const accounts = accounting.accounts.map(({ id, label, provider, currency }) => ({ id, label, provider, currency }));
  if (accounts.some(account => [account.id, account.label, account.provider, account.currency].some(value => typeof value !== "string"))) throw new Error("Your financial account names could not be loaded.");
  return { state: rules.state, accounts, availability: rules.availability === "ready" && accounting.availability === "ready" ? "ready" : "migration-required" };
}
