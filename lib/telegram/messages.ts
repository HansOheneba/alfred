import { AuthError, AiError, ConfigError, DatabaseError, SheetsError } from "@/lib/errors";
import { categoryList } from "@/lib/finance/categories";
import { addDays, formatDisplayDate, formatRange, type DateRange } from "@/lib/finance/dates";
import { formatMinor, toMinor } from "@/lib/finance/money";
import type { BudgetRecord, SavingsGoalRecord, TransactionRecord } from "@/lib/finance/types";
import type { BudgetMath } from "@/lib/finance/budgets";

export const BALANCE_DISCLAIMER =
  "This is calculated from recorded transactions. It is not a bank balance.";

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

export function helpText(timeZone: string): string {
  return [
    "I can track spending and income in this chat.",
    "",
    "Try:",
    "• I spent GH₵45 on lunch",
    "• I received GH₵500 salary",
    "• How much have I spent this week?",
    "• How much did I spend on food this month?",
    "• What is my total income this month?",
    "• Set my food budget to GH₵1,200 this month",
    "• How much of my food budget remains?",
    "• Give me a financial summary for September",
    "• Change the lunch expense to GH₵55",
    "• Delete the duplicate transaction",
    "• Undo my last expense",
    "",
    `Weeks start on Monday. Dates use ${timeZone}.`,
    BALANCE_DISCLAIMER,
  ].join("\n");
}

export function safeClarification(question: string): string {
  const trimmed = question.replace(/\s+/g, " ").trim().slice(0, 500);
  if (!trimmed || /spreadsheet|private key|api[_ -]?key|ignore previous|system prompt/i.test(trimmed)) {
    return "I need a bit more detail. What was the amount, and was it income or an expense?";
  }
  return trimmed;
}

export function formatMoneyAmount(amount: string, currency: string): string {
  return formatMinor(toMinor(amount), currency);
}

export function oneLine(transaction: TransactionRecord): string {
  const kind = transaction.type === "income" ? "Income" : "Expense";
  return `${formatDisplayDate(transaction.transactionDate)} · ${kind} · ${formatMoneyAmount(transaction.amount, transaction.currency)} · ${transaction.category} · ${transaction.description}`;
}

export function formatLogged(transactions: TransactionRecord[], today: string): string {
  if (transactions.length === 0) return "Nothing was recorded.";
  const lines = transactions.map((transaction) => {
    const when = transaction.transactionDate === today
      ? "today"
      : transaction.transactionDate === addDays(today, -1)
        ? "yesterday"
        : formatDisplayDate(transaction.transactionDate);
    return `${formatMoneyAmount(transaction.amount, transaction.currency)} ${transaction.description} (${transaction.category}) for ${when}`;
  });
  if (lines.length === 1) return `Logged ${lines[0]}.`;
  return `Logged:\n${lines.map((line) => `- ${line}`).join("\n")}`;
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
  if (result.succeeded.length > 0) {
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
