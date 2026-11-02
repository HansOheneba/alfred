import type { AccountingState, CashMovement } from "@/lib/finance/accounting/types";
import { normalizeRuleText, type AccountRuleState } from "./types";

export type RuleMatch = { category: string | null; ruleId: string | null; conflict: boolean };

/** Priority is explicit. Equal-priority conflicting categories fail closed instead of depending on array order. */
export function matchAccountRule(movement: CashMovement, state: AccountRuleState): RuleMatch {
  if (movement.ownerId !== state.ownerId || !movement.accountId || movement.sourceMissing || movement.direction === "internal") return { category: null, ruleId: null, conflict: false };
  const at = Date.parse(movement.occurredAt ?? `${movement.date}T00:00:00Z`);
  if (!Number.isFinite(at)) return { category: null, ruleId: null, conflict: false };
  const merchant = normalizeRuleText(movement.description);
  const matches = state.rules.filter((rule) => rule.active && rule.accountId === movement.accountId &&
    (rule.direction === "any" || rule.direction === movement.direction) && at >= Date.parse(rule.effectiveFrom || rule.createdAt) &&
    (rule.matchMode === "all" || rule.merchantExact !== null && normalizeRuleText(rule.merchantExact) === merchant));
  const priority = Math.max(...matches.map((rule) => rule.priority));
  const chosen = matches.filter((rule) => rule.priority === priority).sort((a, b) => a.id.localeCompare(b.id));
  if (!chosen.length) return { category: null, ruleId: null, conflict: false };
  if (new Set(chosen.map((rule) => rule.category)).size > 1) return { category: null, ruleId: null, conflict: true };
  return { category: chosen[0].category, ruleId: chosen[0].id, conflict: false };
}

/** Bind only using a user-confirmed provider + explicit account suffix + currency tuple. */
export function bindMovementAccount(movement: CashMovement, accounting: AccountingState, rules: AccountRuleState): string | null {
  if (movement.ownerId !== rules.ownerId || movement.accountId || movement.sourceMissing || !movement.sourceText || !movement.sourceLabel) return movement.accountId;
  const suffixes = new Set([...movement.sourceText.matchAll(/\b(?:A\/C|Acct|Account)(?:\s*(?:No\.?|Number|ending(?: in)?))?\s*[:.#]?\s*[X*x•.\s-]*(\d{3,})\b/gi)].map((match) => match[1].slice(-4)));
  // Texts naming multiple different accounts cannot establish a unique source identity.
  if (suffixes.size !== 1) return null;
  const suffix = [...suffixes][0];
  const accountIds = new Set(rules.bindings.filter((binding) => binding.active && binding.accountSuffix === suffix && binding.currency === movement.currency &&
    normalizeRuleText(binding.provider) === normalizeRuleText(movement.sourceLabel!) && accounting.accounts.some((account) => account.id === binding.accountId && account.currency === movement.currency)).map((binding) => binding.accountId));
  return accountIds.size === 1 ? [...accountIds][0] : null;
}

/** Categories are derived at read time. Rules never confirm, exclude, transfer, or otherwise change status. */
export function applyAccountRules(accounting: AccountingState, rules: AccountRuleState): AccountingState {
  if (accounting.ownerId !== rules.ownerId) return accounting;
  return { ...accounting, movements: accounting.movements.map((movement) => {
    const assigned = { ...movement, accountId: bindMovementAccount(movement, accounting, rules) };
    const isManual = assigned.categoryOrigin === "manual" || assigned.categoryOrigin !== "account_rule" && assigned.sourceCategory !== undefined && assigned.category !== assigned.sourceCategory;
    if (isManual) return assigned;
    const base = { ...assigned, category: assigned.sourceCategory ?? assigned.category, categoryOrigin: "source" as const };
    delete base.appliedRuleId;
    delete base.ruleConflict;
    const match = matchAccountRule(base, rules);
    return match.category === null ? { ...base, ...(match.conflict ? { ruleConflict: true } : {}) } : { ...base, category: match.category, categoryOrigin: "account_rule" as const, appliedRuleId: match.ruleId! };
  }) };
}
