import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyAccountRuleState, type AccountRuleState } from "@/lib/account-rules/types";
import type { SupabaseSettings } from "@/lib/config";
import { loadAccountingState } from "@/lib/finance/accounting/persisted-store";
import { emptyAccountingState } from "@/lib/finance/accounting/types";

const mocks = vi.hoisted(() => ({ query: vi.fn(), raw: vi.fn(), messages: vi.fn() }));
vi.mock("@/lib/supabase/connection", () => ({ query: mocks.query }));
vi.mock("@/lib/supabase/finance-store", () => ({ listRawTransactions: mocks.raw }));
vi.mock("@/lib/bank/store", () => ({ createSupabaseBankStore: () => ({ listMessages: mocks.messages }) }));
const OWNER = "00000000-0000-4000-8000-000000000001";
const RULE = "00000000-0000-4000-8000-000000000010";
const NOW = "2026-11-02T12:00:00.000Z";
function rules(): AccountRuleState {
  return {
    ...emptyAccountRuleState(OWNER), revision: 1,
    rules: [{ id: RULE, accountId: "account-a", matchMode: "exact", merchantExact: "synthetic merchant", direction: "out", category: "My custom category", active: true, priority: 0, effectiveFrom: NOW, createdAt: NOW, revision: 1 }],
    bindings: [{ id: RULE, accountId: "account-a", provider: "gcb", accountSuffix: "0543", currency: "GHS", active: true, createdAt: NOW, revision: 1 }],
  };
}
describe("account rules in coherent accounting source hydration", () => {
  beforeEach(() => {
    mocks.raw.mockReset().mockResolvedValue([]);
    mocks.messages.mockReset().mockResolvedValue([{ id: "bank-source", ownerId: OWNER, source: "gcb", channel: "manual", externalId: null, direction: "out", kind: "payment", amount: "10.00", fee: "0.20", currency: "GHS", counterparty: "Synthetic Merchant", balance: "900.00", occurredAt: NOW, status: "needs_label", transactionId: null, feeTransactionId: null, askedAt: null, raw: "Synthetic payment. Your A/C No:XXXX0543", readBy: "rules" }]);
    mocks.query.mockReset().mockImplementation(async (_settings, sql: string) => {
      if (sql.includes("as portability_ready")) return [{ ready: true, portability_ready: false }];
      if (sql.startsWith("select public.alfred_accounting_source_version")) return [{ version: "sources-and-rules-v1" }];
      if (sql.startsWith("select state from public.accounting_states")) return [{ state: { ...emptyAccountingState(OWNER), accounts: [{ id: "account-a", label: "Everyday", provider: "GCB", currency: "GHS", includeInCash: true, createdAt: NOW }] } }];
      if (sql.startsWith("select to_regclass('public.account_rule_states')")) return [{ ready: true }];
      if (sql.startsWith("select state from public.account_rule_states")) return [{ state: rules() }];
      throw new Error("Unexpected synthetic SQL");
    });
  });
  it("binds a future source only from an explicit tuple, categorises without confirming, and records its authoritative balance snapshot", async () => {
    const result = await loadAccountingState({} as SupabaseSettings, OWNER);
    expect(result.state.movements[0]).toMatchObject({ accountId: "account-a", category: "My custom category", categoryOrigin: "account_rule", status: "review", sourceCategory: "Uncategorized", amountMinor: 1000, feeMinor: 20 });
    expect(result.state.snapshots[0]).toMatchObject({ accountId: "account-a", balanceMinor: 90000, sourceMovementId: "bank:bank-source" });
    const sourceCalls = mocks.query.mock.calls.filter(([, sql]) => sql.startsWith("select public.alfred_accounting_source_version"));
    expect(sourceCalls).toHaveLength(2);
    expect(mocks.query.mock.calls.findIndex(([, sql]) => sql.startsWith("select state from public.account_rule_states"))).toBeLessThan(mocks.query.mock.calls.lastIndexOf(sourceCalls[1]));
  });
  it("fails closed if the source/rule version changes during the read", async () => {
    const previous = mocks.query.getMockImplementation()!; let versions = 0;
    mocks.query.mockImplementation(async (...args) => args[1].startsWith("select public.alfred_accounting_source_version") ? [{ version: ++versions === 1 ? "before" : "after-rule-edit" }] : previous(...args));
    await expect(loadAccountingState({} as SupabaseSettings, OWNER)).rejects.toThrow("Source records changed while loading");
  });
});
