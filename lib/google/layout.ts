export const SHEET_NAMES = {
  transactions: "Transactions",
  budgets: "Budgets",
  savings: "SavingsGoals",
  processed: "ProcessedUpdates",
  pending: "PendingActions",
} as const;

export const HEADERS = {
  transactions: [
    "transaction_id",
    "created_at",
    "transaction_date",
    "user_id",
    "type",
    "amount",
    "currency",
    "category",
    "description",
    "payment_method",
    "notes",
    "status",
    "updated_at",
    "source_update_id",
  ],
  budgets: [
    "budget_id",
    "user_id",
    "period",
    "category",
    "amount",
    "currency",
    "created_at",
    "updated_at",
  ],
  savings: [
    "goal_id",
    "user_id",
    "name",
    "target_amount",
    "current_amount",
    "currency",
    "target_date",
    "status",
    "created_at",
    "updated_at",
  ],
  processed: ["update_id", "user_id", "status", "result_reference", "processed_at"],
  pending: [
    "action_id",
    "user_id",
    "chat_id",
    "action_type",
    "payload_json",
    "status",
    "expires_at",
    "created_at",
  ],
} as const;

export type SheetKey = keyof typeof HEADERS;

export function columnLetter(count: number): string {
  let remaining = count;
  let letters = "";
  while (remaining > 0) {
    const index = (remaining - 1) % 26;
    letters = String.fromCharCode(65 + index) + letters;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return letters;
}

export function fullRange(title: string, width: number): string {
  return `${title}!A:${columnLetter(width)}`;
}

export function headerRange(title: string, width: number): string {
  return `${title}!A1:${columnLetter(width)}1`;
}

export function rowRange(title: string, rowNumber: number, width: number): string {
  const end = columnLetter(width);
  return `${title}!A${rowNumber}:${end}${rowNumber}`;
}
