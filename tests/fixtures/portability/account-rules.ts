import type { AccountRulesTransport, RuleAccount } from "@/app/settings/account-rules-section";
import { accountRuleCommandSchema } from "@/lib/account-rules/schema";
import { normalizeRuleText, type AccountRuleState } from "@/lib/account-rules/types";

export const syntheticRuleAccounts: RuleAccount[] = [
  { id: "synthetic-personal-wallet", label: "Fictional personal wallet", provider: "momo", currency: "GHS" },
  { id: "synthetic-work-bank", label: "Fictional work bank", provider: "gcb", currency: "GHS" },
];

/** In-memory interface responses only; durable behavior is covered by the SQL tests. */
export function createSyntheticAccountRulesTransport(): AccountRulesTransport {
  const at = "2026-11-02T00:00:00.000Z";
  let state: AccountRuleState = { ownerId: "synthetic-owner", revision: 0, bindings: [], rules: [{ id: "00000000-0000-4000-8000-000000000101", accountId: syntheticRuleAccounts[0].id, matchMode: "exact", merchantExact: "fictional market merchant", direction: "out", category: "Food", active: true, priority: 0, effectiveFrom: at, createdAt: at, revision: 0 }] };
  const seen = new Map<string, string>();
  return {
    async load() { return { state: structuredClone(state), availability: "ready", accounts: structuredClone(syntheticRuleAccounts) }; },
    async save(input) {
      const command = accountRuleCommandSchema.parse(input), encoded = JSON.stringify(command);
      if (seen.has(command.requestId)) { if (seen.get(command.requestId) !== encoded) throw new Error("This request ID already describes another rule change."); return { state: structuredClone(state), availability: "ready" }; }
      if (command.expectedRevision !== state.revision) throw Object.assign(new Error("Rules changed. Refresh before reviewing this change again."), { code: "stale" });
      const next = structuredClone(state);
      if (command.type === "upsert_rule") {
        if (!syntheticRuleAccounts.some((account) => account.id === command.rule.accountId)) throw new Error("Choose one of the fictional owned accounts.");
        const prior = next.rules.find((rule) => rule.id === command.rule.id);
        const rule = { ...command.rule, merchantExact: command.rule.matchMode === "exact" ? normalizeRuleText(command.rule.merchantExact!) : null, direction: command.rule.direction ?? "out" as const, active: command.rule.active ?? true, priority: command.rule.priority ?? 0, effectiveFrom: command.rule.effectiveFrom ?? prior?.effectiveFrom ?? new Date().toISOString(), createdAt: prior?.createdAt ?? new Date().toISOString(), revision: (prior?.revision ?? 0) + 1 };
        next.rules = [...next.rules.filter((item) => item.id !== rule.id), rule];
      } else if (command.type === "set_rule_active") {
        const rule = next.rules.find((item) => item.id === command.ruleId);
        if (!rule) throw new Error("That fictional rule is unavailable.");
        if (command.active && rule.matchMode === "all" && !command.confirmAllScope) throw new Error("Every-merchant scope needs explicit confirmation.");
        rule.active = command.active; rule.revision++;
      } else if (command.type === "save_binding") {
        const account = syntheticRuleAccounts.find((item) => item.id === command.binding.accountId);
        if (!account || account.currency !== command.binding.currency) throw new Error("Choose the matching fictional account and currency.");
        const prior = next.bindings.find((item) => item.id === command.binding.id);
        const same = next.bindings.find((item) => item.provider === normalizeRuleText(command.binding.provider) && item.accountSuffix === command.binding.accountSuffix && item.currency === command.binding.currency);
        if (same && same.accountId !== command.binding.accountId) throw new Error("That exact source tuple already identifies another fictional account.");
        next.bindings = [...next.bindings.filter((item) => item.id !== command.binding.id), { ...command.binding, provider: normalizeRuleText(command.binding.provider), createdAt: prior?.createdAt ?? new Date().toISOString(), revision: (prior?.revision ?? 0) + 1 }];
      } else throw new Error("This interface simulation supports rule edits, enable/disable and exact source bindings.");
      next.revision++; state = next; seen.set(command.requestId, encoded);
      return { state: structuredClone(state), availability: "ready" };
    },
  };
}
