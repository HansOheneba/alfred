import type { ChatChart } from "@/lib/accounts/messages";
import type { UserProfile } from "@/lib/config";
import { normalizeCategory } from "@/lib/finance/categories";
import type { ConversationContext } from "@/lib/finance/conversation";
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
import { buildInsights } from "@/lib/finance/insights";
import { findPerson, loanBalances, owedBy, personKey, type LoanStore } from "@/lib/finance/loans";
import type { PeopleStore } from "@/lib/people/store";
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
  formatMoneyAmount,
  formatMoneyLines,
  formatRangeLabel,
  formatSaved,
  formatWriteResult,
  helpText,
  oneLine,
  safeChatReply,
  safeClarification,
  spokenPeriod,
  unknownCategoryMessage,
} from "@/lib/telegram/messages";

export type Delivery = DeliveryBody & { chart?: ChatChart };

type DeliveryBody =
  | { kind: "text"; text: string; context?: ConversationContext }
  | { kind: "confirm"; text: string; actionId: string; context?: ConversationContext };

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
  conversation?: ConversationContext | null;
  /** Money lent out. Loan actions say they're unavailable without it. */
  loans?: LoanStore | null;
  /** What the person told Alfred about people. */
  people?: PeopleStore | null;
  /** Everyone named in the person's bank texts, so "Grace" can mean Grace Oppong. */
  payeeNames?: () => Promise<string[]>;
};

export async function handleAction(action: FinanceAction, ctx: ActionContext): Promise<Delivery> {
  switch (action.type) {
    case "help":
      return { kind: "text", text: helpText() };
    case "clarify":
      return { kind: "text", text: safeClarification(action.question) };
    case "chat":
      return { kind: "text", text: safeChatReply(action.message) };
    case "create_transaction":
      return createTransactions(action, ctx);
    case "get_spending_summary":
      return spendingSummary(action, ctx);
    case "get_income_summary":
      return incomeSummary(action, ctx);
    case "get_financial_overview":
      return overview(action, ctx);
    case "get_insights":
      return insights(action, ctx);
    case "remember_person":
      return rememberPerson(action, ctx);
    case "forget_person":
      return forgetPerson(action, ctx);
    case "get_loans":
      return loansOwed(action, ctx);
    case "record_loan":
      return recordLoan(action, ctx);
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

export async function executeConfirmed(
  payload: PendingPayload,
  ctx: ActionContext,
): Promise<{ text: string; context?: ConversationContext }> {
  const userId = ctx.profile.profileId;
  if (payload.type === "create_transaction") {
    const result = await writeTransactions({
      store: ctx.store,
      userId,
      drafts: payload.transactions,
      sourcePrefix: `update:${payload.originUpdateId}`,
      createId: ctx.createId,
      now: ctx.now,
    });
    return { text: await loggedReply(ctx, result), context: savedContext(ctx, result.succeeded) };
  }
  if (payload.type === "record_loan") {
    if (!ctx.loans) return { text: "I can't track loans right now. Nothing was saved." };
    await ctx.loans.add(userId, {
      person: payload.person,
      kind: payload.direction,
      amount: payload.amount,
      currency: payload.currency,
      occurredAt: new Date(`${payload.date}T12:00:00Z`).toISOString(),
      note: payload.note,
      bankMessageId: null,
    });
    const left = await owedBy(ctx.loans, userId, payload.person);
    const owes = left ? `${payload.person} owes you ${formatMoneyAmount(left.owed, left.currency)} in total.` : `${payload.person} has paid you back in full.`;
    return { text: `Done. ${owes}` };
  }
  if (payload.type === "set_budget") {
    const timestamp = ctx.now.toISOString();
    const saved = await ctx.store.saveBudget({
      budgetId: ctx.createId(),
      userId,
      period: payload.period,
      category: payload.category,
      amount: payload.amount,
      currency: payload.currency,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return { text: `Done. Your ${saved.category} budget for ${monthName(saved.period)} is ${formatMoneyAmount(saved.amount, saved.currency)}.` };
  }
  if (payload.type === "create_savings_goal") {
    const timestamp = ctx.now.toISOString();
    const goal = await ctx.store.appendSavingsGoal({
      goalId: ctx.createId(),
      userId,
      name: payload.name,
      targetAmount: payload.targetAmount,
      currentAmount: payload.currentAmount,
      currency: payload.currency,
      targetDate: payload.targetDate,
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return { text: `Savings goal saved.\n${formatGoal(goal)}\nThis tracks the goal. It is not an account balance.` };
  }
  if (payload.type === "update_savings_goal") {
    const goal = (await ctx.store.listSavingsGoals(userId)).find((item) => item.goalId === payload.goalId);
    if (!goal) return { text: "I couldn't find that savings goal anymore. Nothing was changed." };
    const updated = await ctx.store.updateSavingsGoal(userId, goal.goalId, {
      currentAmount: payload.currentAmount,
      targetAmount: payload.targetAmount,
      targetDate: payload.targetDate,
      status: payload.status,
    });
    return { text: `${formatGoal(updated)}\nThis is recorded progress toward the goal, not money moving in a bank account.` };
  }
  if (payload.type === "delete_transaction") {
    const transactions = await ctx.store.listTransactions(userId);
    const target = transactions.find((item) => item.transactionId === payload.transactionId);
    if (!target) return { text: "I couldn't find that transaction. Nothing was changed." };
    if (target.status === "deleted") return { text: "That transaction was already removed from your totals." };
    await ctx.store.updateTransaction(userId, target.transactionId, { status: "deleted" });
    return { text: `Removed ${formatMoneyAmount(target.amount, target.currency)} ${target.description} from your totals.` };
  }
  const transactions = await ctx.store.listTransactions(userId);
  const target = transactions.find((item) => item.transactionId === payload.transactionId && item.status === "active");
  if (!target) return { text: "I couldn't find that active transaction. Nothing was changed." };
  const today = zonedYmd(ctx.now, ctx.profile.timezone);
  const nextType = payload.changes.transactionType ?? target.type;
  let category = payload.changes.category ?? target.category;
  if (payload.changes.category || payload.changes.transactionType) {
    const normalized = normalizeCategory(category, nextType);
    if (!normalized) return { text: unknownCategoryMessage(nextType) };
    category = normalized;
  }
  if (payload.changes.date && !isSaneTransactionDate(payload.changes.date, today)) {
    return { text: "That date isn't one I can store. Nothing was changed." };
  }
  const updated = await ctx.store.updateTransaction(userId, target.transactionId, {
    amount: payload.changes.amount,
    category,
    description: payload.changes.description,
    date: payload.changes.date,
    transactionType: payload.changes.transactionType,
  });
  return {
    text: `Updated ${formatMoneyAmount(updated.amount, updated.currency)} ${updated.description} (${updated.category}).`,
    context: queryContext(
      { start: updated.transactionDate, end: updated.transactionDate },
      updated.category,
      null,
      updated.transactionId,
      "correction",
    ),
  };
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
    userId: ctx.profile.profileId,
    drafts: normalized.drafts,
    sourcePrefix: `update:${ctx.updateId}`,
    createId: ctx.createId,
    now: ctx.now,
  });
  return { kind: "text", text: await loggedReply(ctx, result), context: savedContext(ctx, result.succeeded) };
}

async function loggedReply(
  ctx: ActionContext,
  result: { succeeded: TransactionRecord[]; failed: { description: string; message: string }[] },
): Promise<string> {
  if (result.succeeded.length === 0) return formatWriteResult(result);
  const today = zonedYmd(ctx.now, ctx.profile.timezone);
  const lines = [formatSaved(result.succeeded, today)];
  if (result.succeeded.some((item) => item.type === "expense")) {
    const month = await monthSpendLine(ctx, today);
    if (month) lines.push("", month);
  }
  if (result.failed.length > 0) {
    lines.push("", "Not saved:");
    result.failed.forEach((item) => lines.push(`- ${item.description}: ${item.message}`));
  }
  return lines.join("\n");
}

async function monthSpendLine(ctx: ActionContext, today: string): Promise<string | null> {
  try {
    const year = Number(today.slice(0, 4));
    const month = Number(today.slice(5, 7));
    const range = monthRange(year, month);
    const expenses = inRange(await ctx.store.listTransactions(ctx.profile.profileId), {
      userId: ctx.profile.profileId,
      range,
      type: "expense",
    });
    const spent = totalsByCurrency(expenses).find((item) => item.currency === ctx.profile.currency);
    if (!spent) return null;
    return `Your spending for the month is now ${formatMinor(spent.minor, spent.currency)}.`;
  } catch {
    return null;
  }
}

function savedContext(ctx: ActionContext, succeeded: TransactionRecord[]): ConversationContext | undefined {
  const latest = succeeded[succeeded.length - 1];
  if (!latest) return undefined;
  const today = zonedYmd(ctx.now, ctx.profile.timezone);
  const range = monthRange(Number(today.slice(0, 4)), Number(today.slice(5, 7)));
  return {
    rangeStart: range.start,
    rangeEnd: range.end,
    category: latest.category,
    detail: "total",
    summaryKind: "record",
    transactionId: latest.transactionId,
    pendingActionId: null,
  };
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
  const transactions = await ctx.store.listTransactions(ctx.profile.profileId);
  const detail = action.detail ?? "total";
  if (detail === "comparison") {
    return remember(comparisonText(transactions, ctx, resolved.range, category), queryContext(resolved.range, category, "comparison", null));
  }
  const rows = inRange(transactions, {
    userId: ctx.profile.profileId,
    range: resolved.range,
    type: "expense",
    category: category ?? undefined,
  });
  if (detail === "largest") {
    const label = category === "Savings" ? "Saved" : category ? `Spent on ${category}` : "Spent";
    const lines = [`${label} (${formatRangeLabel(resolved.range)}):`, formatMoneyLines(totalsByCurrency(rows), "No matching expenses.")];
    const top = largestExpenses(rows, 5);
    lines.push("", top.length ? "Biggest expenses:" : "No expenses in that range.");
    top.forEach((item, index) => lines.push(`${index + 1}. ${oneLine(item)}`));
    return remember(lines.join("\n"), queryContext(resolved.range, category, "largest", rows[0]?.transactionId ?? null));
  }
  const text = await spokenSpend(ctx, resolved.range, rows, category, today, detail);
  return remember(
    text,
    queryContext(resolved.range, category, detail === "by_category" ? "by_category" : "total", rows.length === 1 ? rows[0].transactionId : null),
    category ? undefined : categoryChart(rows, ctx.profile.currency),
  );
}

function queryContext(
  range: DateRange,
  category: string | null,
  detail: ConversationContext["detail"],
  transactionId: string | null,
  summaryKind: ConversationContext["summaryKind"] = "spending",
): ConversationContext {
  return {
    rangeStart: range.start,
    rangeEnd: range.end,
    category,
    detail,
    summaryKind,
    transactionId,
    pendingActionId: null,
  };
}

function remember(text: string, context: ConversationContext, chart?: ChatChart): Delivery {
  return chart ? { kind: "text", text, context, chart } : { kind: "text", text, context };
}

/** Spending by category in the user's main currency, for the chart beside a reply. */
function categoryChart(rows: TransactionRecord[], currency: string): ChatChart | undefined {
  const items = totalsByCategory(rows)
    .filter((item) => item.currency === currency)
    .map((item) => ({ label: item.category, minor: item.minor }));
  return items.length >= 2 ? { kind: "categories", currency, items } : undefined;
}

async function spokenSpend(
  ctx: ActionContext,
  range: DateRange,
  rows: TransactionRecord[],
  category: string | null,
  today: string,
  detail: "total" | "by_category",
): Promise<string> {
  const period = spokenPeriod(range, today);
  if (detail === "by_category" && !category) {
    const groups = totalsByCategory(rows);
    if (groups.length === 0) return `You haven't recorded any spending ${period}.`;
    if (groups.length === 1) {
      const only = groups[0];
      const names = [...new Set(rows.map((item) => item.description))].slice(0, 5);
      const listed = names.length > 0 ? `\n${names.map((name) => `- ${name}`).join("\n")}` : "";
      return `All recorded spending ${period} is ${only.category}: ${formatMinor(only.minor, only.currency)}. Nothing else is recorded.${listed}`;
    }
    const lines = groups.map((group) => `${group.category}: ${formatMinor(group.minor, group.currency)}`);
    return [`Spending ${period}:`, ...lines].join("\n");
  }
  if (rows.length === 0) {
    return category
      ? `You haven't recorded any ${category} spending ${period}.`
      : `You haven't recorded any spending ${period}.`;
  }
  const currency = rows.find((item) => item.currency === ctx.profile.currency)?.currency ?? rows[0].currency;
  const minor = totalsByCurrency(rows).find((item) => item.currency === currency)?.minor ?? 0;
  const money = formatMinor(minor, currency);
  const head = category ? `You've spent ${money} on ${category} ${period}.` : `You've spent ${money} ${period}.`;
  if (!category && period === "this month") {
    const income = inRange(await ctx.store.listTransactions(ctx.profile.profileId), {
      userId: ctx.profile.profileId,
      range,
      type: "income",
    });
    const earned = totalsByCurrency(income).find((item) => item.currency === currency)?.minor ?? 0;
    if (earned > 0) {
      return `${head} That leaves ${formatMinor(earned - minor, currency)} of ${formatMinor(earned, currency)}.`;
    }
  }
  if (category && rows.length > 1 && rows.length <= 6) {
    const lines = rows.map((item) => `- ${formatMoneyAmount(item.amount, item.currency)} ${item.description}`);
    return [head, ...lines].join("\n");
  }
  return head;
}

function comparisonText(
  transactions: TransactionRecord[],
  ctx: ActionContext,
  range: DateRange,
  category: string | null,
): string {
  const userId = ctx.profile.profileId;
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
    userId: ctx.profile.profileId,
    range: resolved.range,
    type: "income",
    category: category ?? undefined,
  });
  const period = spokenPeriod(resolved.range, today);
  if (rows.length === 0) {
    const empty = category
      ? `You haven't recorded any ${category} income ${period}.`
      : `You haven't recorded any income ${period}.`;
    return remember(empty, queryContext(resolved.range, category, "total", null, "income"));
  }
  const currency = rows.find((item) => item.currency === ctx.profile.currency)?.currency ?? rows[0].currency;
  const minor = totalsByCurrency(rows).find((item) => item.currency === currency)?.minor ?? 0;
  const money = formatMinor(minor, currency);
  const text = category ? `You've received ${money} in ${category} ${period}.` : `You've received ${money} ${period}.`;
  return remember(text, queryContext(resolved.range, category, "total", rows.length === 1 ? rows[0].transactionId : null, "income"));
}

async function overview(
  action: Extract<FinanceAction, { type: "get_financial_overview" }>,
  ctx: ActionContext,
): Promise<Delivery> {
  const today = zonedYmd(ctx.now, ctx.profile.timezone);
  const resolved = resolveRange(action, today);
  if (!resolved.ok) return { kind: "text", text: resolved.message };
  const userId = ctx.profile.profileId;
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
  const chart = categoryChart(expenses, ctx.profile.currency);
  return chart ? { kind: "text", text: lines.join("\n"), chart } : { kind: "text", text: lines.join("\n") };
}

async function insights(
  action: Extract<FinanceAction, { type: "get_insights" }>,
  ctx: ActionContext,
): Promise<Delivery> {
  const today = zonedYmd(ctx.now, ctx.profile.timezone);
  const resolved = resolveRange(action, today);
  if (!resolved.ok) return { kind: "text", text: resolved.message };
  const userId = ctx.profile.profileId;
  const [transactions, budgets] = await Promise.all([listOwn(ctx), ctx.store.listBudgets(userId)]);
  const lines = buildInsights({
    userId,
    currency: ctx.profile.currency,
    range: resolved.range,
    today,
    transactions,
    budgets,
  });
  const text = [`Insights, ${spokenPeriod(resolved.range, today)}`, ...lines.map((line) => `- ${line}`)].join("\n");
  const expenses = inRange(transactions, { userId, range: resolved.range, type: "expense" });
  return remember(
    text,
    queryContext(resolved.range, null, "by_category", null, "overview"),
    categoryChart(expenses, ctx.profile.currency),
  );
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
    userId: ctx.profile.profileId,
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

async function loansOwed(action: Extract<FinanceAction, { type: "get_loans" }>, ctx: ActionContext): Promise<Delivery> {
  if (!ctx.loans) return { kind: "text", text: "I can't see loans right now." };
  const balances = loanBalances(await ctx.loans.list(ctx.profile.profileId));
  if (action.person) {
    const match = findPerson(balances, action.person);
    if (!match) return { kind: "text", text: `I don't have any loans to ${action.person} on record.` };
    const lent = formatMoneyAmount(match.lent, match.currency);
    if (Number(match.owed) === 0) return { kind: "text", text: `${match.person} has paid back everything you lent (${lent}).` };
    const repaid = Number(match.repaid) > 0 ? `, and has paid back ${formatMoneyAmount(match.repaid, match.currency)}` : "";
    return { kind: "text", text: `${match.person} owes you ${formatMoneyAmount(match.owed, match.currency)}. You lent ${lent} in total${repaid}.` };
  }
  const owing = balances.filter((item) => Number(item.owed) > 0);
  if (owing.length === 0) return { kind: "text", text: "No one owes you anything right now." };
  const lines = owing.map((item) => `• ${item.person}: ${formatMoneyAmount(item.owed, item.currency)}`);
  return { kind: "text", text: [`${owing.length === 1 ? "One person owes" : `${owing.length} people owe`} you money:`, ...lines].join("\n") };
}

/** The full name a person goes by in the person's notes or bank texts, for a name or nickname. */
async function knownName(name: string, ctx: ActionContext): Promise<string> {
  const notes = ctx.people ? await ctx.people.list(ctx.profile.profileId) : [];
  const payees = ctx.payeeNames ? await ctx.payeeNames() : [];
  const candidates = [...notes.map((item) => item.name), ...payees].map((full) => ({ name: full, personKey: personKey(full) }));
  return findPerson(candidates, name)?.name ?? name.trim().replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

async function rememberPerson(action: Extract<FinanceAction, { type: "remember_person" }>, ctx: ActionContext): Promise<Delivery> {
  if (!ctx.people) return { kind: "text", text: "I can't keep notes about people right now." };
  const saved = await ctx.people.save(ctx.profile.profileId, { name: await knownName(action.name, ctx), note: action.note });
  return { kind: "text", text: `Noted. ${saved.name}: ${saved.note.replace(/[.!\s]+$/, "")}. I'll keep that in mind when their payments come in.` };
}

async function forgetPerson(action: Extract<FinanceAction, { type: "forget_person" }>, ctx: ActionContext): Promise<Delivery> {
  if (!ctx.people) return { kind: "text", text: "I can't keep notes about people right now." };
  const notes = await ctx.people.list(ctx.profile.profileId);
  const match = findPerson(notes, action.name);
  if (!match) return { kind: "text", text: `I don't have anything noted about ${action.name}.` };
  await ctx.people.remove(ctx.profile.profileId, match.personKey);
  return { kind: "text", text: `Forgotten. I no longer have a note about ${match.name}.` };
}

async function recordLoan(action: Extract<FinanceAction, { type: "record_loan" }>, ctx: ActionContext): Promise<Delivery> {
  if (!ctx.loans) return { kind: "text", text: "I can't track loans right now." };
  // "Debby paid me back" should land on the Deborah Alfred already knows.
  const known = findPerson(loanBalances(await ctx.loans.list(ctx.profile.profileId)), action.person);
  const person = known?.person ?? action.person.trim().replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
  const today = zonedYmd(ctx.now, ctx.profile.timezone);
  const date = action.date && isSaneTransactionDate(action.date, today) && action.date <= today ? action.date : today;
  const amount = formatMoneyAmount(action.amount, action.currency);
  const line = action.direction === "lent" ? `Record that you lent ${person} ${amount} on ${formatDisplayDate(date)}?` : `Record that ${person} paid you back ${amount} on ${formatDisplayDate(date)}?`;
  return saveConfirmation(ctx, [line, action.direction === "lent" ? "It won't count as spending." : "It won't count as income.", "", "Confirm or cancel."].join("\n"), {
    type: "record_loan",
    originUpdateId: String(ctx.updateId),
    direction: action.direction,
    person,
    amount: action.amount,
    currency: action.currency,
    date,
    note: action.note?.trim() ?? "",
  });
}

async function setBudget(
  action: Extract<FinanceAction, { type: "set_budget" }>,
  ctx: ActionContext,
): Promise<Delivery> {
  const category = normalizeCategory(action.category, "expense");
  if (!category) return { kind: "text", text: unknownCategoryMessage("expense") };
  const today = zonedYmd(ctx.now, ctx.profile.timezone);
  const period = action.period ?? today.slice(0, 7);
  const existing = (await ctx.store.listBudgets(ctx.profile.profileId)).find(
    (budget) => budget.period === period && budget.category === category && budget.currency === action.currency,
  );
  const amount = formatMoneyAmount(action.amount, action.currency);
  const lines = existing
    ? [`Change your ${category} budget for ${monthName(period)}?`, `${formatMoneyAmount(existing.amount, existing.currency)} → ${amount}`]
    : [`Set a ${category} budget of ${amount} for ${monthName(period)}?`];
  return saveConfirmation(ctx, [...lines, "", "Confirm or cancel."].join("\n"), {
    type: "set_budget",
    originUpdateId: String(ctx.updateId),
    category,
    amount: action.amount,
    currency: action.currency,
    period,
  });
}

function monthName(period: string): string {
  const [year, month] = period.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  );
}

async function budgetStatus(
  action: Extract<FinanceAction, { type: "get_budget_status" }>,
  ctx: ActionContext,
): Promise<Delivery> {
  const today = zonedYmd(ctx.now, ctx.profile.timezone);
  const period = action.period ?? today.slice(0, 7);
  const periodPhrase = period === today.slice(0, 7) ? "this month" : period;
  const category = action.category ? normalizeCategory(action.category, "expense") : null;
  if (action.category && !category) return { kind: "text", text: unknownCategoryMessage("expense") };
  const userId = ctx.profile.profileId;
  const budgets = (await ctx.store.listBudgets(userId)).filter(
    (budget) => budget.period === period && (!category || budget.category === category),
  );
  if (budgets.length === 0) {
    const missing = category
      ? `There's no ${category} budget set for ${periodPhrase}.`
      : `There's no budget set for ${periodPhrase}.`;
    return { kind: "text", text: missing };
  }
  const transactions = await listOwn(ctx);
  if (budgets.length === 1) {
    const budget = budgets[0];
    const math = budgetMath(budget, transactions);
    const text =
      math.remainingMinor < 0
        ? `You're ${formatMinor(Math.abs(math.remainingMinor), budget.currency)} over your ${budget.category} budget for ${periodPhrase}.`
        : `You have ${formatMinor(math.remainingMinor, budget.currency)} left in your ${budget.category} budget for ${periodPhrase}.`;
    const range = monthRange(Number(period.slice(0, 4)), Number(period.slice(5, 7)));
    return remember(text, queryContext(range, budget.category, "total", null, "budget"));
  }
  const lines = budgets.map((budget) => formatBudgetLine(budget, budgetMath(budget, transactions)));
  const range = monthRange(Number(period.slice(0, 4)), Number(period.slice(5, 7)));
  return remember(lines.join("\n"), queryContext(range, category, "total", null, "budget"));
}

async function createGoal(
  action: Extract<FinanceAction, { type: "create_savings_goal" }>,
  ctx: ActionContext,
): Promise<Delivery> {
  const name = action.name.trim();
  const current = action.current_amount ?? "0.00";
  const lines = [
    `Create a savings goal "${name}"?`,
    `Target: ${formatMoneyAmount(action.target_amount, action.currency)}`,
    `Saved so far: ${formatMoneyAmount(current, action.currency)}`,
  ];
  if (action.target_date) lines.push(`By: ${formatDisplayDate(action.target_date)}`);
  return saveConfirmation(ctx, [...lines, "", "Confirm or cancel."].join("\n"), {
    type: "create_savings_goal",
    originUpdateId: String(ctx.updateId),
    name,
    targetAmount: action.target_amount,
    currentAmount: current,
    currency: action.currency,
    targetDate: action.target_date ?? "",
  });
}

async function updateGoal(
  action: Extract<FinanceAction, { type: "update_savings_goal" }>,
  ctx: ActionContext,
): Promise<Delivery> {
  const goals = await ctx.store.listSavingsGoals(ctx.profile.profileId);
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
  const next = {
    currentAmount,
    targetAmount: action.target_amount ?? goal.targetAmount,
    targetDate: action.target_date ?? goal.targetDate,
    status: action.status ?? (goal.status === "completed" ? "completed" : "active"),
  } as const;
  const money = (value: string) => formatMoneyAmount(value, goal.currency);
  const changes: string[] = [];
  if (next.currentAmount !== goal.currentAmount) changes.push(`Saved: ${money(goal.currentAmount)} → ${money(next.currentAmount)}`);
  if (next.targetAmount !== goal.targetAmount) changes.push(`Target: ${money(goal.targetAmount)} → ${money(next.targetAmount)}`);
  if (next.targetDate !== goal.targetDate) changes.push(`By: ${next.targetDate ? formatDisplayDate(next.targetDate) : "no date"}`);
  if (next.status !== goal.status) changes.push(`Status: ${goal.status} → ${next.status}`);
  if (changes.length === 0) return { kind: "text", text: "That goal already looks like that. What should I change?" };
  return saveConfirmation(ctx, [`Update "${goal.name}"?`, ...changes, "", "Confirm or cancel."].join("\n"), {
    type: "update_savings_goal",
    originUpdateId: String(ctx.updateId),
    goalId: goal.goalId,
    ...next,
  });
}

async function correctTransaction(
  action: Extract<FinanceAction, { type: "correct_transaction" }>,
  ctx: ActionContext,
): Promise<Delivery> {
  const transactions = await listOwn(ctx);
  const transactionId = action.transaction_id ?? (action.description_query ? null : ctx.conversation?.transactionId ?? null);
  const matches = findCandidates(transactions, {
    transactionId,
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
  if (action.changes.amount && action.changes.amount !== target.amount) changes.amount = action.changes.amount;
  if (action.changes.description && action.changes.description !== target.description) {
    changes.description = action.changes.description;
  }
  if (action.changes.date && action.changes.date !== target.transactionDate) {
    if (!isSaneTransactionDate(action.changes.date, today)) {
      return { kind: "text", text: "That date isn't one I can store." };
    }
    changes.date = action.changes.date;
  }
  if (action.changes.transaction_type && action.changes.transaction_type !== target.type) {
    changes.transactionType = action.changes.transaction_type;
  }
  const nextType = changes.transactionType ?? target.type;
  if (action.changes.category) {
    const category = normalizeCategory(action.changes.category, nextType);
    if (!category) return { kind: "text", text: unknownCategoryMessage(nextType) };
    if (category !== target.category) changes.category = category;
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
  const delivery = await saveConfirmation(ctx, text, {
    type: "correct_transaction",
    originUpdateId: String(ctx.updateId),
    transactionId: target.transactionId,
    changes,
  });
  if (delivery.kind !== "confirm") return delivery;
  return {
    ...delivery,
    context: {
      rangeStart: target.transactionDate,
      rangeEnd: target.transactionDate,
      category: target.category,
      detail: null,
      summaryKind: "correction",
      transactionId: target.transactionId,
      pendingActionId: delivery.actionId,
    },
  };
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
  const userId = ctx.profile.profileId;
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
  return ctx.store.listTransactions(ctx.profile.profileId);
}
