import type { FinanceAction, LookupQuery } from "@/lib/finance/schemas";

/**
 * What Alfred is doing right now, in a few words, shown live while a reply
 * is being worked out ("Adding up this month's spending"). Steps describe
 * the work, never a result, so they can't get ahead of what's checked.
 */
export type Progress = (step: string) => void;

const PERIODS: Record<string, string> = {
  today: "today's", yesterday: "yesterday's", this_week: "this week's", last_week: "last week's",
  this_month: "this month's", last_month: "last month's", this_year: "this year's",
};

/** "this month's", or "" when the action names no relative period. */
function periodWords(action: { period?: string | null }): string {
  return action.period ? `${PERIODS[action.period] ?? ""} ` : "";
}

/** A step for a lookup, naming what's being looked for when there's one clear thing. */
export function lookupStep(queries: LookupQuery[]): string {
  const first = queries[0];
  const named = queries.length === 1 ? first?.text?.trim() || first?.person?.trim() || first?.category?.trim() : null;
  const where = { transactions: "your records", bank_payments: "your bank texts", loans: "who owes what", investments: "your investments", notes: "what you've told me" }[first?.tool ?? "transactions"];
  return named ? `Looking up ${named.slice(0, 40)} in ${where}` : `Looking through ${queries.length > 1 ? "your records" : where}`;
}

/** The step for doing an action, or null when it's quick enough not to need one. */
export function actionStep(action: FinanceAction): string | null {
  switch (action.type) {
    case "get_spending_summary": return `Adding up ${periodWords(action)}spending`.replace("  ", " ");
    case "get_income_summary": return `Adding up ${periodWords(action)}income`.replace("  ", " ");
    case "get_financial_overview": return "Putting your month together";
    case "get_insights": return "Looking for patterns in your spending";
    case "get_budget_status": return "Checking your budgets";
    case "get_transaction_history": return "Finding those payments";
    case "show_chart": return "Drawing your chart";
    case "get_investments": return "Checking your investments";
    case "create_transaction": return "Recording that";
    case "correct_transaction": return "Finding that payment to change";
    case "delete_transaction": return "Finding that payment";
    case "record_loan": return "Updating who owes what";
    case "label_payments": return "Filing that payment";
    case "file_movements": return "Sorting those payments";
    case "ask_next": return "Finding the next one to ask about";
    case "set_budget": case "create_category": case "delete_budget": return "Getting your budget ready";
    case "invest_money": case "add_investment": case "update_investment": return "Updating your investments";
    default: return null;
  }
}

/** Passes each step on once, skipping repeats, and never lets a slow listener break the reply. */
export function stepper(progress: Progress | null | undefined): Progress {
  let last = "";
  return (step) => {
    if (!progress || step === last) return;
    last = step;
    try { progress(step); } catch { /* the reply matters more than the step */ }
  };
}
