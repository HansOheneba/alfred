import { describe, expect, it, vi } from "vitest";

import { MemoryMessageLog } from "@/lib/accounts/messages";
import type { InterpretRequest } from "@/lib/ai/model";
import { converse } from "@/lib/conversation/turn";
import { applyFollowUp } from "@/lib/finance/conversation";
import { buildSystemPrompt } from "@/lib/ai/prompts";
import { handleAction, type ActionContext } from "@/lib/finance/action-router";
import { interpretWithContext } from "@/lib/finance/context";
import { MemoryFinanceStore } from "@/lib/finance/memory-store";
import { decidePending } from "@/lib/finance/pending";
import { parseModelOutput, type FinanceAction } from "@/lib/finance/schemas";
import { expense, profile } from "./helpers";

const now = new Date("2026-11-05T14:00:00.000Z");
function setup() {
  const store = new MemoryFinanceStore();
  let sequence = 0;
  const ctx: ActionContext = {
    profile: profile(), store, now, updateId: 17, chatId: 100,
    confirmTransactions: "auto", pendingTtlMs: 600_000,
    createId: () => `8f02f5de-1111-4111-8111-${String(++sequence).padStart(12, "0")}`,
    createActionId: () => `action${++sequence}`,
  };
  return { store, ctx };
}
const combined = (budget: { amount: string; currency?: string | null; period?: string | null }): FinanceAction => ({
  type: "create_category", name: "Shopping", transaction_type: "expense", budget,
});
async function confirm(action: FinanceAction, ctx: ActionContext) {
  const question = await handleAction(action, ctx);
  expect(question.kind).toBe("confirm");
  if (question.kind !== "confirm") throw new Error(question.text);
  return { question, result: await decidePending({ decision: "confirm", actionId: question.actionId, chatId: "100" }, ctx) };
}

describe("conversational category and budget management", () => {
  it("offers to create a missing category with the budget in one card, in their currency for this month", async () => {
    const { store, ctx } = setup();
    const messages = new MemoryMessageLog();
    const interpret = vi.fn(async (): Promise<FinanceAction> => ({ type: "set_budget", category: "Shopping", amount: "2000.00", currency: null, period: null }));
    const deps = { store, messages, interpret, createId: ctx.createId };
    async function turn(text: string) {
      const reply = await converse(text, ctx, deps, { channel: "web" });
      await messages.append({ ownerId: "42", role: "user", body: text, channel: "web" });
      await messages.append({ ownerId: "42", role: "assistant", body: reply.text, channel: "web", intent: reply.intent });
      return reply;
    }
    const confirmation = await turn("Set a budget for shopping for 2,000");
    expect(confirmation.kind).toBe("confirm");
    expect(confirmation.text).toContain("Create the Shopping expense category");
    expect(confirmation.text).toContain("GH₵2,000.00 for November 2026");
    expect(await store.listCategories("42")).toEqual([]);
    expect(await store.listBudgets("42")).toEqual([]);
    expect((await turn("yes")).text).toContain("Shopping is an expense category");
    expect(await store.listCategories("42")).toHaveLength(1);
    expect(await store.listBudgets("42")).toMatchObject([{ category: "Shopping", amount: "2000.00", currency: "GHS", period: "2026-11" }]);
    expect(interpret).toHaveBeenCalledTimes(1);
  });

  it("keeps a Yes that failed to save open, so tapping it again works", async () => {
    const { store, ctx } = setup();
    const question = await handleAction(combined({ amount: "2000.00" }), ctx);
    if (question.kind !== "confirm") throw new Error(question.text);
    const create = store.createCategory.bind(store);
    store.createCategory = async () => { throw new Error("Custom categories are not ready. Nothing was changed."); };
    await expect(decidePending({ decision: "confirm", actionId: question.actionId, chatId: "100" }, ctx)).rejects.toThrow("not ready");
    expect((await store.getPendingAction(question.actionId))?.status).toBe("pending");
    store.createCategory = create;
    expect((await decidePending({ decision: "confirm", actionId: question.actionId, chatId: "100" }, ctx)).text).toContain("Shopping is an expense category");
    expect(await store.listBudgets("42")).toHaveLength(1);
  });

  it("retains named custom categories in follow-up summaries with punctuation", () => {
    const custom = ["Shopping", "Travel (work)", "R&D.2"].map((name, index) => ({ categoryId: String(index), userId: "42", name, type: "expense" as const, createdAt: now.toISOString(), rowNumber: index }));
    const context = { rangeStart: "2026-11-01", rangeEnd: "2026-11-30", category: "Food", detail: "total" as const, summaryKind: "spending" as const, transactionId: null, pendingActionId: null };
    for (const category of custom) {
      const action: FinanceAction = { type: "get_spending_summary", category: category.name, period: "this_month" };
      const text = `What did I spend on ${category.name}?`;
      expect(applyFollowUp(text, action, context, custom)).toMatchObject({ category: category.name, detail: "total", start_date: "2026-11-01" });
      expect(applyFollowUp(text, action, null, custom)).toMatchObject({ category: category.name, detail: "total", period: "this_month" });
    }
    expect(applyFollowUp("What did I spend on R&Dx2?", { type: "get_spending_summary" }, null, custom)).toMatchObject({ category: null, detail: "by_category" });
  });

  it("does not overwrite a budget introduced while category confirmation is open", async () => {
    const { store, ctx } = setup();
    const question = await handleAction(combined({ amount: "2000.00", currency: "GHS", period: "2026-12" }), ctx);
    if (question.kind !== "confirm") throw new Error(question.text);
    await store.saveBudget({ budgetId: ctx.createId(), userId: "42", category: "Shopping", amount: "900.00", currency: "GHS", period: "2026-12", createdAt: now.toISOString(), updatedAt: now.toISOString() });
    const reply = await decidePending({ decision: "confirm", actionId: question.actionId, chatId: "100" }, ctx);
    expect(reply.text).toContain("Nothing was changed");
    expect(await store.listCategories("42")).toEqual([]);
    expect((await store.listBudgets("42"))[0].amount).toBe("900.00");
    expect((await handleAction(combined({ amount: "2000.00", currency: "GHS", period: "2026-12" }), ctx)).text).toContain("already GH₵900.00");
  });
  it("keeps the category and amount and shows the default currency and month for a yes", async () => {
    const { store, ctx } = setup();
    const action = parseModelOutput(JSON.stringify({ type: "create_category", name: "Shopping", transaction_type: "expense", budget: { amount: "2,000", currency: null, period: null } }));
    expect(action.success).toBe(true);
    if (!action.success || action.data.type === "several") throw new Error("Invalid test action");
    const answer = await handleAction(action.data, ctx);
    expect(answer.kind).toBe("confirm");
    expect(answer.text).toContain("GH₵2,000.00 for November 2026");
    expect(await store.listCategories("42")).toEqual([]);
    expect(await store.listBudgets("42")).toEqual([]);
    const prompt = buildSystemPrompt({ today: "2026-11-05", timezone: "Africa/Accra", currency: "GHS", recent: [] });
    expect(prompt).toContain("Alfred can create custom categories");
    expect(prompt).toContain("not several actions");
    expect(prompt).toContain("Never refuse, ask which existing category");
  });

  it("creates a category and its budget only after one explicit confirmation", async () => {
    const { store, ctx } = setup();
    const question = await handleAction(combined({ amount: "2000.00", currency: "GHS", period: "2026-12" }), ctx);
    expect(question.kind).toBe("confirm");
    expect(question.text).toContain("Shopping");
    expect(question.text).toContain("GH₵2,000.00");
    expect(question.text).toContain("December 2026");
    expect(await store.listCategories("42")).toEqual([]);
    expect(await store.listBudgets("42")).toEqual([]);
    if (question.kind !== "confirm") throw new Error(question.text);
    const refused = await decidePending({ decision: "confirm", actionId: question.actionId, chatId: "100" }, { ...ctx, profile: profile(43) });
    expect(refused.text).toContain("isn't for this chat");
    expect(await store.listCategories("42")).toEqual([]);
    const saved = await decidePending({ decision: "confirm", actionId: question.actionId, chatId: "100" }, ctx);
    expect(saved.text).toContain("Shopping is an expense category");
    expect((await store.listCategories("42")).map(item => item.name)).toEqual(["Shopping"]);
    expect(await store.listBudgets("42")).toMatchObject([{ category: "Shopping", amount: "2000.00", currency: "GHS", period: "2026-12" }]);
    expect(await store.listBudgets("43")).toEqual([]);
    const repeat = await decidePending({ decision: "confirm", actionId: question.actionId, chatId: "100" }, ctx);
    expect(repeat.text).toBe("That was already confirmed.");
    expect(await store.listBudgets("42")).toHaveLength(1);
  });

  it("cancels the entire combined change", async () => {
    const { store, ctx } = setup();
    const question = await handleAction(combined({ amount: "2000.00", currency: "GHS", period: "2026-12" }), ctx);
    if (question.kind !== "confirm") throw new Error(question.text);
    await decidePending({ decision: "cancel", actionId: question.actionId, chatId: "100" }, ctx);
    expect(await store.listCategories("42")).toEqual([]);
    expect(await store.listBudgets("42")).toEqual([]);
  });

  it("makes custom categories usable for expense entry, reports, corrections and budgets", async () => {
    const { store, ctx } = setup();
    await confirm({ type: "create_category", name: "Shopping", transaction_type: "expense" }, ctx);
    const categories = await handleAction({ type: "get_categories", transaction_type: "expense" }, ctx);
    expect(categories.text).toContain("Shopping");
    const saved = await handleAction({ type: "create_transaction", explicit: true, transactions: [{ transaction_type: "expense", amount: "25.00", currency: "GHS", category: "shopping", description: "New shirt" }] }, ctx);
    expect(saved.text).toContain("Shopping");
    const spending = await handleAction({ type: "get_spending_summary", category: "Shopping", period: "this_month" }, ctx);
    expect(spending.text).toContain("GH₵25.00");
    await store.appendTransaction(expense({ sourceUpdateId: "fictional:food", transactionId: "8f02f5de-1111-4111-8111-999999999999" }));
    await confirm({ type: "correct_transaction", transaction_id: "8f02f5de-1111-4111-8111-999999999999", changes: { category: "Shopping" } }, ctx);
    expect((await store.listTransactions("42")).find(item => item.sourceUpdateId === "fictional:food")?.category).toBe("Shopping");
    await confirm({ type: "set_budget", category: "shopping", amount: "2000.00", currency: "GHS", period: "2026-11" }, ctx);
    const status = await handleAction({ type: "get_budget_status", category: "shopping", period: "2026-11" }, ctx);
    expect(status.text).toContain("GH₵1,975.00");
    const other = await handleAction({ type: "set_budget", category: "Shopping", amount: "2000.00", currency: "GHS", period: "2026-11" }, { ...ctx, profile: profile(43) });
    // Someone else's category isn't theirs: they're offered their own, and nothing is saved yet.
    expect(other.text).toContain("Create the Shopping expense category");
    expect(await store.listBudgets("43")).toEqual([]);
    expect(await store.listCategories("43")).toEqual([]);
  });

  it("fills a missing budget currency or month from their profile and today, and says so before saving", async () => {
    const { store, ctx } = setup();
    expect((await handleAction({ type: "set_budget", category: "Food", amount: "2000.00", period: "2026-12" }, ctx)).text).toContain("GH₵2,000.00 for December 2026");
    expect((await handleAction({ type: "set_budget", category: "Food", amount: "2000.00", currency: "USD" }, ctx)).text).toContain("for November 2026");
    expect(await store.listBudgets("42")).toEqual([]);
  });

  it("refuses alias collisions and income-category budgets without writes", async () => {
    const { store, ctx } = setup();
    expect((await handleAction({ type: "create_category", name: "Lunch", transaction_type: "expense" }, ctx)).text).toContain("built-in");
    expect((await handleAction({ type: "create_category", name: "Side projects", transaction_type: "income", budget: { amount: "2000.00", currency: "GHS", period: "2026-11" } }, ctx)).text).toContain("expense category");
    expect(await store.listCategories("42")).toEqual([]);
  });

  it("removes only an exact budget after confirmation, keeping transactions", async () => {
    const { store, ctx } = setup();
    await confirm({ type: "set_budget", category: "Food", amount: "800.00", currency: "GHS", period: "2026-11" }, ctx);
    await confirm({ type: "set_budget", category: "Food", amount: "700.00", currency: "GHS", period: "2026-12" }, ctx);
    await store.appendTransaction(expense());
    expect((await handleAction({ type: "delete_budget", category: "Food" }, ctx)).text).toContain("Which category, month and currency");
    const question = await handleAction({ type: "delete_budget", category: "Food", currency: "GHS", period: "2026-11" }, ctx);
    expect(question.kind).toBe("confirm");
    expect(await store.listBudgets("42")).toHaveLength(2);
    if (question.kind !== "confirm") throw new Error(question.text);
    const result = await decidePending({ decision: "confirm", actionId: question.actionId, chatId: "100" }, ctx);
    expect(result.text).toContain("Removed your Food budget for November");
    expect((await store.listBudgets("42")).map(item => item.period)).toEqual(["2026-12"]);
    expect(await store.listTransactions("42")).toHaveLength(1);
  });

  it("rejects a budget that changed after the deletion confirmation", async () => {
    const { store, ctx } = setup();
    await confirm({ type: "set_budget", category: "Food", amount: "800.00", currency: "GHS", period: "2026-11" }, ctx);
    const question = await handleAction({ type: "delete_budget", category: "Food", currency: "GHS", period: "2026-11" }, ctx);
    if (question.kind !== "confirm") throw new Error(question.text);
    const budget = (await store.listBudgets("42"))[0];
    await store.saveBudget({ ...budget, amount: "900.00", updatedAt: "2026-11-05T14:01:00.000Z" });
    const result = await decidePending({ decision: "confirm", actionId: question.actionId, chatId: "100" }, ctx);
    expect(result.text).toContain("changed since I asked");
    expect((await store.listBudgets("42"))[0].amount).toBe("900.00");
  });

  it("sends only the current owner's saved category names to interpretation", async () => {
    const { store, ctx } = setup();
    await store.createCategory({ categoryId: ctx.createId(), userId: "42", name: "Shopping", type: "expense", createdAt: now.toISOString() });
    await store.createCategory({ categoryId: ctx.createId(), userId: "43", name: "Private hobby", type: "expense", createdAt: now.toISOString() });
    const messages = new MemoryMessageLog();
    await messages.append({ ownerId: "42", role: "user", body: "Set a budget for shopping for 2,000", channel: "web" });
    await messages.append({ ownerId: "42", role: "assistant", body: "Would you like to create that category?", channel: "web" });
    const interpret = vi.fn(async (request: InterpretRequest) => {
      expect(request.text).toBe("Create a category and add it under that");
      return { type: "get_categories" as const };
    });
    await interpretWithContext({ text: "Create a category and add it under that", profile: ctx.profile, store, now, interpret, messages, channel: "web" });
    const request = interpret.mock.calls[0][0];
    expect(request.categories?.map(item => item.name)).toEqual(["Shopping"]);
    expect(request.history?.map(item => item.body)).toContain("Set a budget for shopping for 2,000");
  });
});
