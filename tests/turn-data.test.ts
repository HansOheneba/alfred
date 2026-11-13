import { describe, expect, it, vi } from "vitest";

import { MemoryMessageLog } from "@/lib/accounts/messages";
import { MemoryBankStore, type NewBankMessage } from "@/lib/bank/store";
import type { AccountRuleBotDeps } from "@/lib/account-rules/bot-command";
import { emptyAccountRuleState, type AccountRuleCommand } from "@/lib/account-rules/types";
import { trackTurnData } from "@/lib/conversation/turn-data";
import { ALFRED_SUPABASE_HOST, ALFRED_SUPABASE_PROJECT_REF, ALFRED_SUPABASE_USER } from "@/lib/config";
import { MemoryFinanceStore } from "@/lib/finance/memory-store";
import type { InterpretedAction } from "@/lib/finance/schemas";
import { MemoryInvestmentStore } from "@/lib/investments/store";
import { handleProfileTurn, type StudioDeps } from "@/lib/studio/handle";
import { expense, NOW, profile } from "./helpers";

function deps(store = new MemoryFinanceStore(), overrides: Partial<StudioDeps> = {}): StudioDeps {
  let id = 0;
  return {
    settings: {
      ai: { apiKey: "synthetic-only", model: "synthetic-only", strongModel: "synthetic-only" },
      google: null,
      supabase: { projectRef: ALFRED_SUPABASE_PROJECT_REF, host: ALFRED_SUPABASE_HOST, user: ALFRED_SUPABASE_USER, database: "postgres", password: "synthetic-only" },
      authorizedUserIds: [42], currency: "GHS", timezone: "Africa/Accra", confirmTransactions: "auto",
    },
    store, messages: new MemoryMessageLog(), now: () => NOW,
    interpret: async () => ({ type: "chat", message: "Synthetic reply." }),
    createId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
    createActionId: () => "synthetic-action-1",
    ...overrides,
  };
}

function rules(overrides: Partial<AccountRuleBotDeps> = {}): AccountRuleBotDeps {
  const ready = { state: emptyAccountRuleState("42"), availability: "ready" as const };
  return {
    load: async () => ready, accounts: async () => [], save: async () => ready, wasApplied: async () => false,
    now: () => NOW, token: () => "synthetictoken001", id: () => "00000000-0000-4000-8000-000000000001",
    pending: { put: async () => {}, get: async () => null, claim: async () => null, cancel: async () => false, complete: async () => {}, expire: async () => {} },
    ...overrides,
  };
}
const ruleCommand: AccountRuleCommand = { type: "set_rule_active", expectedRevision: 0, requestId: "synthetic-rule-request", ruleId: "00000000-0000-4000-8000-000000000001", active: false };
const transaction: InterpretedAction = {
  type: "create_transaction", explicit: true,
  transactions: [{ transaction_type: "expense", amount: "12.00", currency: "GHS", category: "Food", description: "Synthetic lunch", date: null, payment_method: null, notes: null }],
};

class ReportingMemoryStore extends MemoryFinanceStore {
  async listReportTransactions(ownerId: string) { return super.listTransactions(ownerId); }
}

describe("request-scoped turn read snapshots", () => {
  it("shares repeated in-flight reads only for the same owner and turn", async () => {
    const store = new MemoryFinanceStore();
    await store.appendTransaction(expense());
    await store.appendTransaction(expense({ userId: "43", transactionId: "synthetic-other-owner", description: "Other owner's fictional expense" }));
    const read = vi.spyOn(store, "listTransactions");
    const first = trackTurnData(deps(store));
    const own = first.deps.store.listTransactions("42");
    expect(first.deps.store.listTransactions("42")).toBe(own);
    const other = first.deps.store.listTransactions("43");
    expect(other).not.toBe(own);
    expect((await own).map(row => row.userId)).toEqual(["42"]);
    expect((await other).map(row => row.userId)).toEqual(["43"]);
    expect(read).toHaveBeenCalledTimes(2);
    const second = trackTurnData(deps(store));
    await second.deps.store.listTransactions("42");
    expect(read).toHaveBeenCalledTimes(3);
    expect(first.changed()).toBe(false); expect(second.changed()).toBe(false);
  });

  it.each(["transaction", "budget", "account rule"] as const)("invalidates raw and reporting reads after a confirmed %s write", async (kind) => {
    const store = new ReportingMemoryStore();
    const rawRead = vi.spyOn(store, "listTransactions");
    const reportRead = vi.spyOn(store, "listReportTransactions");
    const tracked = trackTurnData(deps(store, { accountRuleCommands: rules() }));
    const rawBefore = tracked.deps.store.listTransactions("42");
    const reportBefore = tracked.deps.store.listReportTransactions!("42");
    await Promise.all([rawBefore, reportBefore]);
    expect(tracked.deps.store.listTransactions("42")).toBe(rawBefore);
    expect(tracked.deps.store.listReportTransactions!("42")).toBe(reportBefore);
    if (kind === "transaction") await tracked.deps.store.appendTransaction(expense());
    if (kind === "budget") await tracked.deps.store.saveBudget({ budgetId: "synthetic-budget", userId: "42", period: "2026-10", category: "Food", amount: "100.00", currency: "GHS", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
    if (kind === "account rule") await tracked.deps.accountRuleCommands!.save("42", ruleCommand);
    expect(tracked.changed()).toBe(true);
    const rawAfter = tracked.deps.store.listTransactions("42");
    const reportAfter = tracked.deps.store.listReportTransactions!("42");
    expect(rawAfter).not.toBe(rawBefore); expect(reportAfter).not.toBe(reportBefore);
    await Promise.all([rawAfter, reportAfter]);
    expect(rawRead).toHaveBeenCalledTimes(2); expect(reportRead).toHaveBeenCalledTimes(2);
  });

  it("does not flag processed-update or pending-confirmation bookkeeping as a financial change", async () => {
    const tracked = trackTurnData(deps());
    const processed = await tracked.deps.store.appendProcessedUpdate({ updateId: "synthetic-update", userId: "42", status: "processing", resultReference: "{}", processedAt: NOW.toISOString() });
    await tracked.deps.store.updateProcessedUpdate(processed.rowNumber, { status: "completed" });
    const pending = await tracked.deps.store.appendPendingAction({ actionId: "synthetic-action-1", userId: "42", chatId: "0", actionType: "create_transaction", payloadJson: "{}", status: "pending", createdAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 60_000).toISOString() });
    await tracked.deps.store.updatePendingAction(pending.actionId, { status: "cancelled" });
    expect(tracked.changed()).toBe(false);
  });

  it("keeps a false deletion and duplicate bank-message null result unchanged", async () => {
    const bank = new MemoryBankStore();
    const message: NewBankMessage = { ownerId: "42", source: "gcb", channel: "manual", externalId: null, direction: "out", kind: "payment", amount: "10.00", fee: "0.00", currency: "GHS", counterparty: "Fictional shop", balance: null, occurredAt: NOW.toISOString(), status: "needs_label", raw: "Synthetic only", textHash: "synthetic-duplicate" };
    await bank.insertMessage(message);
    const tracked = trackTurnData(deps(undefined, { bank }));
    expect(await tracked.deps.store.deleteBudget("42", "missing-budget")).toBe(false);
    expect(await tracked.deps.bank!.insertMessage(message)).toBeNull();
    expect(tracked.changed()).toBe(false);
  });

  it("does not flag unavailable account-rule storage as a confirmed change", async () => {
    const tracked = trackTurnData(deps(undefined, { accountRuleCommands: rules({ save: async () => ({ state: emptyAccountRuleState("42"), availability: "migration-required" }) }) }));
    await tracked.deps.accountRuleCommands!.save("42", ruleCommand);
    expect(tracked.changed()).toBe(false);
  });

  it("does not flag rejected writes, but retains an earlier successful write if a later write fails", async () => {
    const store = new MemoryFinanceStore();
    store.failNextTransactionAppends(1);
    const tracked = trackTurnData(deps(store));
    await expect(tracked.deps.store.appendTransaction(expense())).rejects.toThrow("Simulated");
    expect(tracked.changed()).toBe(false);
    await tracked.deps.store.appendTransaction(expense());
    store.failNextTransactionAppends(1);
    await expect(tracked.deps.store.appendTransaction(expense({ transactionId: "synthetic-second" }))).rejects.toThrow("Simulated");
    expect(tracked.changed()).toBe(true);
    expect(await store.listTransactions("42")).toHaveLength(1);
  });

  it("does not flag an empty investment update that does not perform a write", async () => {
    const investments = new MemoryInvestmentStore();
    const investment = await investments.create("42", { name: "Fictional fund", kind: "mutual_fund" });
    const tracked = trackTurnData(deps(undefined, { investments }));
    const before = await investments.list("42");
    await tracked.deps.investments!.update("42", investment.id, {});
    expect(await investments.list("42")).toEqual(before);
    expect(tracked.changed()).toBe(false);
  });
});

describe("web chat refresh outcomes", () => {
  it.each<InterpretedAction>([{ type: "chat", message: "Synthetic conversation." }, { type: "get_spending_summary", period: "this_month", detail: "total" }])("keeps read-only $type turns and their retries unchanged", async action => {
    const interpret = vi.fn(async () => action);
    const context = deps(undefined, { interpret });
    const input = { text: "Tell me about my money", clientId: "synthetic-read-turn" };
    const first = await handleProfileTurn(profile(), input, context);
    const replay = await handleProfileTurn(profile(), input, context);
    expect(first.ledgerChanged).toBe(false); expect(replay.ledgerChanged).toBe(false);
    expect(first.messages?.find(row => row.role === "assistant")?.ledgerChanged).toBe(false);
    expect(interpret).toHaveBeenCalledTimes(1);
  });

  it("marks a recorded transaction, preserves that metadata on retry and never writes a duplicate", async () => {
    const store = new MemoryFinanceStore();
    const interpret = vi.fn(async () => transaction);
    const context = deps(store, { interpret });
    const input = { text: "Spent 12 on fictional lunch", clientId: "synthetic-record-turn" };
    const first = await handleProfileTurn(profile(), input, context);
    const replay = await handleProfileTurn(profile(), input, context);
    expect(first.ledgerChanged).toBe(true); expect(replay.ledgerChanged).toBe(true);
    expect(first.messages?.find(row => row.role === "assistant")?.ledgerChanged).toBe(true);
    expect(await store.listTransactions("42")).toHaveLength(1);
    expect(interpret).toHaveBeenCalledTimes(1);
  });

  it("refreshes after recovering a failed turn whose finance write committed before message saving failed", async () => {
    const store = new MemoryFinanceStore();
    const writes = vi.spyOn(store, "appendTransaction");
    const messages = new MemoryMessageLog();
    const append = messages.append.bind(messages);
    let failAssistant = true;
    vi.spyOn(messages, "append").mockImplementation(async message => {
      if (message.role === "assistant" && failAssistant) {
        failAssistant = false;
        throw new Error("Synthetic interruption after finance commit");
      }
      return append(message);
    });
    const context = deps(store, { messages, interpret: async () => transaction });
    const input = { text: "Spent 12 on fictional lunch", clientId: "synthetic-recovery-turn" };
    await expect(handleProfileTurn(profile(), input, context)).rejects.toThrow("Synthetic interruption");
    expect(await store.listTransactions("42")).toHaveLength(1);
    expect(writes).toHaveBeenCalledTimes(1);
    const recovered = await handleProfileTurn(profile(), input, context);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(await store.listTransactions("42")).toHaveLength(1);
    expect(recovered.ledgerChanged).toBe(true);
    expect(recovered.messages?.find(row => row.role === "assistant")?.ledgerChanged).toBe(true);
    const replay = await handleProfileTurn(profile(), input, context);
    expect(replay.ledgerChanged).toBe(true);
    expect(writes).toHaveBeenCalledTimes(1);
  });

  it.each(["confirm", "cancel"] as const)("keeps a draft unchanged and reports the actual %s outcome", async decision => {
    const store = new MemoryFinanceStore();
    const context = deps(store, { interpret: async () => transaction });
    context.settings = { ...context.settings, confirmTransactions: "always" };
    const draft = await handleProfileTurn(profile(), { text: "Spent 12 on fictional lunch", clientId: "synthetic-draft-turn" }, context);
    expect(draft.actionId).toBe("synthetic-action-1");
    expect(draft.ledgerChanged).toBe(false);
    expect(await store.listTransactions("42")).toHaveLength(0);
    const result = await handleProfileTurn(profile(), { decision, actionId: draft.actionId!, clientId: `synthetic-${decision}-turn` }, context);
    expect(result.ledgerChanged).toBe(decision === "confirm");
    expect(result.messages?.find(row => row.role === "assistant")?.ledgerChanged).toBe(decision === "confirm");
    expect(await store.listTransactions("42")).toHaveLength(decision === "confirm" ? 1 : 0);
  });
});

describe("notebook changes that affect the ledger", () => {
  it("counts an account note or a removed note as a ledger change, but not a plain note", async () => {
    const { MemoryNotebookStore } = await import("@/lib/notebook/store");
    const plain = trackTurnData(deps(undefined, { notebook: new MemoryNotebookStore() }));
    await plain.deps.notebook!.add("42", { note: "Prefers short replies" });
    expect(plain.changed()).toBe(false);
    expect(await plain.deps.notebook!.list("42")).toHaveLength(1);

    const account = trackTurnData(deps(undefined, { notebook: new MemoryNotebookStore() }));
    const saved = await account.deps.notebook!.add("42", { note: "Not my account", account: "1234" });
    expect(account.changed()).toBe(true);

    const removed = trackTurnData({ ...deps(), notebook: account.deps.notebook });
    await removed.deps.notebook!.remove("42", saved.id);
    expect(removed.changed()).toBe(true);
  });
});
