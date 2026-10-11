import type { UserProfile } from "@/lib/config";
import { normalizeCategory } from "@/lib/finance/categories";
import {
  formatDisplayDate,
  formatRange,
  isSaneTransactionDate,
  monthRange,
  resolveQueryRange,
  shiftRangeBack,
  zonedYmd,
  type DateRange,
  type RelativePeriod,
} from "@/lib/finance/dates";
import { formatMinor } from "@/lib/finance/money";
import { budgetMath } from "@/lib/finance/budgets";
import { addContribution, matchGoals } from "@/lib/finance/savings";
import type { FinanceAction, PendingPayload } from "@/lib/finance/schemas";
import { pendingPayloadSchema } from "@/lib/finance/schemas";
import {
  inRange,
  largestExpenses,
  netByCurrency,
  totalsByCategory,
  totalsByCurrency,
} from "@/lib/finance/summaries";
import type { FinanceStore } from "@/lib/finance/store";
import {
  describeCandidates,
  findCandidates,
  normalizeDrafts,
  writeTransactions,
} from "@/lib/finance/transactions";
import type { TransactionDraft, TransactionRecord } from "@/lib/finance/types";
import {
  BALANCE_DISCLAIMER,
  formatBudgetLine,
  formatCategoryLines,
  formatGoal,
  formatLogged,
  formatMoneyAmount,
  formatMoneyLines,
  formatRangeLabel,
  formatWriteResult,
  helpText,
  oneLine,
  safeClarification,
  unknownCategoryMessage,
} from "@/lib/telegram/messages";

export type Delivery =
  | { kind: "text"; text: string }
  | { kind: "confirm"; text: string; actionId: string };

export type ActionContext = {
  profile: UserProfile;
  store: FinanceStore;
  now: Date;
  updateId: number;
  chatId: number;
  confirmTransactions: "auto" | "always";
  pendingTtlMs: number;
  createId: () => string;
  createActionId: () => string;
};

export async function handleAction(action: FinanceAction, ctx: ActionContext): Promise<Delivery> {
  switch (action.type) {
    case "help":
      return { kind: "text", text: helpText(ctx.profile.timezone) };
    case "clarify":
      return { kind: "text", text: safeClarification(action.question) };
    case "create_transaction":
      return createTransactions(action, ctx);
    case "get_spending_summary":
      return spendingSummary(action, ctx);
    case "get_income_summary":
      return incomeSummary(action, ctx);
    case "get_financial_overview":
      return overview(action, ctx);
    case "get_transaction_history":
      return history(action, ctx);
    case "set_budget":
      return setBudget(action, ctx);
    case "get_budget_status":
      return budgetStatus(action, ctx);
    case "create_savings_goal":
      return createGoal(action, ctx);
    case "update_savings_goal":
      return updateGoal(action, ctx);
    case "correct_transaction":
      return correctTransaction(action, ctx);
    case "delete_transaction":
      return deleteTransaction(action, ctx);
    default:
      return { kind: "text", text: "I couldn't match that to something I can do." };
  }
}

export async function executeConfirmed(payload: PendingPayload, ctx: ActionContext): Promise<string> {
  const userId = String(ctx.profile.telegramUserId);
  if (payload.type === "create_transaction") {
    const result = await writeTransactions({
      store: ctx.store,
      userId,
      drafts: payload.transactions,
      sourcePrefix: `update:${payload.originUpdateId}`,
      createId: ctx.createId,
      now: ctx.now,
    });
    return loggedReply(ctx, result);
  }
  if (payload.type === "delete_transaction") {
    const transactions = await ctx.store.listTransactions(userId);
    const target = transactions.find((item) => item.transactionId === payload.transactionId);
    if (!target) return "I couldn't find that transaction. Nothing was changed.";
    if (target.status === "deleted") return "That transaction was already removed from your totals.";
    await ctx.store.updateTransaction(userId, target.transactionId, { status: "deleted" });
    return `Deleted from your totals:\n${oneLine({ ...target, status: "deleted" })}\nThe row is still in the sheet.`;
  }
  const transactions = await ctx.store.listTransactions(userId);
  const target = transactions.find((item) => item.transactionId === payload.transactionId && item.status === "active");
  if (!target) return "I couldn't find that active transaction. Nothing was changed.";
  const today = zonedYmd(ctx.now, ctx.profile.timezone);
  const nextType = payload.changes.transactionType ?? target.type;
  let category = payload.changes.category ?? target.category;
  if (payload.changes.category || payload.changes.transactionType) {
    const normalized = normalizeCategory(category, nextType);
    if (!normalized) return unknownCategoryMessage(nextType);
    category = normalized;
  }
  if (payload.changes.date && !isSaneTransactionDate(payload.changes.date, today)) {
    return "That date isn't one I can store. Nothing was changed.";
  }
  const updated = await ctx.store.updateTransaction(userId, target.transactionId, {
    amount: payload.changes.amount,
    category,
    description: payload.changes.description,
    date: payload.changes.date,
    transactionType: payload.changes.transactionType,
  });
  return `Updated:\n${oneLine(updated)}`;
}

async function createTransactions(
  action: Extract<FinanceAction, { type: "create_transaction" }>,
  ctx: ActionContext,
): Promise<Delivery> {
  const today = zonedYmd(ctx.now, ctx.profile.timezone);
  const normalized = normalizeDrafts(action.transactions, ctx.profile, today);
  if (!normalized.ok) return { kind: "text", text: normalized.message };
  const needsConfirm = ctx.confirmTransactions === "always" || !action.explicit;
  if (needsConfirm) {
    return saveConfirmation(
      ctx,
      confirmCreateText(normalized.drafts),
      {
        type: "create_transaction",
        originUpdateId: String(ctx.updateId),
        transactions: normalized.drafts,
      },
    );
  }
  const result = await writeTransactions({
    store: ctx.store,
    userId: String(ctx.profile.telegramUserId),
    drafts: normalized.drafts,
    sourcePrefix: `update:${ctx.updateId}`,
    createId: ctx.createId,
    now: ctx.now,
  });
  return { kind: "text", text: await loggedReply(ctx, result) };
}

async function loggedReply(
  ctx: ActionContext,
  result: { succeeded: TransactionRecord[]; failed: { description: string; message: string }[] },
): Promise<string> {
  if (result.succeeded.length === 0) return formatWriteResult(result);
  const today = zonedYmd(ctx.now, ctx.profile.timezone);
  const lines = [formatLogged(result.succeeded, today), await monthPosition(ctx, today)];
  if (result.failed.length > 0) lines.push(formatWriteResult({ succeeded: [], failed: result.failed }));
  return lines.filter(Boolean).join("\n");
}

async function monthPosition(ctx: ActionContext, today: string): Promise<string> {
  const userId = String(ctx.profile.telegramUserId);
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const range = monthRange(year, month);
  const transactions = await ctx.store.listTransactions(userId);
  const income = inRange(transactions, { userId, range, type: "income" });
  const expenses = inRange(transactions, { userId, range, type: "expense" });
  const spent = totalsByCurrency(expenses);
  const earned = totalsByCurrency(income);
  const currency = spent[0]?.currency ?? earned[0]?.currency ?? ctx.profile.currency;
  const spentMinor = spent.find((item) => item.currency === currency)?.minor ?? 0;
  const earnedMinor = earned.find((item) => item.currency === currency)?.minor ?? 0;
  const spentText = formatMinor(spentMinor, currency);
  const position =
    earnedMinor > 0
      ? `You've spent ${spentText} so far — ${formatMinor(earnedMinor - spentMinor, currency)} left of ${formatMinor(earnedMinor, currency)}.`
      : `You've spent ${spentText} so far this month.`;
  const budgets = await ctx.store.listBudgets(userId);
  const notes = budgets.flatMap((budget) => {
    if (!budget.period.startsWith(today.slice(0, 7)) || budget.currency !== currency) return [];
    const math = budgetMath(budget, transactions);
    if (math.spentMinor < math.budgetMinor) return [];
    return [
      `${budget.category} is ${formatMinor(math.spentMinor, currency)} against its ${formatMinor(math.budgetMinor, currency)} goal.`,
    ];
  });
  return [position, ...notes].join(" ");
}

async function spendingSummary(
  action: Extract<FinanceAction, { type: "get_spending_summary" }>,
  ctx: ActionContext,
): Promise<Delivery> {
  const today = zonedYmd(ctx.now, ctx.profile.timezone);
  const resolved = resolveRange(action, today);
  if (!resolved.ok) return { kind: "text", text: resolved.message };
  const category = action.category ? normalizeCategory(action.category, "expense") : null;
  if (action.category && !category) return { kind: "text", text: unknownCategoryMessage("expense") };
  const transactions = await ctx.store.listTransactions(String(ctx.profile.telegramUserId));
  const detail = action.detail ?? (category ? "total" : "by_category");
  if (detail === "comparison") {
    return { kind: "text", text: comparisonText(transactions, ctx, resolved.range, category) };
  }
  const rows = inRange(transactions, {
    userId: String(ctx.profile.telegramUserId),
    range: resolved.range,
    type: "expense",
    category: category ?? undefined,
  });
  if (detail !== "largest") {
    return { kind: "text", text: await spokenSpend(ctx, resolved.range, rows, category, today) };
  }
  const label = category === "Savings" ? "Saved" : category ? `Spent on ${category}` : "Spent";
  const lines = [`${label} (${formatRangeLabel(resolved.range)}):`, formatMoneyLines(totalsByCurrency(rows), "No matching expenses.")];
  if (detail === "largest") {
    const top = largestExpenses(rows, 5);
    lines.push("", top.length ? "Biggest expenses:" : "No expenses in that range.");
    top.forEach((item, index) => lines.push(`${index + 1}. ${oneLine(item)}`));
  }
  if (category === "Savings") {
    const goals = await ctx.store.listSavingsGoals(String(ctx.profile.telegramUserId));
    if (goals.length > 0) {
      lines.push("", "Savings goals (recorded progress, not account balances):");
      goals.forEach((goal) => lines.push(formatGoal(goal)));
    }
  }
  lines.push("", BALANCE_DISCLAIMER);
  return { kind: "text", text: lines.join("\n") };
}

async function spokenSpend(
  ctx: ActionContext,
  range: DateRange,
  rows: TransactionRecord[],
  category: string | null,
  today: string,
): Promise<string> {
  const month = monthRange(Number(today.slice(0, 4)), Number(today.slice(5, 7)));
  const isThisMonth = range.start === month.start && range.end === month.end;
  if (!category && isThisMonth) {
    const position = await monthPosition(ctx, today);
    const categories = formatCategoryLines(totalsByCategory(rows));
    return categories.length === 0 ? position : [position, "", ...categories].join("\n");
  }
  const when = formatRangeLabel(range);
  if (rows.length === 0) return `No matching expenses for ${when}.`;
  const head = category
    ? `${formatMoneyLines(totalsByCurrency(rows), "No matching expenses.")} on ${category} for ${when}.`
    : `${formatMoneyLines(totalsByCurrency(rows), "No matching expenses.")} for ${when}.`;
  const lines = rows
    .slice(0, 8)
    .map((item) => `- ${formatMoneyAmount(item.amount, item.currency)} ${item.description} (${formatDisplayDate(item.transactionDate)})`);
  const extra = rows.length > 8 ? [`And ${rows.length - 8} more.`] : [];
  const parts = [head, ...lines, ...extra];
  if (category === "Savings") {
    const goals = await ctx.store.listSavingsGoals(String(ctx.profile.telegramUserId));
    if (goals.length > 0) parts.push("", ...goals.map((goal) => formatGoal(goal)));
  }
  return parts.join("\n");
}

function comparisonText(
  transactions: TransactionRecord[],
  ctx: ActionContext,
  range: DateRange,
  category: string | null,
): string {
  const userId = String(ctx.profile.telegramUserId);
  const previous = shiftRangeBack(range);
  const currentRows = inRange(transactions, { userId, range, type: "expense", category: category ?? undefined });
  const previousRows = inRange(transactions, {
    userId,
    range: previous,
    type: "expense",
    category: category ?? undefined,
  });
  const currentTotals = totalsByCurrency(currentRows);
  const previousTotals = totalsByCurrency(previousRows);
  const lines = [
    `Spending (${formatRange(range)})`,
    formatMoneyLines(currentTotals, "No matching expenses."),
    "",
    `Previous period (${formatRange(previous)})`,
    formatMoneyLines(previousTotals, "No matching expenses."),
  ];
  const currency = currentTotals[0]?.currency ?? previousTotals[0]?.currency;
  if (currency && currentTotals.length <= 1 && previousTotals.length <= 1) {
    const delta = (currentTotals[0]?.minor ?? 0) - (previousTotals[0]?.minor ?? 0);
    const change =
      delta === 0
        ? "no change"
        : delta > 0
          ? `${formatMinor(delta, currency)} more`
          : `${formatMinor(Math.abs(delta), currency)} less`;
    lines.push("", `Change: ${change}`);
  }
  lines.push("", BALANCE_DISCLAIMER);
  return lines.join("\n");
}

async function incomeSummary(
  action: Extract<FinanceAction, { type: "get_income_summary" }>,
  ctx: ActionContext,
): Promise<Delivery> {
  const today = zonedYmd(ctx.now, ctx.profile.timezone);
  const resolved = resolveRange(action, today);
  if (!resolved.ok) return { kind: "text", text: resolved.message };
  const category = action.category ? normalizeCategory(action.category, "income") : null;
  if (action.category && !category) return { kind: "text", text: unknownCategoryMessage("income") };
  const rows = inRange(await listOwn(ctx), {
    userId: String(ctx.profile.telegramUserId),
    range: resolved.range,
    type: "income",
    category: category ?? undefined,
  });
  const label = category ? `${category} income` : "Income";
  return {
    kind: "text",
    text: [
      `${label} (${formatRangeLabel(resolved.range)}):`,
      formatMoneyLines(totalsByCurrency(rows), "No matching income."),
      "",
      BALANCE_DISCLAIMER,
    ].join("\n"),
  };
}

async function overview(
  action: Extract<FinanceAction, { type: "get_financial_overview" }>,
  ctx: ActionContext,
): Promise<Delivery> {
  const today = zonedYmd(ctx.now, ctx.profile.timezone);
  const resolved = resolveRange(action, today);
  if (!resolved.ok) return { kind: "text", text: resolved.message };
  const userId = String(ctx.profile.telegramUserId);
  const transactions = await listOwn(ctx);
  const income = inRange(transactions, { userId, range: resolved.range, type: "income" });
  const expenses = inRange(transactions, { userId, range: resolved.range, type: "expense" });
  const incomeTotals = totalsByCurrency(income);
  const expenseTotals = totalsByCurrency(expenses);
  const lines = [
    `Financial summary (${formatRangeLabel(resolved.range)})`,
    "",
    "Income:",
    formatMoneyLines(incomeTotals, "No recorded income."),
    "",
    "Expenses:",
    formatMoneyLines(expenseTotals, "No recorded expenses."),
    "",
    "Recorded cash flow:",
    formatMoneyLines(netByCurrency(incomeTotals, expenseTotals), "No recorded cash flow."),
  ];
  const categories = formatCategoryLines(totalsByCategory(expenses));
  if (categories.length > 0) lines.push("", "Expenses by category:", ...categories);
  const budgets = await ctx.store.listBudgets(userId);
  if (budgets.length > 0) {
    lines.push("", "Budgets:");
    budgets.forEach((budget) => lines.push(formatBudgetLine(budget, budgetMath(budget, transactions))));
  }
  const goals = await ctx.store.listSavingsGoals(userId);
  if (goals.length > 0) {
    lines.push("", "Savings goals:");
    goals.forEach((goal) => lines.push(formatGoal(goal)));
  }
  lines.push("", BALANCE_DISCLAIMER);
  return { kind: "text", text: lines.join("\n") };
}

async function history(
  action: Extract<FinanceAction, { type: "get_transaction_history" }>,
  ctx: ActionContext,
): Promise<Delivery> {
  const today = zonedYmd(ctx.now, ctx.profile.timezone);
  const resolved = resolveRange(action, today);
  if (!resolved.ok) return { kind: "text", text: resolved.message };
  const type = undefined;
  const category = action.category
    ? normalizeCategory(action.category, "expense") ?? normalizeCategory(action.category, "income")
    : null;
  if (action.category && !category) {
    return { kind: "text", text: "I don't know that category for income or expenses." };
  }
  const rows = inRange(await listOwn(ctx), {
    userId: String(ctx.profile.telegramUserId),
    range: resolved.range,
    category: category ?? undefined,
    type,
  }).sort((left, right) => right.transactionDate.localeCompare(left.transactionDate) || right.createdAt.localeCompare(left.createdAt));
  const limit = action.limit ?? 10;
  const shown = rows.slice(0, limit);
  if (shown.length === 0) {
    return { kind: "text", text: `No recorded transactions from ${formatRangeLabel(resolved.range)}.` };
  }
  const lines = [`Transactions (${formatRangeLabel(resolved.range)}):`];
  shown.forEach((item, index) => lines.push(`${index + 1}. ${oneLine(item)}`));
  if (rows.length > shown.length) lines.push(`${rows.length - shown.length} more are not shown.`);
  return { kind: "text", text: lines.join("\n") };
}

async function setBudget(
  action: Extract<FinanceAction, { type: "set_budget" }>,
  ctx: ActionContext,
): Promise<Delivery> {
  const category = normalizeCategory(action.category, "expense");
  if (!category) return { kind: "text", text: unknownCategoryMessage("expense") };
  const today = zonedYmd(ctx.now, ctx.profile.timezone);
  const period = action.period ?? today.slice(0, 7);
  const timestamp = ctx.now.toISOString();
  const saved = await ctx.store.saveBudget({
    budgetId: ctx.createId(),
    userId: String(ctx.profile.telegramUserId),
    period,
    category,
    amount: action.amount,
    currency: action.currency,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return {
    kind: "text",
    text: `${saved.category} budget for ${saved.period} set to ${formatMoneyAmount(saved.amount, saved.currency)}.`,
  };
}

async function budgetStatus(
  action: Extract<FinanceAction, { type: "get_budget_status" }>,
  ctx: ActionContext,
): Promise<Delivery> {
  const today = zonedYmd(ctx.now, ctx.profile.timezone);
  const period = action.period ?? today.slice(0, 7);
  const category = action.category ? normalizeCategory(action.category, "expense") : null;
  if (action.category && !category) return { kind: "text", text: unknownCategoryMessage("expense") };
  const userId = String(ctx.profile.telegramUserId);
  const budgets = (await ctx.store.listBudgets(userId)).filter(
    (budget) => budget.period === period && (!category || budget.category === category),
  );
  if (budgets.length === 0) {
    return { kind: "text", text: `No ${category ? `${category} ` : ""}budget is set for ${period}.` };
  }
  const transactions = await listOwn(ctx);
  const lines = [`Budgets for ${period}:`];
  budgets.forEach((budget) => lines.push(formatBudgetLine(budget, budgetMath(budget, transactions))));
  lines.push("", BALANCE_DISCLAIMER);
  return { kind: "text", text: lines.join("\n") };
}

async function createGoal(
  action: Extract<FinanceAction, { type: "create_savings_goal" }>,
  ctx: ActionContext,
): Promise<Delivery> {
  const timestamp = ctx.now.toISOString();
  const goal = await ctx.store.appendSavingsGoal({
    goalId: ctx.createId(),
    userId: String(ctx.profile.telegramUserId),
    name: action.name.trim(),
    targetAmount: action.target_amount,
    currentAmount: action.current_amount ?? "0.00",
    currency: action.currency,
    targetDate: action.target_date ?? "",
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return {
    kind: "text",
    text: `Savings goal saved: ${goal.name}\nTarget: ${formatMoneyAmount(goal.targetAmount, goal.currency)}\nCurrently recorded: ${formatMoneyAmount(goal.currentAmount, goal.currency)}\nThis tracks the goal. It is not an account balance.`,
  };
}

async function updateGoal(
  action: Extract<FinanceAction, { type: "update_savings_goal" }>,
  ctx: ActionContext,
): Promise<Delivery> {
  const goals = await ctx.store.listSavingsGoals(String(ctx.profile.telegramUserId));
  const matches = matchGoals(goals, { goalId: action.goal_id, name: action.name });
  if (matches.length === 0) return { kind: "text", text: "I couldn't find that savings goal." };
  if (matches.length > 1) {
    return {
      kind: "text",
      text: `Which goal do you mean?\n${matches.map((goal) => goal.name).join("\n")}`,
    };
  }
  const goal = matches[0];
  const currentAmount = action.contribution
    ? addContribution(goal.currentAmount, action.contribution)
    : (action.set_current_amount ?? goal.currentAmount);
  const updated = await ctx.store.updateSavingsGoal(goal.userId, goal.goalId, {
    currentAmount,
    targetAmount: action.target_amount ?? goal.targetAmount,
    targetDate: action.target_date ?? goal.targetDate,
    status: action.status ?? goal.status,
  });
  return {
    kind: "text",
    text: `${formatGoal(updated)}\nThis is recorded progress toward the goal, not money moving in a bank account.`,
  };
}

async function correctTransaction(
  action: Extract<FinanceAction, { type: "correct_transaction" }>,
  ctx: ActionContext,
): Promise<Delivery> {
  const transactions = await listOwn(ctx);
  const matches = findCandidates(transactions, {
    transactionId: action.transaction_id,
    descriptionQuery: action.description_query,
  });
  if (matches.length === 0) return { kind: "text", text: "I couldn't find one matching transaction." };
  if (matches.length > 1) return { kind: "text", text: describeCandidates(matches) };
  const target = matches[0];
  const today = zonedYmd(ctx.now, ctx.profile.timezone);
  const changes: {
    amount?: string;
    category?: string;
    description?: string;
    date?: string;
    transactionType?: "income" | "expense";
  } = {};
  if (action.changes.amount) changes.amount = action.changes.amount;
  if (action.changes.description) changes.description = action.changes.description;
  if (action.changes.date) {
    if (!isSaneTransactionDate(action.changes.date, today)) {
      return { kind: "text", text: "That date isn't one I can store." };
    }
    changes.date = action.changes.date;
  }
  if (action.changes.transaction_type) changes.transactionType = action.changes.transaction_type;
  const nextType = changes.transactionType ?? target.type;
  if (action.changes.category) {
    const category = normalizeCategory(action.changes.category, nextType);
    if (!category) return { kind: "text", text: unknownCategoryMessage(nextType) };
    changes.category = category;
  }
  if (Object.keys(changes).length === 0) {
    return { kind: "text", text: "What should I change on that transaction?" };
  }
  const text = [
    "Update this transaction?",
    oneLine(target),
    describeChanges(target, changes),
    "",
    "Confirm or cancel.",
  ].join("\n");
  return saveConfirmation(ctx, text, {
    type: "correct_transaction",
    originUpdateId: String(ctx.updateId),
    transactionId: target.transactionId,
    changes,
  });
}

async function deleteTransaction(
  action: Extract<FinanceAction, { type: "delete_transaction" }>,
  ctx: ActionContext,
): Promise<Delivery> {
  const matches = findCandidates(await listOwn(ctx), {
    transactionId: action.transaction_id,
    descriptionQuery: action.description_query,
    undoLast: action.undo_last,
  });
  if (matches.length === 0) return { kind: "text", text: "I couldn't find a transaction to delete." };
  if (matches.length > 1) return { kind: "text", text: describeCandidates(matches) };
  const target = matches[0];
  return saveConfirmation(
    ctx,
    ["Delete this transaction?", oneLine(target), "", "This keeps the row but removes it from totals.", "Confirm or cancel."].join(
      "\n",
    ),
    {
      type: "delete_transaction",
      originUpdateId: String(ctx.updateId),
      transactionId: target.transactionId,
    },
  );
}

function describeChanges(
  target: TransactionRecord,
  changes: {
    amount?: string;
    category?: string;
    description?: string;
    date?: string;
    transactionType?: "income" | "expense";
  },
): string {
  const lines: string[] = [];
  if (changes.amount) lines.push(`Amount: ${formatMoneyAmount(target.amount, target.currency)} → ${formatMoneyAmount(changes.amount, target.currency)}`);
  if (changes.category) lines.push(`Category: ${target.category} → ${changes.category}`);
  if (changes.description) lines.push(`Description: ${target.description} → ${changes.description}`);
  if (changes.date) lines.push(`Date: ${formatDisplayDate(target.transactionDate)} → ${formatDisplayDate(changes.date)}`);
  if (changes.transactionType) lines.push(`Type: ${target.type} → ${changes.transactionType}`);
  return lines.join("\n");
}

function confirmCreateText(drafts: TransactionDraft[]): string {
  const lines = [drafts.length === 1 ? "Save this?" : `Save these ${drafts.length} transactions?`];
  drafts.forEach((draft, index) => {
    const prefix = drafts.length > 1 ? `${index + 1}. ` : "";
    lines.push(
      `${prefix}${formatMoneyAmount(draft.amount, draft.currency)} · ${draft.category} · ${draft.description} · ${formatDisplayDate(draft.date)}`,
    );
  });
  lines.push("", "Confirm or cancel.");
  return lines.join("\n");
}

async function saveConfirmation(
  ctx: ActionContext,
  text: string,
  payload: PendingPayload,
): Promise<Delivery> {
  const parsed = pendingPayloadSchema.safeParse(payload);
  if (!parsed.success) return { kind: "text", text: "I couldn't prepare that confirmation. Nothing was changed." };
  const userId = String(ctx.profile.telegramUserId);
  const existing = await ctx.store.listPendingActions(userId);
  const open = existing.find((action) => {
    if (action.status !== "pending" || Date.parse(action.expiresAt) <= ctx.now.getTime()) return false;
    return action.payloadJson.includes(`"originUpdateId":"${payload.originUpdateId}"`);
  });
  if (open) return { kind: "confirm", text, actionId: open.actionId };
  const actionId = ctx.createActionId();
  await ctx.store.appendPendingAction({
    actionId,
    userId,
    chatId: String(ctx.chatId),
    actionType: payload.type,
    payloadJson: JSON.stringify(parsed.data),
    status: "pending",
    expiresAt: new Date(ctx.now.getTime() + ctx.pendingTtlMs).toISOString(),
    createdAt: ctx.now.toISOString(),
  });
  return { kind: "confirm", text, actionId };
}

function resolveRange(
  action: {
    period?: RelativePeriod | null;
    month?: number | null;
    year?: number | null;
    start_date?: string | null;
    end_date?: string | null;
  },
  today: string,
) {
  return resolveQueryRange({
    period: action.period,
    month: action.month,
    year: action.year,
    startDate: action.start_date,
    endDate: action.end_date,
    today,
  });
}

async function listOwn(ctx: ActionContext): Promise<TransactionRecord[]> {
  return ctx.store.listTransactions(String(ctx.profile.telegramUserId));
}
