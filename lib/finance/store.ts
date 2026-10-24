import type {
  BudgetRecord,
  PendingActionRecord,
  ProcessedUpdateRecord,
  SavingsGoalRecord,
  TransactionChanges,
  TransactionRecord,
} from "@/lib/finance/types";

export type NewProcessedUpdate = Omit<ProcessedUpdateRecord, "rowNumber">;
export type NewTransaction = Omit<TransactionRecord, "rowNumber">;
export type NewBudget = Omit<BudgetRecord, "rowNumber">;
export type NewSavingsGoal = Omit<SavingsGoalRecord, "rowNumber">;
export type NewPendingAction = Omit<PendingActionRecord, "rowNumber">;

export interface FinanceStore {
  ensureReady(): Promise<void>;
  /** Every row recorded for one update id, oldest first. */
  findProcessedUpdates(updateId: string): Promise<ProcessedUpdateRecord[]>;
  /** The user's most recent completed rows, newest first. */
  latestCompletedUpdates(userId: string, limit: number): Promise<ProcessedUpdateRecord[]>;
  appendProcessedUpdate(row: NewProcessedUpdate): Promise<ProcessedUpdateRecord>;
  updateProcessedUpdate(
    rowNumber: number,
    patch: Partial<Omit<ProcessedUpdateRecord, "rowNumber" | "updateId">>,
  ): Promise<ProcessedUpdateRecord>;
  listTransactions(userId: string): Promise<TransactionRecord[]>;
  findTransactionsBySource(userId: string, sourceUpdateId: string): Promise<TransactionRecord[]>;
  appendTransaction(row: NewTransaction): Promise<TransactionRecord>;
  updateTransaction(
    userId: string,
    transactionId: string,
    patch: Partial<TransactionChanges> & { status?: TransactionRecord["status"] },
  ): Promise<TransactionRecord>;
  listBudgets(userId: string): Promise<BudgetRecord[]>;
  saveBudget(row: NewBudget): Promise<BudgetRecord>;
  /** Removes one of the user's budgets. Returns false when it wasn't found. */
  deleteBudget(userId: string, budgetId: string): Promise<boolean>;
  listSavingsGoals(userId: string): Promise<SavingsGoalRecord[]>;
  appendSavingsGoal(row: NewSavingsGoal): Promise<SavingsGoalRecord>;
  updateSavingsGoal(
    userId: string,
    goalId: string,
    patch: Partial<
      Pick<SavingsGoalRecord, "currentAmount" | "targetAmount" | "targetDate" | "status" | "name">
    >,
  ): Promise<SavingsGoalRecord>;
  listPendingActions(userId: string): Promise<PendingActionRecord[]>;
  getPendingAction(actionId: string): Promise<PendingActionRecord | null>;
  appendPendingAction(row: NewPendingAction): Promise<PendingActionRecord>;
  updatePendingAction(
    actionId: string,
    patch: Partial<Pick<PendingActionRecord, "status" | "payloadJson">>,
  ): Promise<PendingActionRecord>;
}
