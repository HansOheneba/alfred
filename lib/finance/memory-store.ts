import { AuthError, SheetsError } from "@/lib/errors";
import type { FinanceStore, NewBudget, NewPendingAction, NewProcessedUpdate, NewSavingsGoal, NewTransaction } from "@/lib/finance/store";
import type {
  BudgetRecord,
  PendingActionRecord,
  ProcessedUpdateRecord,
  SavingsGoalRecord,
  TransactionRecord,
} from "@/lib/finance/types";

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class MemoryFinanceStore implements FinanceStore {
  private processed: ProcessedUpdateRecord[] = [];
  private transactions: TransactionRecord[] = [];
  private budgets: BudgetRecord[] = [];
  private goals: SavingsGoalRecord[] = [];
  private pending: PendingActionRecord[] = [];
  private nextRow = 2;
  appendFailures = 0;
  failDescriptions = new Set<string>();

  failNextTransactionAppends(count: number): void {
    this.appendFailures = count;
  }

  async ensureReady(): Promise<void> {}

  async listProcessedUpdates(): Promise<ProcessedUpdateRecord[]> {
    return this.processed.map(clone);
  }

  async appendProcessedUpdate(row: NewProcessedUpdate): Promise<ProcessedUpdateRecord> {
    const record = { ...row, rowNumber: this.nextRow++ };
    this.processed.push(record);
    return clone(record);
  }

  async updateProcessedUpdate(
    rowNumber: number,
    patch: Partial<Omit<ProcessedUpdateRecord, "rowNumber" | "updateId">>,
  ): Promise<ProcessedUpdateRecord> {
    const record = this.processed.find((item) => item.rowNumber === rowNumber);
    if (!record) throw new SheetsError("missing_row", "Processed update row was not found.");
    Object.assign(record, patch);
    return clone(record);
  }

  async listTransactions(userId: string): Promise<TransactionRecord[]> {
    return this.transactions.filter((item) => item.userId === userId).map(clone);
  }

  async findTransactionsBySource(
    userId: string,
    sourceUpdateId: string,
  ): Promise<TransactionRecord[]> {
    return this.transactions
      .filter((item) => item.userId === userId && item.sourceUpdateId === sourceUpdateId)
      .map(clone);
  }

  async appendTransaction(row: NewTransaction): Promise<TransactionRecord> {
    if (this.appendFailures > 0) {
      this.appendFailures -= 1;
      throw new SheetsError("unavailable", "Simulated sheet write failure.");
    }
    if (this.failDescriptions.has(row.description)) {
      throw new SheetsError("unavailable", "Simulated sheet write failure.");
    }
    const record = { ...row, rowNumber: this.nextRow++ };
    this.transactions.push(record);
    return clone(record);
  }

  async updateTransaction(
    userId: string,
    transactionId: string,
    patch: Partial<TransactionRecord> & { date?: string; transactionType?: TransactionRecord["type"] },
  ): Promise<TransactionRecord> {
    const record = this.transactions.find((item) => item.transactionId === transactionId);
    if (!record || record.userId !== userId) throw new AuthError();
    if (patch.amount) record.amount = patch.amount;
    if (patch.category) record.category = patch.category;
    if (patch.description) record.description = patch.description;
    if (patch.date) record.transactionDate = patch.date;
    if (patch.transactionType) record.type = patch.transactionType;
    if (patch.status) record.status = patch.status;
    record.updatedAt = new Date().toISOString();
    return clone(record);
  }

  async listBudgets(userId: string): Promise<BudgetRecord[]> {
    return this.budgets.filter((item) => item.userId === userId).map(clone);
  }

  async saveBudget(row: NewBudget): Promise<BudgetRecord> {
    const existing = this.budgets.find(
      (item) =>
        item.userId === row.userId &&
        item.period === row.period &&
        item.category === row.category &&
        item.currency === row.currency,
    );
    if (existing) {
      existing.amount = row.amount;
      existing.updatedAt = row.updatedAt;
      return clone(existing);
    }
    const record = { ...row, rowNumber: this.nextRow++ };
    this.budgets.push(record);
    return clone(record);
  }

  async listSavingsGoals(userId: string): Promise<SavingsGoalRecord[]> {
    return this.goals.filter((item) => item.userId === userId && item.status !== "deleted").map(clone);
  }

  async appendSavingsGoal(row: NewSavingsGoal): Promise<SavingsGoalRecord> {
    const record = { ...row, rowNumber: this.nextRow++ };
    this.goals.push(record);
    return clone(record);
  }

  async updateSavingsGoal(
    userId: string,
    goalId: string,
    patch: Partial<Pick<SavingsGoalRecord, "currentAmount" | "targetAmount" | "targetDate" | "status" | "name">>,
  ): Promise<SavingsGoalRecord> {
    const record = this.goals.find((item) => item.goalId === goalId);
    if (!record || record.userId !== userId) throw new AuthError();
    Object.assign(record, patch, { updatedAt: new Date().toISOString() });
    return clone(record);
  }

  async listPendingActions(userId: string): Promise<PendingActionRecord[]> {
    return this.pending.filter((item) => item.userId === userId).map(clone);
  }

  async getPendingAction(actionId: string): Promise<PendingActionRecord | null> {
    const record = this.pending.find((item) => item.actionId === actionId);
    return record ? clone(record) : null;
  }

  async appendPendingAction(row: NewPendingAction): Promise<PendingActionRecord> {
    const record = { ...row, rowNumber: this.nextRow++ };
    this.pending.push(record);
    return clone(record);
  }

  async updatePendingAction(
    actionId: string,
    patch: Partial<Pick<PendingActionRecord, "status" | "payloadJson">>,
  ): Promise<PendingActionRecord> {
    const record = this.pending.find((item) => item.actionId === actionId);
    if (!record) throw new SheetsError("missing_row", "Pending action was not found.");
    Object.assign(record, patch);
    return clone(record);
  }
}
