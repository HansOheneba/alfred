import type { GoogleSettings } from "@/lib/config";
import { AuthError, SheetsError } from "@/lib/errors";
import type { FinanceStore, NewBudget, NewPendingAction, NewProcessedUpdate, NewSavingsGoal, NewTransaction } from "@/lib/finance/store";
import type {
  BudgetRecord,
  GoalStatus,
  PendingActionRecord,
  PendingStatus,
  ProcessedStatus,
  ProcessedUpdateRecord,
  SavingsGoalRecord,
  TransactionChanges,
  TransactionRecord,
  TransactionStatus,
  TransactionType,
} from "@/lib/finance/types";
import { getGoogleAccessToken } from "@/lib/google/auth";
import {
  HEADERS,
  SHEET_NAMES,
  type SheetKey,
  fullRange,
  headerRange,
  rowRange,
} from "@/lib/google/layout";
import { createSheetsClient, type SheetsClient } from "@/lib/google/sheets";

const readySheets = new Map<string, Promise<void>>();

export function resetSheetsReadyCache(): void {
  readySheets.clear();
}

function cellsOf(row: string[], width: number): string[] {
  return Array.from({ length: width }, (_, index) => row[index] ?? "");
}

async function prepare(client: SheetsClient): Promise<void> {
  let titles = await client.getSheetTitles();
  for (const key of Object.keys(HEADERS) as SheetKey[]) {
    const title = SHEET_NAMES[key];
    if (!titles.includes(title)) {
      await client.addSheet(title);
      titles = [...titles, title];
    }
    const expected = [...HEADERS[key]];
    const rows = await client.getValues(headerRange(title, expected.length));
    const header = rows[0] ?? [];
    if (header.length === 0 || header.every((cell) => cell.trim() === "")) {
      await client.updateValues(headerRange(title, expected.length), [expected]);
      continue;
    }
    const actual = cellsOf(header, expected.length);
    if (actual.some((cell, index) => cell !== expected[index])) {
      throw new SheetsError(
        "headers",
        `Worksheet ${title} headers do not match the expected layout. Existing rows were not changed.`,
      );
    }
  }
}

function isType(value: string): value is TransactionType {
  return value === "income" || value === "expense";
}

function isTransactionStatus(value: string): value is TransactionStatus {
  return value === "active" || value === "deleted";
}

function isGoalStatus(value: string): value is GoalStatus {
  return value === "active" || value === "completed" || value === "deleted";
}

function isProcessedStatus(value: string): value is ProcessedStatus {
  return (
    value === "processing" ||
    value === "completed" ||
    value === "failed" ||
    value === "duplicate_skipped"
  );
}

function isPendingStatus(value: string): value is PendingStatus {
  return (
    value === "pending" ||
    value === "processing" ||
    value === "completed" ||
    value === "cancelled" ||
    value === "expired"
  );
}

export function createGoogleFinanceStore(input: {
  spreadsheetId: string;
  client: SheetsClient;
}): FinanceStore {
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const ensureReadyUnqueued = (): Promise<void> => {
    const existing = readySheets.get(input.spreadsheetId);
    if (existing) return existing;
    const promise = prepare(input.client).catch((error: unknown) => {
      readySheets.delete(input.spreadsheetId);
      throw error;
    });
    readySheets.set(input.spreadsheetId, promise);
    return promise;
  };

  async function readSheet(key: SheetKey): Promise<{ rowNumber: number; cells: string[] }[]> {
    const width = HEADERS[key].length;
    const rows = await input.client.getValues(fullRange(SHEET_NAMES[key], width));
    return rows.slice(1).flatMap((row, index) => {
      if (row.every((cell) => cell.trim() === "")) return [];
      return [{ rowNumber: index + 2, cells: cellsOf(row, width) }];
    });
  }

  async function writeVerified(
    key: SheetKey,
    rowNumber: number,
    values: string[],
    idIndex: number,
    id: string,
  ): Promise<void> {
    const range = rowRange(SHEET_NAMES[key], rowNumber, values.length);
    await input.client.updateValues(range, [values]);
    const written = await input.client.getValues(range);
    if ((written[0]?.[idIndex] ?? "") !== id) {
      throw new SheetsError("verify", "The spreadsheet update could not be confirmed.");
    }
  }

  async function appendVerified(key: SheetKey, values: string[], idIndex: number, id: string): Promise<number> {
    const appended = await input.client.appendValues(fullRange(SHEET_NAMES[key], values.length), [values]);
    const rows = await readSheet(key);
    const matches = rows.filter((row) => row.cells[idIndex] === id);
    if (matches.length === 0) {
      throw new SheetsError("verify", "The spreadsheet write could not be confirmed.");
    }
    const keeper = matches[0];
    if (appended.updatedRange && !appended.updatedRange.includes(String(keeper.rowNumber))) {
      return keeper.rowNumber;
    }
    return keeper.rowNumber;
  }

  function transactionFrom(cells: string[], rowNumber: number): TransactionRecord | null {
    const [
      transactionId,
      createdAt,
      transactionDate,
      userId,
      type,
      amount,
      currency,
      category,
      description,
      paymentMethod,
      notes,
      status,
      updatedAt,
      sourceUpdateId,
    ] = cells;
    if (!transactionId || !userId || !isType(type) || !isTransactionStatus(status)) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(transactionDate)) return null;
    return {
      transactionId,
      createdAt,
      transactionDate,
      userId,
      type,
      amount,
      currency,
      category,
      description,
      paymentMethod,
      notes,
      status,
      updatedAt,
      sourceUpdateId,
      rowNumber,
    };
  }

  function transactionRow(record: TransactionRecord): string[] {
    return [
      record.transactionId,
      record.createdAt,
      record.transactionDate,
      record.userId,
      record.type,
      record.amount,
      record.currency,
      record.category,
      record.description,
      record.paymentMethod,
      record.notes,
      record.status,
      record.updatedAt,
      record.sourceUpdateId,
    ];
  }

  async function requireTransaction(userId: string, transactionId: string): Promise<TransactionRecord> {
    const rows = await readSheet("transactions");
    const parsed = rows
      .map((row) => transactionFrom(row.cells, row.rowNumber))
      .filter((row): row is TransactionRecord => row !== null);
    const owned = parsed.find((row) => row.transactionId === transactionId && row.userId === userId);
    if (owned) return owned;
    if (parsed.some((row) => row.transactionId === transactionId)) throw new AuthError();
    throw new SheetsError("missing_row", "Transaction was not found.");
  }

  async function readProcessedUnqueued(): Promise<ProcessedUpdateRecord[]> {
    await ensureReadyUnqueued();
    const rows = await readSheet("processed");
    return rows.flatMap((row) => {
      const [updateId, userId, status, resultReference, processedAt] = row.cells;
      if (!updateId || !isProcessedStatus(status)) return [];
      const record: ProcessedUpdateRecord = {
        updateId,
        userId,
        status,
        resultReference,
        processedAt,
        rowNumber: row.rowNumber,
      };
      return [record];
    });
  }

  return {
    ensureReady() {
      return enqueue(ensureReadyUnqueued);
    },
    findProcessedUpdates(updateId: string) {
      return enqueue(async () =>
        (await readProcessedUnqueued())
          .filter((row) => row.updateId === updateId)
          .sort((left, right) => left.rowNumber - right.rowNumber),
      );
    },
    latestCompletedUpdates(userId: string, limit: number) {
      return enqueue(async () =>
        (await readProcessedUnqueued())
          .filter((row) => row.userId === userId && row.status === "completed")
          .sort((left, right) => right.rowNumber - left.rowNumber)
          .slice(0, limit),
      );
    },
    appendProcessedUpdate(row: NewProcessedUpdate) {
      return enqueue(async () => {
        await ensureReadyUnqueued();
        const values = [row.updateId, row.userId, row.status, row.resultReference, row.processedAt];
        await input.client.appendValues(fullRange(SHEET_NAMES.processed, values.length), [values]);
        const rows = await readSheet("processed");
        const mine = rows.filter((item) => item.cells[3] === row.resultReference);
        const created = mine[mine.length - 1];
        if (!created) {
          throw new SheetsError("verify", "The spreadsheet write could not be confirmed.");
        }
        return { ...row, rowNumber: created.rowNumber };
      });
    },
    updateProcessedUpdate(rowNumber, patch) {
      return enqueue(async () => {
        await ensureReadyUnqueued();
        const rows = await readSheet("processed");
        const current = rows.find((row) => row.rowNumber === rowNumber);
        if (!current) throw new SheetsError("missing_row", "Processed update row was not found.");
        const [updateId, userId, status, resultReference, processedAt] = current.cells;
        if (!isProcessedStatus(status)) {
          throw new SheetsError("missing_row", "Processed update row was not found.");
        }
        const next: ProcessedUpdateRecord = {
          updateId,
          userId: patch.userId ?? userId,
          status: patch.status ?? status,
          resultReference: patch.resultReference ?? resultReference,
          processedAt: patch.processedAt ?? processedAt,
          rowNumber,
        };
        await writeVerified(
          "processed",
          rowNumber,
          [next.updateId, next.userId, next.status, next.resultReference, next.processedAt],
          0,
          next.updateId,
        );
        return next;
      });
    },
    listTransactions(userId) {
      return enqueue(async () => {
        await ensureReadyUnqueued();
        const rows = await readSheet("transactions");
        return rows.flatMap((row) => {
          const record = transactionFrom(row.cells, row.rowNumber);
          return record && record.userId === userId ? [record] : [];
        });
      });
    },
    findTransactionsBySource(userId, sourceUpdateId) {
      return enqueue(async () => {
        await ensureReadyUnqueued();
        const rows = await readSheet("transactions");
        return rows.flatMap((row) => {
          const record = transactionFrom(row.cells, row.rowNumber);
          return record && record.userId === userId && record.sourceUpdateId === sourceUpdateId
            ? [record]
            : [];
        });
      });
    },
    appendTransaction(row: NewTransaction) {
      return enqueue(async () => {
        await ensureReadyUnqueued();
        const record: TransactionRecord = { ...row, rowNumber: 0 };
        const rowNumber = await appendVerified("transactions", transactionRow(record), 0, row.transactionId);
        return { ...record, rowNumber };
      });
    },
    updateTransaction(userId, transactionId, patch: Partial<TransactionChanges> & { status?: TransactionRecord["status"] }) {
      return enqueue(async () => {
        await ensureReadyUnqueued();
        const current = await requireTransaction(userId, transactionId);
        const next: TransactionRecord = {
          ...current,
          amount: patch.amount ?? current.amount,
          category: patch.category ?? current.category,
          description: patch.description ?? current.description,
          transactionDate: patch.date ?? current.transactionDate,
          type: patch.transactionType ?? current.type,
          status: patch.status ?? current.status,
          updatedAt: new Date().toISOString(),
        };
        await writeVerified("transactions", current.rowNumber, transactionRow(next), 0, next.transactionId);
        return next;
      });
    },
    listBudgets(userId) {
      return enqueue(async () => {
        await ensureReadyUnqueued();
        const rows = await readSheet("budgets");
        return rows.flatMap((row) => {
          const [budgetId, owner, period, category, amount, currency, createdAt, updatedAt] = row.cells;
          if (!budgetId || owner !== userId) return [];
          const record: BudgetRecord = {
            budgetId,
            userId: owner,
            period,
            category,
            amount,
            currency,
            createdAt,
            updatedAt,
            rowNumber: row.rowNumber,
          };
          return [record];
        });
      });
    },
    saveBudget(row: NewBudget) {
      return enqueue(async () => {
        await ensureReadyUnqueued();
        const rows = await readSheet("budgets");
        const existing = rows.find((item) => {
          const [budgetId, owner, period, category, , currency] = item.cells;
          return (
            Boolean(budgetId) &&
            owner === row.userId &&
            period === row.period &&
            category === row.category &&
            currency === row.currency
          );
        });
        if (existing) {
          const [budgetId, , , , , , createdAt] = existing.cells;
          const next: BudgetRecord = { ...row, budgetId, createdAt, rowNumber: existing.rowNumber };
          const values = [
            next.budgetId,
            next.userId,
            next.period,
            next.category,
            next.amount,
            next.currency,
            next.createdAt,
            next.updatedAt,
          ];
          await writeVerified("budgets", existing.rowNumber, values, 0, next.budgetId);
          return next;
        }
        const values = [
          row.budgetId,
          row.userId,
          row.period,
          row.category,
          row.amount,
          row.currency,
          row.createdAt,
          row.updatedAt,
        ];
        const rowNumber = await appendVerified("budgets", values, 0, row.budgetId);
        return { ...row, rowNumber };
      });
    },
    listSavingsGoals(userId) {
      return enqueue(async () => {
        await ensureReadyUnqueued();
        const rows = await readSheet("savings");
        return rows.flatMap((row) => {
          const [
            goalId,
            owner,
            name,
            targetAmount,
            currentAmount,
            currency,
            targetDate,
            status,
            createdAt,
            updatedAt,
          ] = row.cells;
          if (!goalId || owner !== userId || !isGoalStatus(status) || status === "deleted") return [];
          const record: SavingsGoalRecord = {
            goalId,
            userId: owner,
            name,
            targetAmount,
            currentAmount,
            currency,
            targetDate,
            status,
            createdAt,
            updatedAt,
            rowNumber: row.rowNumber,
          };
          return [record];
        });
      });
    },
    appendSavingsGoal(row: NewSavingsGoal) {
      return enqueue(async () => {
        await ensureReadyUnqueued();
        const values = [
          row.goalId,
          row.userId,
          row.name,
          row.targetAmount,
          row.currentAmount,
          row.currency,
          row.targetDate,
          row.status,
          row.createdAt,
          row.updatedAt,
        ];
        const rowNumber = await appendVerified("savings", values, 0, row.goalId);
        return { ...row, rowNumber };
      });
    },
    updateSavingsGoal(userId, goalId, patch) {
      return enqueue(async () => {
        await ensureReadyUnqueued();
        const rows = await readSheet("savings");
        const parsed = rows.flatMap((row) => {
          const [
            id,
            owner,
            name,
            targetAmount,
            currentAmount,
            currency,
            targetDate,
            status,
            createdAt,
            updatedAt,
          ] = row.cells;
          if (!id || !isGoalStatus(status)) return [];
          const record: SavingsGoalRecord = {
            goalId: id,
            userId: owner,
            name,
            targetAmount,
            currentAmount,
            currency,
            targetDate,
            status,
            createdAt,
            updatedAt,
            rowNumber: row.rowNumber,
          };
          return [record];
        });
        const current = parsed.find((row) => row.goalId === goalId && row.userId === userId);
        if (!current) {
          if (parsed.some((row) => row.goalId === goalId)) throw new AuthError();
          throw new SheetsError("missing_row", "Savings goal was not found.");
        }
        const next: SavingsGoalRecord = {
          ...current,
          ...patch,
          updatedAt: new Date().toISOString(),
        };
        const values = [
          next.goalId,
          next.userId,
          next.name,
          next.targetAmount,
          next.currentAmount,
          next.currency,
          next.targetDate,
          next.status,
          next.createdAt,
          next.updatedAt,
        ];
        await writeVerified("savings", current.rowNumber, values, 0, next.goalId);
        return next;
      });
    },
    listPendingActions(userId) {
      return enqueue(async () => {
        await ensureReadyUnqueued();
        const rows = await readSheet("pending");
        return rows.flatMap((row) => {
          const [actionId, owner, chatId, actionType, payloadJson, status, expiresAt, createdAt] = row.cells;
          if (!actionId || owner !== userId || !isPendingStatus(status)) return [];
          const record: PendingActionRecord = {
            actionId,
            userId: owner,
            chatId,
            actionType,
            payloadJson,
            status,
            expiresAt,
            createdAt,
            rowNumber: row.rowNumber,
          };
          return [record];
        });
      });
    },
    getPendingAction(actionId) {
      return enqueue(async () => {
        await ensureReadyUnqueued();
        const rows = await readSheet("pending");
        for (const row of rows) {
          const [id, userId, chatId, actionType, payloadJson, status, expiresAt, createdAt] = row.cells;
          if (id !== actionId || !isPendingStatus(status)) continue;
          const record: PendingActionRecord = {
            actionId: id,
            userId,
            chatId,
            actionType,
            payloadJson,
            status,
            expiresAt,
            createdAt,
            rowNumber: row.rowNumber,
          };
          return record;
        }
        return null;
      });
    },
    appendPendingAction(row: NewPendingAction) {
      return enqueue(async () => {
        await ensureReadyUnqueued();
        const values = [
          row.actionId,
          row.userId,
          row.chatId,
          row.actionType,
          row.payloadJson,
          row.status,
          row.expiresAt,
          row.createdAt,
        ];
        const rowNumber = await appendVerified("pending", values, 0, row.actionId);
        return { ...row, rowNumber };
      });
    },
    updatePendingAction(actionId, patch) {
      return enqueue(async () => {
        await ensureReadyUnqueued();
        const rows = await readSheet("pending");
        const current = rows.find((row) => row.cells[0] === actionId);
        if (!current || !isPendingStatus(current.cells[5] ?? "")) {
          throw new SheetsError("missing_row", "Pending action was not found.");
        }
        const [id, userId, chatId, actionType, payloadJson, status, expiresAt, createdAt] = current.cells;
        const next: PendingActionRecord = {
          actionId: id,
          userId,
          chatId,
          actionType,
          payloadJson: patch.payloadJson ?? payloadJson,
          status: patch.status ?? (status as PendingStatus),
          expiresAt,
          createdAt,
          rowNumber: current.rowNumber,
        };
        const values = [
          next.actionId,
          next.userId,
          next.chatId,
          next.actionType,
          next.payloadJson,
          next.status,
          next.expiresAt,
          next.createdAt,
        ];
        await writeVerified("pending", current.rowNumber, values, 0, next.actionId);
        return next;
      });
    },
  };
}

export function createSheetsFinanceStore(
  settings: GoogleSettings,
  fetchImpl?: typeof fetch,
): FinanceStore {
  const client = createSheetsClient({
    spreadsheetId: settings.spreadsheetId,
    getAccessToken: () => getGoogleAccessToken(settings, fetchImpl),
    fetchImpl,
  });
  return createGoogleFinanceStore({ spreadsheetId: settings.spreadsheetId, client });
}
