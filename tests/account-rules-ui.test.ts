import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RuleScopeDetails } from "@/app/settings/account-rules-section";
import { createSyntheticAccountRulesTransport, syntheticRuleAccounts } from "./fixtures/portability/account-rules";
import { applyAccountRules } from "@/lib/account-rules/matcher";
import type { AccountRuleCommand } from "@/lib/account-rules/types";
import { emptyAccountingState, type CashMovement } from "@/lib/finance/accounting/types";

const id = "00000000-0000-4000-8000-000000000201";
const at = "2026-11-02T00:00:00.000Z";
function command(): AccountRuleCommand {
  return { type: "upsert_rule", expectedRevision: 0, requestId: "synthetic-new-rule", rule: { id, accountId: syntheticRuleAccounts[1].id, matchMode: "exact", merchantExact: "FICTIONAL TAXI", direction: "out", category: "Transport", effectiveFrom: at } };
}

describe("account-specific rule interface", () => {
  it("reviews the exact account, whole text and direction without broadening another account", () => {
    const input = command(); if (input.type !== "upsert_rule") throw new Error("Expected a rule.");
    const markup = renderToStaticMarkup(createElement(RuleScopeDetails, { rule: input.rule, accounts: syntheticRuleAccounts }));
    expect(markup).toContain("Fictional work bank");
    expect(markup).not.toContain("synthetic-work-bank");
    expect(markup).toContain("Exactly: “FICTIONAL TAXI”");
    expect(markup).toContain("Outgoing");
    expect(markup).not.toContain("Every merchant/text");
    expect(markup).not.toContain("Fictional personal wallet");
    const safe = renderToStaticMarkup(createElement(RuleScopeDetails, { rule: { ...input.rule, merchantExact: "<script>unsafe()</script>" }, accounts: syntheticRuleAccounts }));
    expect(safe).not.toContain("<script>");
    expect(safe).toContain("&lt;script&gt;");
  });

  it("keeps previewing read-only, saves one scoped rule, and retries the same request idempotently", async () => {
    const transport = createSyntheticAccountRulesTransport();
    const before = await transport.load();
    const input = command();
    renderToStaticMarkup(createElement(RuleScopeDetails, { rule: input.type === "upsert_rule" ? input.rule : neverRule(), accounts: before.accounts }));
    expect(await transport.load()).toEqual(before);
    const saved = await transport.save(input);
    expect(saved.state.rules).toHaveLength(before.state.rules.length + 1);
    expect(await transport.save(input)).toEqual(saved);
    const stale = { ...command(), requestId: "another-stale-change" };
    await expect(transport.save(stale)).rejects.toThrow("Refresh");
    expect((await transport.load()).state).toEqual(saved.state);
  });

  it("requires explicit all-merchant scope and can disable a rule without changing other saved rules", async () => {
    const transport = createSyntheticAccountRulesTransport();
    const input = command(); if (input.type !== "upsert_rule") throw new Error("Expected a rule.");
    await expect(transport.save({ ...input, rule: { ...input.rule, matchMode: "all", merchantExact: null } })).rejects.toThrow("Confirm explicitly");
    const saved = await transport.save({ ...input, confirmAllScope: true, rule: { ...input.rule, matchMode: "all", merchantExact: null } });
    const disabled = await transport.save({ type: "set_rule_active", expectedRevision: saved.state.revision, requestId: "disable-reviewed-rule", ruleId: id, active: false });
    expect(disabled.state.rules.find((rule) => rule.id === id)?.active).toBe(false);
    expect(disabled.state.rules.find((rule) => rule.id !== id)).toEqual(saved.state.rules.find((rule) => rule.id !== id));
  });

  it("hands off to the real deterministic matcher while preserving manual labels and statuses", async () => {
    const transport = createSyntheticAccountRulesTransport();
    const saved = await transport.save(command());
    const movement = (accountId: string, overrides: Partial<CashMovement> = {}): CashMovement => ({ id: `movement:${accountId}`, ownerId: "synthetic-owner", accountId, direction: "out", status: "review", amountMinor: 1000, feeMinor: 0, currency: "GHS", date: "2026-11-02", occurredAt: at, description: " fictional   taxi ", category: "Other", sourceCategory: "Other", sourceId: "synthetic-source", sourceKind: "manual", sourceFingerprint: "synthetic-fingerprint", legacyTransactionId: null, feeTransactionId: null, legacyClassification: null, ...overrides });
    const accounting = { ...emptyAccountingState("synthetic-owner"), accounts: syntheticRuleAccounts.map((account) => ({ ...account, includeInCash: true, createdAt: at })), movements: [movement(syntheticRuleAccounts[1].id), movement(syntheticRuleAccounts[0].id), movement(syntheticRuleAccounts[1].id, { id: "manual", category: "Personal", categoryOrigin: "manual" })] };
    const result = applyAccountRules(accounting, saved.state);
    expect(result.movements.map((row) => row.category)).toEqual(["Transport", "Other", "Personal"]);
    expect(result.movements.map((row) => row.status)).toEqual(["review", "review", "review"]);
  });
});

function neverRule(): never { throw new Error("Expected a rule."); }
