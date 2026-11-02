import { createHash } from "node:crypto";
import type { SupabaseSettings } from "@/lib/config";
import type { FinancialAccount } from "@/lib/finance/accounting/types";
import { stableJson } from "@/lib/finance/accounting/reducer";
import { query } from "@/lib/supabase/connection";
import { ACCOUNT_RULES_READY_SQL, schemaReady } from "@/lib/supabase/finance-capabilities";
import { accountRuleCommandSchema } from "./schema";
import { AccountRuleError, emptyAccountRuleState, normalizeRuleText, type AccountRuleCommand, type AccountRuleResult, type AccountRuleState } from "./types";

const keyOf = (row: { accountId: string; matchMode: string; merchantExact: string | null; direction?: string }) => stableJson([row.accountId, row.matchMode, row.merchantExact, row.direction ?? "out"]);
export function reduceAccountRuleCommand(state: AccountRuleState, command: AccountRuleCommand, accounts: FinancialAccount[], now = new Date().toISOString()): AccountRuleState {
  const parsed = accountRuleCommandSchema.safeParse(command);
  if (!parsed.success) throw new AccountRuleError(parsed.error.issues[0]?.message ?? "Invalid account rule command.");
  command = parsed.data;
  if (command.expectedRevision !== state.revision) throw new AccountRuleError("Account rules changed. Refresh before saving.", "stale");
  if (!Number.isFinite(Date.parse(now))) throw new AccountRuleError("A valid action time is required.");
  const ownedAccount = (id: string) => {
    const account = accounts.find((item) => item.id === id);
    if (!account) throw new AccountRuleError("Choose a financial account owned by this signed-in profile.", "ownership");
    return account;
  };
  const next = structuredClone(state);
  if (command.type === "upsert_rule") {
    ownedAccount(command.rule.accountId);
    const merchantExact = command.rule.matchMode === "exact" ? normalizeRuleText(command.rule.merchantExact!) : null;
    if (merchantExact !== null && (!merchantExact || merchantExact.length > 2000)) throw new AccountRuleError("A safe exact merchant descriptor is required.");
    const candidate = { ...command.rule, merchantExact, direction: command.rule.direction ?? "out" };
    const sameKey = next.rules.find((row) => keyOf(row) === keyOf(candidate));
    const sameId = next.rules.find((row) => row.id === candidate.id);
    if (sameKey && sameId && sameKey.id !== sameId.id) throw new AccountRuleError("Another rule already covers this account, merchant and direction.", "conflict");
    const prior = sameKey ?? sameId;
    const rule = {
      ...prior, ...candidate, id: prior?.id ?? candidate.id, active: candidate.active ?? true, priority: candidate.priority ?? 0,
      effectiveFrom: candidate.effectiveFrom ?? prior?.effectiveFrom ?? now, createdAt: prior?.createdAt ?? now, revision: (prior?.revision ?? 0) + 1,
    };
    next.rules = next.rules.filter((row) => row.id !== rule.id).concat(rule);
  } else if (command.type === "delete_rule" || command.type === "set_rule_active") {
    const rule = next.rules.find((row) => row.id === command.ruleId);
    if (!rule) throw new AccountRuleError("Account rule was not found.", "not_found");
    if (command.type === "delete_rule") next.rules = next.rules.filter((row) => row.id !== rule.id);
    else {
      if (command.active) ownedAccount(rule.accountId);
      if (command.active && rule.matchMode === "all" && command.confirmAllScope !== true) throw new AccountRuleError("Confirm explicitly that this rule covers every merchant on the selected account.");
      rule.active = command.active; rule.revision += 1;
    }
  } else if (command.type === "save_binding") {
    const account = ownedAccount(command.binding.accountId);
    if (account.currency !== command.binding.currency) throw new AccountRuleError("The account binding currency must match the financial account.");
    const binding = { ...command.binding, provider: normalizeRuleText(command.binding.provider) };
    const sameTuple = next.bindings.find((row) => row.provider === binding.provider && row.accountSuffix === binding.accountSuffix && row.currency === binding.currency);
    const sameId = next.bindings.find((row) => row.id === binding.id);
    if (sameTuple && (sameTuple.accountId !== binding.accountId || sameId && sameTuple.id !== sameId.id)) throw new AccountRuleError("This provider, suffix and currency already identify another binding. Remove it explicitly before rebinding.", "conflict");
    const prior = sameTuple ?? sameId;
    next.bindings = next.bindings.filter((row) => row.id !== (prior?.id ?? binding.id)).concat({ ...prior, ...binding, id: prior?.id ?? binding.id, createdAt: prior?.createdAt ?? now, revision: (prior?.revision ?? 0) + 1 });
  } else {
    const binding = next.bindings.find((row) => row.id === command.bindingId);
    if (!binding) throw new AccountRuleError("Account binding was not found.", "not_found");
    next.bindings = next.bindings.filter((row) => row.id !== command.bindingId);
  }
  if (next.rules.length > 1000 || next.bindings.length > 100) throw new AccountRuleError("Account rule or binding limit reached.");
  next.revision += 1;
  return next;
}

/** Never creates tables or changes existing finance settings when the migration is unavailable. */
export async function loadAccountRules(settings: SupabaseSettings, ownerId: string): Promise<AccountRuleResult> {
  if (!await schemaReady(settings, ACCOUNT_RULES_READY_SQL)) return { state: emptyAccountRuleState(ownerId), availability: "migration-required" };
  const rows = await query<{ state: AccountRuleState }>(settings, "select state from public.account_rule_states where owner_id=$1::uuid", [ownerId]);
  const state = rows[0]?.state ?? emptyAccountRuleState(ownerId);
  if (state.ownerId !== ownerId) throw new AccountRuleError("Account rules belong to a different owner.", "ownership");
  return { state, availability: "ready" };
}

export async function saveAccountRuleCommand(settings: SupabaseSettings, ownerId: string, command: AccountRuleCommand): Promise<AccountRuleResult> {
  const parsed = accountRuleCommandSchema.safeParse(command);
  if (!parsed.success) throw new AccountRuleError(parsed.error.issues[0]?.message ?? "Invalid account rule command.");
  command = parsed.data;
  const current = await loadAccountRules(settings, ownerId);
  if (current.availability !== "ready") return current;
  const fingerprint = createHash("sha256").update(stableJson(command)).digest("hex");
  const prior = await query<{ action_fingerprint: string }>(settings, "select action_fingerprint from public.account_rule_events where owner_id=$1::uuid and request_id=$2", [ownerId, command.requestId]);
  if (prior[0]) {
    if (prior[0].action_fingerprint !== fingerprint) throw new AccountRuleError("This request ID was already used for a different account-rule command.", "conflict");
    return current;
  }
  const accountRows = await query<{ accounts: FinancialAccount[] }>(settings, "select state->'accounts' as accounts from public.accounting_states where owner_id=$1::uuid", [ownerId]);
  const next = reduceAccountRuleCommand(current.state, command, accountRows[0]?.accounts ?? []);
  const rows = await query<{ result: { status: string; state?: AccountRuleState } }>(settings,
    "select public.alfred_write_account_rules($1::uuid,$2::bigint,$3,$4,$5::jsonb) as result",
    [ownerId, command.expectedRevision, command.requestId, fingerprint, JSON.stringify(next)]);
  const result = rows[0]?.result;
  if (result?.status === "stale") throw new AccountRuleError("Account rules changed. Refresh before saving.", "stale");
  if (result?.status === "conflict") throw new AccountRuleError("This request ID was already used for a different account-rule command.", "conflict");
  if (result?.status === "ownership") throw new AccountRuleError("The selected financial account is unavailable for this owner.", "ownership");
  if (!result?.state) throw new AccountRuleError("The database did not confirm this account-rule change.", "conflict");
  return { state: result.state, availability: "ready" };
}
