export type TransactionType = "income" | "expense";
export type TransactionStatus = "active" | "deleted";
export type GoalStatus = "active" | "completed" | "deleted";
export type PendingStatus = "pending" | "processing" | "completed" | "cancelled" | "expired";
export type ProcessedStatus = "processing" | "completed" | "failed" | "duplicate_skipped";

export type TransactionRecord = {
  transactionId: string;
  createdAt: string;
  transactionDate: string;
  userId: string;
  type: TransactionType;
  amount: string;
  currency: string;
  category: string;
  description: string;
  paymentMethod: string;
  notes: string;
  status: TransactionStatus;
  updatedAt: string;
  sourceUpdateId: string;
  rowNumber: number;
};

export type BudgetRecord = {
  budgetId: string;
  userId: string;
  period: string;
  category: string;
  amount: string;
  currency: string;
  createdAt: string;
  updatedAt: string;
  rowNumber: number;
};

export type SavingsGoalRecord = {
  goalId: string;
  userId: string;
  name: string;
  targetAmount: string;
  currentAmount: string;
  currency: string;
  targetDate: string;
  status: GoalStatus;
  createdAt: string;
  updatedAt: string;
  rowNumber: number;
};

export type ProcessedUpdateRecord = {
  updateId: string;
  userId: string;
  status: ProcessedStatus;
  resultReference: string;
  processedAt: string;
  rowNumber: number;
};

export type PendingActionRecord = {
  actionId: string;
  userId: string;
  chatId: string;
  actionType: string;
  payloadJson: string;
  status: PendingStatus;
  expiresAt: string;
  createdAt: string;
  rowNumber: number;
};

export type TransactionDraft = {
  transactionType: TransactionType;
  amount: string;
  currency: string;
  category: string;
  description: string;
  date: string;
  paymentMethod: string;
  notes: string;
};

export type TransactionChanges = {
  amount?: string;
  category?: string;
  description?: string;
  date?: string;
  transactionType?: TransactionType;
};
