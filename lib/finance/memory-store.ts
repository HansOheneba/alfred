import { AuthError, DatabaseError, SheetsError } from "@/lib/errors";
import { validCategoryBudget, validateCategoryName } from "@/lib/finance/categories";
import type { BudgetSnapshot, FinanceStore, NewBudget, NewCategory, NewPendingAction, NewProcessedUpdate, NewSavingsGoal, NewTransaction } from "@/lib/finance/store";
import type {
  BudgetRecord,
  CategoryRecord,
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
  private categories: CategoryRecord[] = [];
  private goals: SavingsGoalRecord[] = [];
  private pending: PendingActionRecord[] = [];
  private nextRow = 2;
  appendFailures = 0;
  failDescriptions = new Set<string>();

  failNextTransactionAppends(count: number): void {
    this.appendFailures = count;
  }

  async ensureReady(): Promise<void> {}

  /** Test helper: every processed row. Not part of FinanceStore. */
  async listProcessedUpdates(): Promise<ProcessedUpdateRecord[]> {
    return this.processed.map(clone);
  }

  async findProcessedUpdates(updateId: string): Promise<ProcessedUpdateRecord[]> {
    return this.processed
      .filter((item) => item.updateId === updateId)
      .sort((left, right) => left.rowNumber - right.rowNumber)
      .map(clone);
  }

  async latestCompletedUpdates(userId: string, limit: number): Promise<ProcessedUpdateRecord[]> {
    return this.processed
      .filter((item) => item.userId === userId && item.status === "completed")
      .sort((left, right) => right.rowNumber - left.rowNumber)
      .slice(0, limit)
      .map(clone);
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

  async listCategories(userId: string): Promise<CategoryRecord[]> {
    return this.categories.filter((item) => item.userId === userId).map(clone);
  }

  async createCategory(row: NewCategory, budget?: NewBudget): Promise<CategoryRecord> {
    const validated = validateCategoryName(row.name, row.type, this.categories.filter((item) => item.userId === row.userId));
    if (!validated.ok) throw new SheetsError("verify", validated.message);
    if (budget && !validCategoryBudget(row, validated.name, budget)) throw new AuthError("The category budget is invalid. Nothing was changed.");
    const existing = this.categories.find((item) => item.userId === row.userId && item.type === row.type && item.name.toLowerCase() === validated.name.toLowerCase());
    if (!existing && this.categories.some((item) => item.categoryId === row.categoryId)) throw new DatabaseError("That category identity is already in use.", "23505");
    const category = existing ?? { ...row, name: validated.name, rowNumber: this.nextRow };
    // Validate and stage every value before committing either half. No await or externally overridden write can split this commit.
    const currentBudget = budget && this.budgets.find((item) => item.userId === row.userId && item.period === budget.period && item.category === category.name && item.currency === budget.currency);
    if (currentBudget) throw new DatabaseError("A budget already exists for that category, month and currency. Nothing was changed.", "23505");
    if (!existing) { this.nextRow++; this.categories.push(category); }
    if (budget) {
      this.budgets.push({ ...budget, category: category.name, rowNumber: this.nextRow++ });
    }
    return clone(category);
  }

  async deleteBudget(userId: string, budgetId: string, expected?: BudgetSnapshot): Promise<boolean> {
    const index = this.budgets.findIndex((item) => item.userId === userId && item.budgetId === budgetId
      && (!expected || (["period", "category", "amount", "currency", "updatedAt"] as const).every((field) => item[field] === expected[field])));
    if (index < 0) return false;
    this.budgets.splice(index, 1);
    return true;
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
