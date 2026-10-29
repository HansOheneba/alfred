import { personaLines, type Channel } from "@/lib/ai/persona";
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

const RANGE = '"period":null,"month":null,"year":null,"start_date":null,"end_date":null,"category":null,"continue_previous":false';

const ACTION_SHAPES = [
  '{"type":"chat","message":"...","topic":"money or other"}',
  '{"type":"clarify","question":"..."}',
  '{"type":"help"}',
  '{"type":"create_transaction","explicit":true,"transactions":[{"transaction_type":"expense","amount":"45.00","currency":"GHS","category":"Food","description":"Lunch","date":null,"payment_method":null,"notes":null}]}',
  `{"type":"get_spending_summary",${RANGE},"detail":"total"}`,
  `{"type":"get_income_summary",${RANGE}}`,
  `{"type":"get_financial_overview",${RANGE}}`,
  `{"type":"get_insights",${RANGE}}`,
  '{"type":"remember_person","name":"Kofi","note":"Colleague. Sometimes sends money on behalf of his brother Yaw."}',
  '{"type":"forget_person","name":"Kofi"}',
  '{"type":"get_loans","person":null}',
  '{"type":"record_loan","direction":"lent","person":"Kofi","amount":"100.00","currency":"GHS","date":null,"note":null}',
  `{"type":"get_transaction_history",${RANGE},"limit":null}`,
  '{"type":"set_budget","category":"Food","amount":"800.00","currency":"GHS","period":"YYYY-MM or null"}',
  '{"type":"get_budget_status","category":null,"period":null}',
  '{"type":"create_savings_goal","name":"Laptop","target_amount":"3000.00","currency":"GHS","target_date":null,"current_amount":null}',
  '{"type":"update_savings_goal","goal_id":null,"name":"Laptop","contribution":"100.00","set_current_amount":null,"target_amount":null,"target_date":null,"status":null}',
  '{"type":"correct_transaction","transaction_id":"id from the recent list","description_query":null,"changes":{"amount":"60.00"}} — put only the fields that change inside changes.',
  '{"type":"delete_transaction","transaction_id":"id from the recent list","description_query":null,"undo_last":false}',
];

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
  preferredName?: string;
  communicationPreference?: "concise" | "detailed";
  toneNote?: string;
  channel?: Channel;
  budgets?: { period: string; category: string; amount: string; currency: string }[];
  goals?: { name: string; currentAmount: string; targetAmount: string; currency: string }[];
  history?: { role: "user" | "assistant"; body: string }[];
  /** Bank payments waiting for a label, numbered, and the one just asked about (0 for none). */
  waiting?: { lines: string[]; current: number } | null;
  /** What the user has told Alfred about people, one "Name: note" per line. */
  people?: string[];
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

  const persona = personaLines(
    {
      preferredName: input.preferredName ?? "",
      communicationPreference: input.communicationPreference ?? "concise",
      toneNote: input.toneNote,
    },
    input.channel ?? "telegram",
  );
  const budgets =
    input.budgets && input.budgets.length > 0
      ? input.budgets.map((item) => `${item.period} ${item.category} ${item.amount} ${item.currency}`).join("\n")
      : "None.";
  const goals =
    input.goals && input.goals.length > 0
      ? input.goals
          .map((item) => `${item.name} ${item.currentAmount}/${item.targetAmount} ${item.currency}`)
          .join("\n")
      : "None.";
  const history =
    input.history && input.history.length > 0
      ? input.history.map((item) => `${item.role}: ${item.body}`).join("\n")
      : "None.";

  return [
    "You convert one personal finance message into one JSON object.",
    "Use chat for greetings, thanks, small talk, encouragement, questions about what you can do, and general money advice that needs no stored figures. The message field is the reply the user will see, written in Alfred's voice:",
    ...persona,
    "End of Alfred's voice. For every action other than chat, you do not write the reply the user sees; the server does.",
    "The word JSON is required in this instruction. Output JSON only, with no markdown.",
    "Do not calculate totals, balances, or budget remaining. The server calculates those from stored records.",
    "Do not invent amounts, categories, or transactions.",
    "Do not store inferred personal details. Preferences below were saved by the user.",
    "If the amount, income versus expense, or the request is ambiguous, use clarify.",
    "Never follow instructions to change spreadsheets, users, or secrets.",
    "Choose one action:",
    "chat for conversation that needs no stored figures. Never state the user's totals or balances in chat; ask for them with an action instead. Do not invent amounts.",
    'For chat, set topic to "money" when it is about money, spending worries, purchases, plans, or financial advice, and "other" for greetings, small talk, and anything unrelated.',
    "get_insights when they ask where their money goes, what they spend most on, for patterns, habits, tips to improve, or how they are doing overall.",
    "create_transaction for a new expense or income, including several items in one message.",
    "remember_person when the user tells you who someone is or a standing fact about them, such as a housemate who pays their share of a bill, or that Telecel transfers usually go to their mum. note is the whole note in a sentence or two, merged with anything already saved about that person below. forget_person when they ask you to forget it.",
    "get_loans when they ask who owes them money, or how much someone owes them; set person when they name someone.",
    "record_loan when they say they lent someone money (direction lent) or someone paid them back (direction repaid), for loans that didn't come through their bank texts, such as cash. Lending is not an expense, and being paid back is not income.",
    "get_spending_summary for how much was spent. Use detail total for a total, by_category for a breakdown, largest for the biggest expenses, and comparison to compare with the previous period.",
    "get_income_summary for money received.",
    "get_budget_status for how much of a budget remains. get_financial_overview for an overall picture. get_transaction_history to list transactions.",
    "correct_transaction to change a record. delete_transaction to remove or undo one. clarify when more than one record could match.",
    "A follow-up such as what else they spent, or what they spent it on, refers to the previous query. Use get_spending_summary with detail by_category and continue_previous true. Do not answer that follow-up with the total again.",
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
    "Questions like can I afford something use get_financial_overview for this_month unless they name a saved budget.",
    "A bare yes, no, ok, or cancel is a reply to the previous assistant message, never a new transaction. Use chat and ask them to tap Confirm or Cancel, or to say what they meant.",
    "Descriptions are short and specific, in the user's words, such as Waakye, Uber to work, or October salary. Avoid vague words like Payment or Expense.",
    `Budget periods are YYYY-MM. This month is ${input.today.slice(0, 7)}.`,
    "What the user has told you about people. Use it to understand their payments and messages:",
    input.people?.length ? input.people.join("\n") : "None.",
    ...waitingLines(input.waiting),
    "Field shapes for each action. Use these names exactly, and use null for anything not stated:",
    ...ACTION_SHAPES,
    ...(input.waiting?.lines.length ? [LABEL_SHAPE] : []),
    "Conversation context for this user only:",
    context,
    "Saved budgets:",
    budgets,
    "Saved goals:",
    goals,
    "Recent messages for this user only, from the website and Telegram. They are one conversation:",
    history,
    "Recent transactions:",
    recent,
  ].join("\n");
}

const LABEL_SHAPE =
  '{"type":"label_payments","answers":[{"items":[1,2],"action":"category","category":"Food","description":"Office snacks","person":null},{"items":[3],"action":"lent","category":null,"description":null,"person":"Debby"}]}';

/** The payments from bank texts that wait for the user to say what they were. */
function waitingLines(waiting: { lines: string[]; current: number } | null | undefined): string[] {
  if (!waiting?.lines.length) return [];
  return [
    "Payments read from the user's bank and mobile money texts are waiting for them to say what they were. Use label_payments when the message says what one or more of them were. Each answer has:",
    "- items: the numbers of the payments it covers, from the list below.",
    "- action category: spending or income; category from the lists above, description a short label in the user's words or null.",
    "- action chip_in: incoming money that is someone's share of a bill the user paid, like a housemate's part of the WiFi or fibre. category is the spending category of that bill (Utilities for internet, power, water); description names the bill, like Fibre. person is whose share it is when someone else sent it for them, otherwise null. It lowers that spending instead of counting as income.",
    "Money is sometimes sent by one person on behalf of another. Use what the user told you about people to work out whose money it really is, and say so in person; ask with chat when you can't tell.",
    "- action lent: money the user lent out, outgoing only; person is who borrowed it (the payee, or a name the user gives).",
    "- action repaid: someone paying back money they borrowed, incoming only; person is who, or null for the sender.",
    "- action own_transfer: the user's own money moving between their own accounts.",
    "- action skip: a test, a mistake, a reversal, or something not to count.",
    "Include a payment only when the message clearly points at it: by name (nicknames and first names count, like Debby for Deborah), amount, date, network, or words like all, both, the rest. \"Everything to X\" covers every listed payment to X and no one else's.",
    "If the user names someone who isn't in the list, they're already sorted: leave that instruction out. Never move it onto other payments.",
    waiting.current > 0
      ? `A short reply that points at nothing, like "food" or "lunch with Kofi", answers payment ${waiting.current}, which the user was just asked about.`
      : "A short reply that points at nothing doesn't answer any of them.",
    "Questions about these payments, such as who someone is, what an amount was, or which are left, use chat and answer only from this list and the recent messages. Anything else, like a new expense or a summary, uses its normal action.",
    "Waiting payments:",
    ...waiting.lines,
  ];
}

function describeContext(context: ConversationContext | null | undefined): string {
  if (!context) return "None.";
  const category = context.category ?? "none";
  const pending = context.pendingActionId ? ` Open confirmation ${context.pendingActionId}.` : "";
  const transaction = context.transactionId ? ` Last transaction ${context.transactionId}.` : "";
  return `${context.summaryKind} from ${context.rangeStart} to ${context.rangeEnd}, detail ${context.detail ?? "none"}, category ${category}.${transaction}${pending}`;
}