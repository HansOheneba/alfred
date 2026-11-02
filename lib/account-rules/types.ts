export type AccountRule = {
  id: string;
  accountId: string;
  matchMode: "exact" | "all";
  merchantExact: string | null;
  direction: "in" | "out" | "any";
  category: string;
  active: boolean;
  priority: number;
  effectiveFrom: string;
  createdAt: string;
  revision: number;
  importProvenance?: { namespace: string; sourceId: string };
};

export type AccountBinding = {
  id: string;
  accountId: string;
  provider: string;
  accountSuffix: string;
  currency: string;
  active: boolean;
  createdAt: string;
  revision: number;
  importProvenance?: { namespace: string; sourceId: string };
};

export type AccountRuleState = { ownerId: string; revision: number; rules: AccountRule[]; bindings: AccountBinding[] };
export type RuleInput = Omit<AccountRule, "createdAt" | "revision" | "direction" | "priority" | "active" | "effectiveFrom" | "importProvenance"> & {
  direction?: AccountRule["direction"];
  priority?: number;
  active?: boolean;
  effectiveFrom?: string;
};
type Command = { expectedRevision: number; requestId: string };
export type AccountRuleCommand = Command & (
  | { type: "upsert_rule"; rule: RuleInput; confirmAllScope?: boolean }
  | { type: "delete_rule"; ruleId: string }
  | { type: "set_rule_active"; ruleId: string; active: boolean; confirmAllScope?: boolean }
  | { type: "save_binding"; binding: Omit<AccountBinding, "createdAt" | "revision" | "importProvenance"> }
  | { type: "delete_binding"; bindingId: string }
);

export type AccountRuleResult = { state: AccountRuleState; availability: "ready" | "migration-required" };
export class AccountRuleError extends Error {
  constructor(message: string, public readonly code: "validation" | "stale" | "conflict" | "ownership" | "not_found" = "validation") {
    super(message); this.name = "AccountRuleError";
  }
}
export const emptyAccountRuleState = (ownerId: string): AccountRuleState => ({ ownerId, revision: 0, rules: [], bindings: [] });

/** Mirrors Money's exact merchant normalization; it never performs fuzzy/AI matching. */
export const normalizeRuleText = (value: string) => value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
