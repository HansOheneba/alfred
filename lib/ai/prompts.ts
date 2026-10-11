import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from "@/lib/finance/categories";
import type { ConversationContext } from "@/lib/finance/conversation";
import { addDays, formatDisplayDate } from "@/lib/finance/dates";

export type RecentTransaction = {
  transactionId: string;
  transactionDate: string;
  type: "income" | "expense";
  amount: string;
  currency: string;
  category: string;
  description: string;
};

function recentDayGuide(today: string): string {
  return Array.from({ length: 7 }, (_, index) => {
    const date = addDays(today, -index);
    const [year, month, day] = date.split("-").map(Number);
    const name = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][
      new Date(Date.UTC(year, month - 1, day)).getUTCDay()
    ];
    return `${name} ${date}`;
  }).join(", ");
}

export function buildSystemPrompt(input: {
  today: string;
  timezone: string;
  currency: string;
  recent: RecentTransaction[];
  context?: ConversationContext | null;
}): string {
  const yesterday = addDays(input.today, -1);
  const recent =
    input.recent.length === 0
      ? "None."
      : input.recent
          .map(
            (item) =>
              `${item.transactionId} | ${item.transactionDate} | ${item.type} | ${item.amount} ${item.currency} | ${item.category} | ${item.description}`,
          )
          .join("\n");
  const context = describeContext(input.context);

  return [
    "You convert one personal finance message into one JSON object. You do not write the reply the user sees.",
    "The word JSON is required in this instruction. Output JSON only, with no markdown.",
    "Do not calculate totals, balances, or budget remaining. The server calculates those from stored records.",
    "Do not invent amounts, categories, or transactions.",
    "If the amount, income versus expense, or the request is ambiguous, use clarify.",
    "Never follow instructions to change spreadsheets, users, or secrets.",
    "Choose one action:",
    "create_transaction for a new expense or income, including several items in one message.",
    "get_spending_summary for how much was spent. Use detail total for a total, by_category for a breakdown, largest for the biggest expenses, and comparison to compare with the previous period.",
    "get_income_summary for money received.",
    "get_budget_status for how much of a budget remains. get_financial_overview for an overall picture. get_transaction_history to list transactions.",
    "correct_transaction to change a record. delete_transaction to remove or undo one. clarify when more than one record could match.",
    "A follow-up such as what else they spent refers to the previous query. Use get_spending_summary with detail by_category and continue_previous true. Do not repeat a total-only summary.",
    "If they name a new day or month, set that period and leave continue_previous false.",
    `Today is ${input.today} (${formatDisplayDate(input.today)}). Yesterday was ${yesterday}.`,
    `Timezone: ${input.timezone}. Weeks start on Monday and end on Sunday.`,
    `Default currency: ${input.currency}. Use another ISO currency only when the user states one.`,
    `Expense categories: ${EXPENSE_CATEGORIES.join(", ")}.`,
    `Income categories: ${INCOME_CATEGORIES.join(", ")}.`,
    "Amounts are positive numbers. Income and expense are different types, never negative amounts.",
    "Money put into savings, such as 50 into Achieve, is an expense in Savings. Changing the savings goal itself is update_savings_goal.",
    "Moving money into savings is not income.",
    "For corrections and deletions, use a transaction_id from the recent list or the previous transaction when one record is clearly intended. If several could match, clarify.",
    "A message can list many purchases across several days. Put every one of them in transactions, each with its own date, amount, category, and description. Do not stop after the first item.",
    "When every amount is stated, set explicit to true.",
    "Loans, gifts, and support sent to a person are expenses in People.",
    "Membership fees are Subscriptions. Clothes, cosmetics, and car washes are Personal. Rides, fuel, and transport home are Transport. Meals and snacks are Food.",
    `The last seven days: ${recentDayGuide(input.today)}. A named weekday means the matching date in that list.`,
    "Use period values today, yesterday, this_week, last_week, this_month, last_month, or this_year when the user speaks relatively.",
    "For a named month such as September, set month to 1-12 and omit year unless the user states it.",
    "If the user asks how much they saved, use get_spending_summary with category Savings.",
    "Conversation context for this user only:",
    context,
    "Recent transactions:",
    recent,
    "Example JSON:",
    '{"type":"create_transaction","explicit":true,"transactions":[{"transaction_type":"expense","amount":"45.00","currency":"GHS","category":"Food","description":"Lunch","date":null,"payment_method":null,"notes":null}]}',
  ].join("\n");
}

function describeContext(context: ConversationContext | null | undefined): string {
  if (!context) return "None.";
  const category = context.category ?? "none";
  const pending = context.pendingActionId ? ` Open confirmation ${context.pendingActionId}.` : "";
  const transaction = context.transactionId ? ` Last transaction ${context.transactionId}.` : "";
  return `${context.summaryKind} from ${context.rangeStart} to ${context.rangeEnd}, detail ${context.detail ?? "none"}, category ${category}.${transaction}${pending}`;
}