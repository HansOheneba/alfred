import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyAccountRules, bindMovementAccount, matchAccountRule } from "@/lib/account-rules/matcher";
import { accountRuleCommandSchema } from "@/lib/account-rules/schema";
import { loadAccountRules, reduceAccountRuleCommand, saveAccountRuleCommand } from "@/lib/account-rules/store";
import { emptyAccountRuleState, type AccountRule, type AccountRuleState } from "@/lib/account-rules/types";
import type { SupabaseSettings } from "@/lib/config";
import { emptyAccountingState, type CashMovement, type FinancialAccount } from "@/lib/finance/accounting/types";
import { applyAccountingAction } from "@/lib/finance/accounting/reducer";
import { hydrateAccountingSources } from "@/lib/finance/accounting/sources";
import { canonicalStringify } from "../portability/archive.mjs";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/supabase/connection", () => ({ query: mocks.query }));
const OWNER = "00000000-0000-4000-8000-000000000001";
const RULE = "00000000-0000-4000-8000-000000000010";
const NEXT = "00000000-0000-4000-8000-000000000011";
const NOW = "2026-11-02T12:00:00.000Z";
const accounts: FinancialAccount[] = [{ id: "account-a", label: "Everyday", provider: "GCB", currency: "GHS", includeInCash: true, createdAt: NOW }, { id: "account-b", label: "Other GCB", provider: "GCB", currency: "GHS", includeInCash: true, createdAt: NOW }];
const rule = (changes: Partial<AccountRule> = {}): AccountRule => ({ id: RULE, accountId: "account-a", matchMode: "exact", merchantExact: "synthetic merchant", direction: "out", category: "Custom category", active: true, priority: 0, effectiveFrom: NOW, createdAt: NOW, revision: 1, ...changes });
const state = (rules = [rule()]): AccountRuleState => ({ ...emptyAccountRuleState(OWNER), rules });
const movement = (changes: Partial<CashMovement> = {}): CashMovement => ({ id: "synthetic", ownerId: OWNER, accountId: "account-a", direction: "out", status: "review", sourceStatus: "review", amountMinor: 1000, feeMinor: 20, taxMinor: 10, currency: "GHS", date: "2026-11-02", occurredAt: NOW, description: "Synthetic Merchant", category: "Source category", sourceCategory: "Source category", sourceId: "raw", sourceKind: "bank", sourceFingerprint: "fingerprint", legacyTransactionId: null, feeTransactionId: null, legacyClassification: null, ...changes });
const accounting = (rows = [movement()]) => ({ ...emptyAccountingState(OWNER), accounts, movements: rows });

describe("deterministic account-specific categorisation", () => {
  it("normalizes NFKC, whitespace and case, while requiring exact descriptor/account/direction and cutoff", () => {
    expect(matchAccountRule(movement({ description: "  Ｓynthetic\n  Merchant  " }), state()).category).toBe("Custom category");
    for (const change of [{ description: "Synthetic Merchant Extra" }, { accountId: "account-b" }, { accountId: null }, { direction: "in" as const }, { ownerId: "foreign" }, { occurredAt: "2026-11-02T11:59:59.999Z" }, { sourceMissing: true }]) {
      expect(matchAccountRule(movement(change), state()).category).toBeNull();
    }
    expect(matchAccountRule(movement({ direction: "in" }), state([rule({ direction: "any" })])).category).toBe("Custom category");
    expect(matchAccountRule(movement(), state([rule({ active: false })])).category).toBeNull();
  });

  it("resolves explicit priorities and fails closed on tied categories independent of input order", () => {
    const overlapping = [rule(), rule({ id: NEXT, matchMode: "all", merchantExact: null, category: "Different category" })];
    expect(matchAccountRule(movement(), state(overlapping))).toEqual({ category: null, ruleId: null, conflict: true });
    expect(matchAccountRule(movement(), state(overlapping.toReversed()))).toEqual({ category: null, ruleId: null, conflict: true });
    expect(matchAccountRule(movement(), state([overlapping[0], { ...overlapping[1], priority: 1 }])).category).toBe("Different category");
    expect(matchAccountRule(movement(), state([overlapping[0], { ...overlapping[1], category: "Custom category" }])).conflict).toBe(false);
  });

  it("keeps manual overrides above rules and rules above source defaults without changing status, money or evidence", () => {
    const input = accounting([movement(), movement({ id: "manual", category: "My explicit choice", categoryOrigin: "manual" }), movement({ id: "legacy", category: "Legacy override" })]);
    const before = structuredClone(input);
    const result = applyAccountRules(input, state());
    expect(result.movements.map((row) => row.category)).toEqual(["Custom category", "My explicit choice", "Legacy override"]);
    expect(result.movements[0]).toMatchObject({ status: "review", sourceStatus: "review", amountMinor: 1000, feeMinor: 20, taxMinor: 10, sourceFingerprint: "fingerprint", categoryOrigin: "account_rule", appliedRuleId: RULE });
    expect(input).toEqual(before);
    const noRule = applyAccountRules(result, state([]));
    expect(noRule.movements[0].category).toBe("Source category");
    expect(noRule.movements[1].category).toBe("My explicit choice");
    expect(applyAccountRules(input, { ...state(), ownerId: "other" })).toBe(input);
    expect(() => canonicalStringify(result)).not.toThrow();
    expect(() => canonicalStringify(noRule)).not.toThrow();
  });

  it("retains explicit category metadata through source refresh and returns prior rule categories after manual undo", () => {
    const initial = applyAccountRules(accounting(), state());
    const edited = applyAccountingAction(initial, { type: "classify_movement", expectedRevision: 0, requestId: "manual-edit", movement: { movementId: "synthetic", sourceFingerprint: "fingerprint" }, status: "review", category: "Manual" }, NOW);
    expect(edited.movements[0].categoryOrigin).toBe("manual");
    const refreshed = hydrateAccountingSources(edited, [movement()]);
    expect(applyAccountRules(refreshed, state()).movements[0].category).toBe("Manual");
    const undone = applyAccountingAction(edited, { type: "undo", expectedRevision: 1, requestId: "undo-manual" }, NOW);
    expect(undone.movements[0].categoryOrigin).toBe("account_rule");
    expect(applyAccountRules(undone, state()).movements[0].category).toBe("Custom category");
    const changed = hydrateAccountingSources(edited, [movement({ sourceFingerprint: "new-evidence" })]);
    expect(applyAccountRules(changed, state()).movements[0].category).toBe("Custom category");
    expect(() => canonicalStringify(edited)).not.toThrow();
    expect(() => canonicalStringify(refreshed)).not.toThrow();
    expect(() => canonicalStringify(undone)).not.toThrow();
  });

  it("binds only an explicitly configured provider+suffix+currency tuple and rejects ambiguous references", () => {
    const rules = { ...state(), bindings: [{ id: RULE, accountId: "account-a", provider: "gcb", accountSuffix: "0543", currency: "GHS", active: true, createdAt: NOW, revision: 1 }] };
    const raw = movement({ accountId: null, sourceText: "Synthetic payment. Your A/C No:XXXX0543", sourceLabel: "GCB" });
    expect(bindMovementAccount(raw, accounting(), rules)).toBe("account-a");
    expect(applyAccountRules(accounting([raw]), rules).movements[0]).toMatchObject({ accountId: "account-a", status: "review", category: "Custom category" });
    for (const change of [{ sourceText: "Synthetic payment without account reference" }, { sourceLabel: "momo" }, { currency: "USD" }, { sourceText: "A/C XXXX0543 and account ending 3456" }]) {
      expect(bindMovementAccount({ ...raw, ...change }, accounting(), rules)).toBeNull();
    }
    expect(bindMovementAccount(raw, accounting(), { ...rules, bindings: [...rules.bindings, { ...rules.bindings[0], id: NEXT, accountId: "account-b" }] })).toBeNull();
  });
});

describe("account rule commands and durable store", () => {
  beforeEach(() => { mocks.query.mockReset(); });
  const create = () => ({ type: "upsert_rule" as const, expectedRevision: 0, requestId: "create-rule", rule: { id: RULE, accountId: "account-a", matchMode: "exact" as const, merchantExact: "  Ｓynthetic   MERCHANT ", category: "Custom category" } });

  it("defaults direction out, updates the unique normalized account/merchant/direction key and preserves provenance", () => {
    const created = reduceAccountRuleCommand(emptyAccountRuleState(OWNER), create(), accounts, NOW);
    expect(created.rules[0]).toMatchObject({ merchantExact: "synthetic merchant", direction: "out", priority: 0, effectiveFrom: NOW, createdAt: NOW, revision: 1 });
    created.rules[0].importProvenance = { namespace: "original", sourceId: "original-rule" };
    const edited = reduceAccountRuleCommand(created, { ...create(), expectedRevision: 1, requestId: "update-rule", rule: { ...create().rule, id: NEXT, category: "New custom category" } }, accounts, "2026-11-03T12:00:00Z");
    expect(edited.rules).toHaveLength(1);
    expect(edited.rules[0]).toMatchObject({ id: RULE, category: "New custom category", revision: 2, createdAt: NOW, effectiveFrom: NOW, importProvenance: { namespace: "original", sourceId: "original-rule" } });
  });

  it("requires explicit all-merchant confirmation, rejects foreign accounts, oversized descriptors and stale writes", () => {
    const all = { ...create(), rule: { ...create().rule, matchMode: "all" as const, merchantExact: null } };
    expect(() => reduceAccountRuleCommand(emptyAccountRuleState(OWNER), all, accounts, NOW)).toThrow("Confirm explicitly");
    const saved = reduceAccountRuleCommand(emptyAccountRuleState(OWNER), { ...all, confirmAllScope: true }, accounts, NOW);
    expect(() => reduceAccountRuleCommand(saved, { type: "set_rule_active", expectedRevision: 1, requestId: "enable-all", ruleId: RULE, active: true }, accounts, NOW)).toThrow("Confirm explicitly");
    expect(() => reduceAccountRuleCommand(emptyAccountRuleState(OWNER), create(), [], NOW)).toThrow("owned by this signed-in profile");
    expect(() => reduceAccountRuleCommand(saved, create(), accounts, NOW)).toThrow("changed");
    expect(accountRuleCommandSchema.safeParse({ ...create(), ownerId: "forged" }).success).toBe(false);
    expect(accountRuleCommandSchema.safeParse({ ...create(), rule: { ...create().rule, merchantExact: "x".repeat(2001) } }).success).toBe(false);
    expect(accountRuleCommandSchema.safeParse({ ...create(), rule: { ...create().rule, importProvenance: { namespace: "forged", sourceId: "forged" } } }).success).toBe(false);
  });

  it("refuses provider-only bindings, wrong currency and silent rebinding", () => {
    const command = { type: "save_binding" as const, expectedRevision: 0, requestId: "binding", binding: { id: RULE, accountId: "account-a", provider: " GCB ", accountSuffix: "0543", currency: "GHS", active: true } };
    const saved = reduceAccountRuleCommand(emptyAccountRuleState(OWNER), command, accounts, NOW);
    expect(saved.bindings[0].provider).toBe("gcb");
    expect(() => reduceAccountRuleCommand(saved, { ...command, expectedRevision: 1, binding: { ...command.binding, id: NEXT, accountId: "account-b" } }, accounts, NOW)).toThrow("already identify another binding");
    expect(() => reduceAccountRuleCommand(emptyAccountRuleState(OWNER), { ...command, binding: { ...command.binding, currency: "USD" } }, accounts, NOW)).toThrow("currency");
    expect(accountRuleCommandSchema.safeParse({ ...command, binding: { ...command.binding, accountSuffix: "" } }).success).toBe(false);
  });

  it("permits removal or disabling of an owner's orphaned rule while refusing to re-enable it", () => {
    const current = { ...state(), revision: 1 };
    expect(reduceAccountRuleCommand(current, { type: "delete_rule", ruleId: RULE, expectedRevision: 1, requestId: "remove-orphan" }, [], NOW).rules).toEqual([]);
    expect(reduceAccountRuleCommand(current, { type: "set_rule_active", ruleId: RULE, active: false, expectedRevision: 1, requestId: "disable-orphan" }, [], NOW).rules[0].active).toBe(false);
    expect(() => reduceAccountRuleCommand(current, { type: "set_rule_active", ruleId: RULE, active: true, expectedRevision: 1, requestId: "enable-orphan" }, [], NOW)).toThrow("owned by this signed-in profile");
  });

  it("returns migration-required without writes when unavailable and rejects a cross-owner stored document", async () => {
    mocks.query.mockResolvedValueOnce([{ ready: false }]);
    expect(await saveAccountRuleCommand({} as SupabaseSettings, OWNER, create())).toMatchObject({ availability: "migration-required", state: { revision: 0 } });
    expect(mocks.query).toHaveBeenCalledTimes(1);
    mocks.query.mockResolvedValueOnce([{ ready: true }]).mockResolvedValueOnce([{ state: { ...state(), ownerId: "other" } }]);
    await expect(loadAccountRules({} as SupabaseSettings, OWNER)).rejects.toThrow("different owner");
  });

  it("atomically persists a validated command, supplies session ownership, and treats repeat request IDs idempotently", async () => {
    const command = create();
    mocks.query.mockImplementation(async (_settings, sql: string, values: unknown[]) => {
      if (sql.startsWith("select to_regclass")) return [{ ready: true }];
      if (sql.startsWith("select state from")) return [];
      if (sql.startsWith("select action_fingerprint")) return [];
      if (sql.startsWith("select state->")) return [{ accounts }];
      if (sql.startsWith("select public.alfred_write_account_rules")) return [{ result: { status: "saved", state: JSON.parse(String(values[4])) } }];
      throw new Error("Unexpected synthetic query");
    });
    const saved = await saveAccountRuleCommand({} as SupabaseSettings, OWNER, command);
    expect(saved.state).toMatchObject({ ownerId: OWNER, revision: 1 });
    const write = mocks.query.mock.calls.at(-1)!;
    expect(write[2][0]).toBe(OWNER);
    expect(write[2][3]).toMatch(/^[a-f0-9]{64}$/);
    const fingerprint = write[2][3];
    mocks.query.mockReset().mockResolvedValueOnce([{ ready: true }]).mockResolvedValueOnce([{ state: saved.state }]).mockResolvedValueOnce([{ action_fingerprint: fingerprint }]);
    expect((await saveAccountRuleCommand({} as SupabaseSettings, OWNER, command)).state).toEqual(saved.state);
    expect(mocks.query).toHaveBeenCalledTimes(3);
    mocks.query.mockReset().mockResolvedValueOnce([{ ready: true }]).mockResolvedValueOnce([{ state: saved.state }]).mockResolvedValueOnce([{ action_fingerprint: "different" }]);
    await expect(saveAccountRuleCommand({} as SupabaseSettings, OWNER, command)).rejects.toThrow("request ID");
  });
});
