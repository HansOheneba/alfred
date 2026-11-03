import type {
  BudgetRecord,
  PendingActionRecord,
  ProcessedUpdateRecord,
  SavingsGoalRecord,
  TransactionChanges,
  TransactionRecord,
} from "@/lib/finance/types";
import type { accountBalances } from "@/lib/finance/accounting/accounts";
import type { AttentionSummary } from "@/lib/finance/accounting/types";
import type { buildAccountingView } from "@/lib/finance/accounting/view";

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
  /** Derived spending/income rows for read-only summaries. Never use these IDs/amounts for source writes. */
  listReportTransactions?(userId:string):Promise<TransactionRecord[]>;
  /** The report rows and what needs attention on the Accounts page, from one accounting read. */
  readReporting?(userId:string):Promise<{transactions:TransactionRecord[];attention:AttentionSummary|null}>;
  /** null means the additive accounting schema is not installed; never a computed cash-flow balance. */
  getAccountBalances?(userId:string,currency:string):Promise<ReturnType<typeof accountBalances>|null>;
  listLinkedLoans?(userId:string):Promise<ReturnType<typeof buildAccountingView>["loans"]>;
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

export async function readReportingTransactions(store:FinanceStore,userId:string):Promise<TransactionRecord[]> {
  if (store.readReporting) return (await store.readReporting(userId)).transactions;
  return store.listReportTransactions ? store.listReportTransactions(userId) : store.listTransactions(userId);
}

/** Report rows and what the Accounts page lists under Needs attention (null when the ledger can't say). */
export async function readReporting(store:FinanceStore,userId:string):Promise<{transactions:TransactionRecord[];attention:AttentionSummary|null}> {
  return store.readReporting ? store.readReporting(userId) : { transactions:await readReportingTransactions(store,userId), attention:null };
}
