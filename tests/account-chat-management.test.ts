import { describe, expect, it, vi } from "vitest";

import { createMemoryAccountManagementStore, handleAccountManagement, executeAccountManagement, type AccountManagementStore } from "@/lib/accounts/management";
import { accountManagementActionSchema, accountManagementPendingSchema, type AccountManagementAction, type AccountManagementPending } from "@/lib/accounts/management-schema";
import type { ActionContext, Delivery } from "@/lib/finance/action-router";
import { emptyAccountingState, type FinancialAccount } from "@/lib/finance/accounting/types";
import { accountBalances } from "@/lib/finance/accounting/accounts";
import { MemoryFinanceStore } from "@/lib/finance/memory-store";
import { decidePending } from "@/lib/finance/pending";
import { profile } from "./helpers";

const OWNER = "fictional-account-owner";
const AT = "2026-11-05T12:00:00.000Z";
const account = (id: string, patch: Partial<FinancialAccount> = {}): FinancialAccount => ({ id, label: "Everyday wallet", provider: "Sample bank", currency: "GHS", includeInCash: true, createdAt: AT, ...patch });
function context(initial = emptyAccountingState(OWNER), store?: AccountManagementStore): ActionContext & { accountManagement: AccountManagementStore } {
  let sequence = 1;
  return { profile: profile(42, { profileId: OWNER }), store: new MemoryFinanceStore(), now: new Date(AT), updateId: 100, chatId: 42, confirmTransactions: "auto", pendingTtlMs: 900000,
    createId: () => `fictional-account-${sequence++}`, createActionId: () => `account-confirmation-${sequence++}`,
    accountManagement: store ?? createMemoryAccountManagementStore(initial, { now: () => AT }),
  };
}
const create: Extract<AccountManagementAction, { type: "create_account" }> = { type: "create_account", label: "Holiday wallet", provider: "Sample provider", currency: "GHS", include_in_cash: false };
async function pending(ctx: ActionContext, delivery: Delivery): Promise<AccountManagementPending> {
  if (delivery.kind !== "confirm") throw new Error(`Expected confirmation: ${delivery.text}`);
  const record = await ctx.store.getPendingAction(delivery.actionId);
  return accountManagementPendingSchema.parse(JSON.parse(record!.payloadJson));
}

describe("confirmed financial account chat management", () => {
  it("lists saved configuration without inventing balances or accepting a model-written owner", async () => {
    const initial = emptyAccountingState(OWNER); initial.accounts = [account("wallet")];
    const ctx = context(initial);
    const result = await handleAccountManagement(accountManagementActionSchema.parse({ type: "get_accounts", ownerId: "foreign-owner" }), ctx);
    expect(result.text).toContain("Everyday wallet"); expect(result.text).toContain("Sample bank"); expect(result.text).toContain("GHS"); expect(result.text).toContain("included in cash balance");
    expect(result.text).not.toContain("0.00"); expect(result.text).not.toContain("foreign-owner");
    expect((await ctx.accountManagement.read(OWNER)).state.revision).toBe(0);
  });
  it("asks for missing currency, provider and cash inclusion without preparing a write", async () => {
    const ctx = context();
    const result = await handleAccountManagement({ type: "create_account", label: "Holiday wallet" }, ctx);
    expect(result.kind).toBe("text"); expect(result.text).toContain("provider"); expect(result.text).toContain("currency"); expect(result.text).toContain("whether to include");
    expect(await ctx.store.listPendingActions(OWNER)).toEqual([]);
    expect((await ctx.accountManagement.read(OWNER)).state.accounts).toEqual([]);
  });
  it("creates only after the exact reviewed configuration is confirmed, including explicit false cash inclusion", async () => {
    const ctx = context();
    const proposal = await handleAccountManagement(create, ctx);
    expect(proposal.kind).toBe("confirm"); expect(proposal.text).toContain("Holiday wallet"); expect(proposal.text).toContain("excluded from cash balance");
    expect((await ctx.accountManagement.read(OWNER)).state.accounts).toHaveLength(0);
    const payload = await pending(ctx, proposal);
    expect(payload.command.expectedRevision).toBe(0);
    expect(payload.command.requestId).toMatch(/^chat-account:/);
    if (proposal.kind !== "confirm") throw new Error("Expected confirmation");
    const outcome = await decidePending({ actionId: proposal.actionId, chatId: String(ctx.chatId), decision: "confirm" }, ctx);
    expect(outcome.text).toContain("Account created");
    const state = (await ctx.accountManagement.read(OWNER)).state;
    expect(state.accounts).toEqual([expect.objectContaining({ label: create.label, provider: create.provider, currency: "GHS", includeInCash: false })]);
    expect(state.snapshots).toEqual([]); expect(state.revision).toBe(1);
  });
  it("does not create an account after cancellation", async () => {
    const ctx = context(); const proposal = await handleAccountManagement(create, ctx);
    if (proposal.kind !== "confirm") throw new Error("Expected confirmation");
    await decidePending({ actionId: proposal.actionId, chatId: String(ctx.chatId), decision: "cancel" }, ctx);
    expect((await ctx.accountManagement.read(OWNER)).state.accounts).toEqual([]);
  });
  it("rejects stale confirmations using the reviewed revision rather than rebasing the change", async () => {
    const ctx = context(); const proposal = await handleAccountManagement(create, ctx); const payload = await pending(ctx, proposal);
    await ctx.accountManagement.save(OWNER, { type: "create_account", expectedRevision: 0, requestId: "another-reviewed-request", account: { id: "other", label: "Other wallet", provider: "Sample bank", currency: "GHS", includeInCash: true } });
    const outcome = await executeAccountManagement(payload, ctx);
    expect(outcome.text).toContain("changed after the review");
    const state = (await ctx.accountManagement.read(OWNER)).state;
    expect(state.accounts.map(item => item.label)).toEqual(["Other wallet"]); expect(state.revision).toBe(1);
  });
  it("makes repeated confirmation of the same command idempotent", async () => {
    const ctx = context(); const payload = await pending(ctx, await handleAccountManagement(create, ctx));
    await executeAccountManagement(payload, ctx); await executeAccountManagement(payload, ctx);
    const state = (await ctx.accountManagement.read(OWNER)).state;
    expect(state.accounts).toHaveLength(1); expect(state.revision).toBe(1); expect(state.audit).toHaveLength(1);
  });
  it("asks for an exact account ID when a label is ambiguous", async () => {
    const initial = emptyAccountingState(OWNER); initial.accounts = [account("first"), account("second", { provider: "Another sample bank" })];
    const ctx = context(initial);
    const result = await handleAccountManagement({ type: "update_account", name: "everyday wallet", changes: { include_in_cash: false } }, ctx);
    expect(result.kind).toBe("text"); expect(result.text).toContain("More than one"); expect(result.text).toContain("first"); expect(result.text).toContain("second");
    expect(await ctx.store.listPendingActions(OWNER)).toEqual([]);
    const proposal = await handleAccountManagement({ type: "update_account", account_id: "second", changes: { include_in_cash: false } }, ctx);
    await executeAccountManagement(await pending(ctx, proposal), ctx);
    const state = (await ctx.accountManagement.read(OWNER)).state;
    expect(state.accounts.map(item => item.includeInCash)).toEqual([true, false]);
  });
  it("reviews exact metadata and cash-inclusion changes while preserving source balances", async () => {
    const initial = emptyAccountingState(OWNER); initial.accounts = [account("wallet")];
    initial.snapshots = [{ id: "reported", accountId: "wallet", balanceMinor: 12345, occurredAt: AT, sourceId: "fictional-statement", sourceMovementId: null }];
    const ctx = context(initial);
    const proposal = await handleAccountManagement({ type: "update_account", account_id: "wallet", changes: { label: "Bills wallet", provider: "Sample credit union", include_in_cash: false } }, ctx);
    expect(proposal.text).toContain("Everyday wallet → Bills wallet"); expect(proposal.text).toContain("Sample bank → Sample credit union"); expect(proposal.text).toContain("included in cash balance → excluded from cash balance");
    const payload = await pending(ctx, proposal); await executeAccountManagement(payload, ctx);
    const state = (await ctx.accountManagement.read(OWNER)).state;
    expect(state.accounts[0]).toMatchObject({ label: "Bills wallet", provider: "Sample credit union", includeInCash: false, currency: "GHS" });
    expect(state.snapshots).toEqual(initial.snapshots);
    expect(accountBalances(initial, "GHS").totalMinor).toBe(12345);
    expect(accountBalances(state, "GHS")).toMatchObject({ count: 0, excludedCount: 1, totalMinor: null });
  });
  it("does not expose or write foreign owner state, including after a pending confirmation was prepared", async () => {
    const foreign = emptyAccountingState("foreign-owner"); foreign.accounts = [account("secret", { label: "Private other account" })];
    const save = vi.fn(); const ctx = context(emptyAccountingState(OWNER), { read: async () => ({ state: foreign, availability: "ready" }), save });
    const result = await handleAccountManagement({ type: "get_accounts" }, ctx);
    expect(result.text).not.toContain("Private other account"); expect(result.text).toContain("session"); expect(save).not.toHaveBeenCalled();
    const own = context(); const payload = await pending(own, await handleAccountManagement(create, own));
    const outcome = await executeAccountManagement(payload, ctx);
    expect(outcome.text).toContain("session"); expect(save).not.toHaveBeenCalled();
  });
  it("fails closed when accounting is unavailable at proposal or confirmation time", async () => {
    const initial = emptyAccountingState(OWNER);
    const ctx = context(initial, createMemoryAccountManagementStore(initial, { availability: "migration-required" }));
    expect((await handleAccountManagement(create, ctx)).text).toContain("accounting setup"); expect(await ctx.store.listPendingActions(OWNER)).toEqual([]);
    const own = context(); const payload = await pending(own, await handleAccountManagement(create, own));
    expect((await executeAccountManagement(payload, ctx)).text).toContain("accounting setup");
    expect((await ctx.accountManagement.read(OWNER)).state.accounts).toEqual([]);
  });
  it("cannot change account currency or submit arbitrary source/movement operations through these schemas", () => {
    expect(accountManagementActionSchema.safeParse({ type: "update_account", account_id: "wallet", changes: { currency: "USD" } }).success).toBe(false);
    expect(accountManagementPendingSchema.safeParse({ type: "update_account", originUpdateId: "100", command: { type: "record_snapshot", expectedRevision: 0, requestId: "not-supported", snapshot: {} } }).success).toBe(false);
  });
});
