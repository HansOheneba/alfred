import { AuthError, AiError, ConfigError, DatabaseError, SheetsError } from "@/lib/errors";
import { categoryList } from "@/lib/finance/categories";
import { addDays, formatDisplayDate, formatRange, monthRange, type DateRange } from "@/lib/finance/dates";
import { formatMinor, toMinor } from "@/lib/finance/money";
import type { BudgetRecord, SavingsGoalRecord, TransactionRecord } from "@/lib/finance/types";
import type { BudgetMath } from "@/lib/finance/budgets";

export const BALANCE_DISCLAIMER =
  "This is calculated from recorded transactions. It is not a bank balance.";

export const UNLINKED_TEXT =
  "This Telegram account isn't linked yet. Sign in on the website, save this Telegram ID in Settings, then message me again.";

export const WELCOME_TEXT = `Hey! I'm Alfred, your personal finance assistant.

Tell me what you spend, what you earn, or ask me how your money is looking. I'll keep track of it for you.

For example: 'Spent GH₵200 on food yesterday.'`;

export function userFacingError(error: unknown): string {
  if (error instanceof SheetsError) {
    if (error.code === "permission") {
      return "I can't access the finance spreadsheet. Share it with the service account and try again.";
    }
    if (error.code === "credentials") {
      return "Google rejected the service account credentials. Check the server configuration.";
    }
    if (error.code === "not_found") {
      return "The finance spreadsheet or one of its worksheets is missing. Run the sheet setup and try again.";
    }
    if (error.code === "headers") {
      return "The spreadsheet headers don't match what I expect. I left existing rows unchanged.";
    }
    if (error.code === "verify") {
      return "I couldn't confirm the spreadsheet write. Check the sheet before trying again so it isn't recorded twice.";
    }
    if (error.code === "missing_row") {
      return "I couldn't find that record anymore. Nothing was changed.";
    }
    return "The spreadsheet is temporarily unavailable. If I didn't confirm a result, it wasn't saved.";
  }
  if (error instanceof AiError) {
    if (error.code === "rate_limit") return "The assistant is busy right now. Try again in a minute.";
    if (error.code === "timeout") return "That took too long to understand. Please try again.";
    return "I couldn't read that reliably. Please rephrase with the amount and what it was for.";
  }
  if (error instanceof DatabaseError) return "The ledger is temporarily unavailable. If I didn't confirm a result, it wasn't saved.";
  if (error instanceof ConfigError) return "The assistant isn't fully configured yet.";
  if (error instanceof AuthError) return "That record isn't available in this chat.";
  return "Something went wrong before I could finish. If I didn't confirm a result, it wasn't saved.";
}

export function welcomeText(): string {
  return WELCOME_TEXT;
}

export function helpText(): string {
  return WELCOME_TEXT;
}

export const GREETING_TEXT = "Hey. Tell me what you spent or earned, or ask how the month is looking.";

export const CAPABILITY_TEXT =
  "I can help with recording expenses and income, checking spending, income, budgets, savings, and transaction history. What would you like to do with your finances?";

const UNSAFE_REPLY = /spreadsheet|private key|api[_ -]?key|ignore previous|system prompt/i;

export function localGreeting(text: string): string | null {
  const value = text.trim();
  if (/^(?:hi|hello|hey|thanks|thank you)(?:\s+(?:alfred|there))?[\s!.?]*$/i.test(value)) return GREETING_TEXT;
  return null;
}

export function looksLikeTransaction(text: string): boolean {
  return /\d|\b(spent|spend|spending|paid|received|earned|income|expense|budget|saved)\b|gh[c₵]|ghs|₵/i.test(text);
}

export function conversationalFallback(text: string): string {
  if (looksLikeTransaction(text)) {
    return "I couldn't read that reliably. Please rephrase with the amount and what it was for.";
  }
  return CAPABILITY_TEXT;
}

export function safeClarification(question: string): string {
  const trimmed = question.replace(/\s+/g, " ").trim().slice(0, 500);
  if (!trimmed || UNSAFE_REPLY.test(trimmed)) {
    return "I need a bit more detail. What was the amount, and was it income or an expense?";
  }
  return trimmed;
}

export function safeChatReply(message: string): string {
  const trimmed = message.replace(/\s+/g, " ").trim().slice(0, 500);
  if (!trimmed || UNSAFE_REPLY.test(trimmed)) return CAPABILITY_TEXT;
  return trimmed;
}

export function formatMoneyAmount(amount: string, currency: string): string {
  return formatMinor(toMinor(amount), currency);
}

export function oneLine(transaction: TransactionRecord): string {
  const kind = transaction.type === "income" ? "Income" : "Expense";
  return `${formatDisplayDate(transaction.transactionDate)} · ${kind} · ${formatMoneyAmount(transaction.amount, transaction.currency)} · ${transaction.category} · ${transaction.description}`;
}

function whenLabel(date: string, today: string): string {
  if (date === today) return "Today";
  if (date === addDays(today, -1)) return "Yesterday";
  return formatDisplayDate(date);
}

export function formatSaved(transactions: TransactionRecord[], today: string): string {
  if (transactions.length === 1) {
    const item = transactions[0];
    const money = formatMoneyAmount(item.amount, item.currency);
    const when = whenLabel(item.transactionDate, today);
    if (item.type === "income") return `Recorded: ${money} — ${item.category}\nIncome · ${when}`;
    return `Recorded: ${money} — ${item.category}\n${when} · Expense`;
  }
  const lines = transactions.map((item) => {
    const when = whenLabel(item.transactionDate, today);
    const kind = item.type === "income" ? "Income" : "Expense";
    return `- ${formatMoneyAmount(item.amount, item.currency)} — ${item.category} · ${when} · ${kind}`;
  });
  return `Recorded:\n${lines.join("\n")}`;
}

export function spokenPeriod(range: DateRange, today: string): string {
  if (range.start === today && range.end === today) return "today";
  const yesterday = addDays(today, -1);
  if (range.start === yesterday && range.end === yesterday) return "yesterday";
  const current = monthRange(Number(today.slice(0, 4)), Number(today.slice(5, 7)));
  if (range.start === current.start && range.end === current.end) return "this month";
  if (range.start.endsWith("-01")) {
    const month = Number(range.start.slice(5, 7));
    const year = Number(range.start.slice(0, 4));
    const full = monthRange(year, month);
    if (range.end === full.end) {
      const name = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][month - 1];
      return `in ${name}`;
    }
  }
  if (range.start === range.end) return `on ${formatDisplayDate(range.start)}`;
  return `from ${formatDisplayDate(range.start)} to ${formatDisplayDate(range.end)}`;
}

export function formatRecorded(transaction: TransactionRecord): string {
  return [
    `Recorded: ${formatMoneyAmount(transaction.amount, transaction.currency)}`,
    `Category: ${transaction.category}`,
    `Description: ${transaction.description}`,
    `Date: ${formatDisplayDate(transaction.transactionDate)}`,
  ].join("\n");
}

export function formatWriteResult(result: {
  succeeded: TransactionRecord[];
  failed: { description: string; message: string }[];
}): string {
  if (result.succeeded.length === 1 && result.failed.length === 0) {
    return formatRecorded(result.succeeded[0]);
  }
  const lines: string[] = [];
  if (result.succeeded.length === 0) {
    lines.push("Nothing was saved.");
  } else {
    lines.push(`Recorded ${result.succeeded.length}:`);
    result.succeeded.forEach((transaction, index) => {
      lines.push(`${index + 1}. ${oneLine(transaction)}`);
    });
  }
  if (result.failed.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`Failed ${result.failed.length}:`);
    result.failed.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.description}: ${item.message}`);
    });
  }
  return lines.join("\n") || "Nothing was recorded.";
}

export function formatMoneyLines(
  totals: { currency: string; minor: number }[],
  empty: string,
): string {
  if (totals.length === 0) return empty;
  return totals.map((total) => formatMinor(total.minor, total.currency)).join("\n");
}

export function formatCategoryLines(
  rows: { category: string; currency: string; minor: number }[],
): string[] {
  return rows.map((row) => `${row.category}: ${formatMinor(row.minor, row.currency)}`);
}

export function formatBudgetLine(budget: BudgetRecord, math: BudgetMath): string {
  const spent = formatMinor(math.spentMinor, budget.currency);
  const limit = formatMinor(math.budgetMinor, budget.currency);
  if (math.remainingMinor < 0) {
    return `${budget.category}: ${spent} of ${limit} · ${formatMinor(Math.abs(math.remainingMinor), budget.currency)} over`;
  }
  return `${budget.category}: ${spent} of ${limit} · ${formatMinor(math.remainingMinor, budget.currency)} left`;
}

export function formatGoal(goal: SavingsGoalRecord): string {
  const current = formatMoneyAmount(goal.currentAmount, goal.currency);
  const target = formatMoneyAmount(goal.targetAmount, goal.currency);
  const date = goal.targetDate ? ` by ${formatDisplayDate(goal.targetDate)}` : "";
  return `${goal.name}: ${current} of ${target}${date}`;
}

export function formatRangeLabel(range: DateRange): string {
  return formatRange(range);
}

export function unknownCategoryMessage(type: "income" | "expense"): string {
  return `I don't have that category. Use one of: ${categoryList(type).join(", ")}.`;
}
