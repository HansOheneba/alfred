import type { ThreadMessage } from "@/lib/accounts/thread";

export type Suggestion = { label: string; text: string; fill?: boolean };

/** Recording is always one tap away, so people see what they can tell Alfred. */
const ADD_EXPENSE: Suggestion = { label: "Add expense", text: "Spent ", fill: true };
const ADD_INCOME: Suggestion = { label: "Add income", text: "Received ", fill: true };

const AFTER_SUMMARY: Suggestion[] = [
  { label: "Break it down", text: "Break that down by category" },
  { label: "Compare with last month", text: "How does this compare with last month?" },
  { label: "Tips to spend less", text: "Any tips to spend less?" },
];

const AFTER_ANYTHING_ELSE: Suggestion[] = [
  { label: "How's my month?", text: "How's my month looking?" },
  { label: "Where's my money going?", text: "Where is my money going this month?" },
];

/** A reply with a chart is a summary worth digging into; anything else leads with recording. */
export function followUpsFor(last: Pick<ThreadMessage, "chart"> | undefined): Suggestion[] {
  return last?.chart ? [...AFTER_SUMMARY, ADD_EXPENSE, ADD_INCOME] : [ADD_EXPENSE, ADD_INCOME, ...AFTER_ANYTHING_ELSE];
}
