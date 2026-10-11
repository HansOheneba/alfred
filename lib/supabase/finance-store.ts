import type { SupabaseSettings } from "@/lib/config";
import { AuthError, DatabaseError, SheetsError } from "@/lib/errors";
import { canonicalizeAmount } from "@/lib/finance/money";
import type { FinanceStore } from "@/lib/finance/store";
import type {
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
import { query } from "@/lib/supabase/connection";

type TransactionRow = {
  id: string;
  transaction_id: string;
  created_at: Date;
  transaction_date: string;
  user_id: string;
  type: TransactionType;
  amount: string;
  currency: string;
  category: string;
  description: string;
  payment_method: string;
  notes: string;
  status: TransactionStatus;
  updated_at: Date;
  source_update_id: string;
};

function money(value: string, allowZero = false): string {
  const canonical = canonicalizeAmount(value, { allowZero });
  if (!canonical) throw new DatabaseError("The ledger returned an amount that could not be read.");
  return canonical;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function transactionFrom(row: TransactionRow): TransactionRecord {
  return {
    transactionId: row.transaction_id,
    createdAt: iso(row.created_at),
    transactionDate: row.transaction_date,
    userId: row.user_id,
    type: row.type,
    amount: money(row.amount),
    currency: row.currency.trim(),
    category: row.category,
    description: row.description,
    paymentMethod: row.payment_method,
    notes: row.notes,
    status: row.status,
    updatedAt: iso(row.updated_at),
    sourceUpdateId: row.source_update_id,
    rowNumber: Number(row.id),
  };
}

export function createSupabaseFinanceStore(settings: SupabaseSettings): FinanceStore {
  return {
    async ensureReady() {
      const rows = await query<{ ready: boolean }>(
        settings,
        "select to_regclass('public.transactions') is not null as ready",
      );
      if (!rows[0]?.ready) {
        throw new DatabaseError("The ledger tables are not ready. Run the database migration.");
      }
    },

    async listProcessedUpdates() {
      const rows = await query<{
        id: string;
        update_id: string;
        user_id: string;
        status: ProcessedStatus;
        result_reference: string;
        processed_at: Date;
      }>(settings, "select id, update_id, user_id, status, result_reference, processed_at from public.processed_updates order by id");
      return rows.map((row) => ({
        updateId: row.update_id,
        userId: row.user_id,
        status: row.status,
        resultReference: row.result_reference,
        processedAt: iso(row.processed_at),
        rowNumber: Number(row.id),
      }));
    },

    async appendProcessedUpdate(row) {
      const inserted = await query<{ id: string }>(
        settings,
        `insert into public.processed_updates (update_id, user_id, status, result_reference, processed_at)
         values ($1, $2, $3, $4, $5)
         returning id`,
        [row.updateId, row.userId, row.status, row.resultReference, row.processedAt],
      );
      const id = inserted[0]?.id;
      if (!id) throw new DatabaseError("The ledger did not confirm the update claim.");
      return { ...row, rowNumber: Number(id) };
    },

    async updateProcessedUpdate(rowNumber, patch) {
      const current = await query<{
        id: string;
        update_id: string;
        user_id: string;
        status: ProcessedStatus;
        result_reference: string;
        processed_at: Date;
      }>(settings, "select id, update_id, user_id, status, result_reference, processed_at from public.processed_updates where id = $1", [
        rowNumber,
      ]);
      const row = current[0];
      if (!row) throw new SheetsError("missing_row", "Processed update row was not found.");
      const next: ProcessedUpdateRecord = {
        updateId: row.update_id,
        userId: patch.userId ?? row.user_id,
        status: patch.status ?? row.status,
        resultReference: patch.resultReference ?? row.result_reference,
        processedAt: patch.processedAt ?? iso(row.processed_at),
        rowNumber,
      };
      await query(
        settings,
        `update public.processed_updates
         set user_id = $2, status = $3, result_reference = $4, processed_at = $5
         where id = $1`,
        [rowNumber, next.userId, next.status, next.resultReference, next.processedAt],
      );
      return next;
    },

    async listTransactions(userId) {
      const rows = await query<TransactionRow>(
        settings,
        `select id, transaction_id, created_at, transaction_date::text, user_id, type, amount::text, currency,
                category, description, payment_method, notes, status, updated_at, source_update_id
         from public.transactions
         where user_id = $1
         order by transaction_date, id`,
        [userId],
      );
      return rows.map(transactionFrom);
    },

    async findTransactionsBySource(userId, sourceUpdateId) {
      const rows = await query<TransactionRow>(
        settings,
        `select id, transaction_id, created_at, transaction_date::text, user_id, type, amount::text, currency,
                category, description, payment_method, notes, status, updated_at, source_update_id
         from public.transactions
         where user_id = $1 and source_update_id = $2`,
        [userId, sourceUpdateId],
      );
      return rows.map(transactionFrom);
    },

    async appendTransaction(row) {
      const inserted = await query<{ id: string }>(
        settings,
        `insert into public.transactions (
           transaction_id, created_at, transaction_date, user_id, type, amount, currency, category,
           description, payment_method, notes, status, updated_at, source_update_id
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         returning id`,
        [
          row.transactionId,
          row.createdAt,
          row.transactionDate,
          row.userId,
          row.type,
          row.amount,
          row.currency,
          row.category,
          row.description,
          row.paymentMethod,
          row.notes,
          row.status,
          row.updatedAt,
          row.sourceUpdateId,
        ],
      );
      const id = inserted[0]?.id;
      if (!id) throw new DatabaseError("The ledger did not confirm the transaction.");
      return { ...row, rowNumber: Number(id) };
    },

    async updateTransaction(userId, transactionId, patch) {
      const current = await query<TransactionRow>(
        settings,
        `select id, transaction_id, created_at, transaction_date::text, user_id, type, amount::text, currency,
                category, description, payment_method, notes, status, updated_at, source_update_id
         from public.transactions
         where transaction_id = $1`,
        [transactionId],
      );
      const row = current[0];
      if (!row || row.user_id !== userId) throw new AuthError();
      const next = applyTransactionPatch(transactionFrom(row), patch);
      await query(
        settings,
        `update public.transactions
         set amount = $3, category = $4, description = $5, transaction_date = $6, type = $7, status = $8, updated_at = $9
         where transaction_id = $1 and user_id = $2`,
        [
          transactionId,
          userId,
          next.amount,
          next.category,
          next.description,
          next.transactionDate,
          next.type,
          next.status,
          next.updatedAt,
        ],
      );
      return next;
    },

    async listBudgets(userId) {
      const rows = await query<{
        id: string;
        budget_id: string;
        user_id: string;
        period: string;
        category: string;
        amount: string;
        currency: string;
        created_at: Date;
        updated_at: Date;
      }>(
        settings,
        `select id, budget_id, user_id, period, category, amount::text, currency, created_at, updated_at
         from public.budgets where user_id = $1 order by id`,
        [userId],
      );
      return rows.map((row) => ({
        budgetId: row.budget_id,
        userId: row.user_id,
        period: row.period,
        category: row.category,
        amount: money(row.amount, true),
        currency: row.currency.trim(),
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
        rowNumber: Number(row.id),
      }));
    },

    async saveBudget(row) {
      const saved = await query<{ id: string; created_at: Date }>(
        settings,
        `insert into public.budgets (budget_id, user_id, period, category, amount, currency, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (user_id, period, category, currency)
         do update set amount = excluded.amount, updated_at = excluded.updated_at
         returning id, created_at`,
        [row.budgetId, row.userId, row.period, row.category, row.amount, row.currency, row.createdAt, row.updatedAt],
      );
      const id = saved[0]?.id;
      if (!id) throw new DatabaseError("The ledger did not confirm the budget.");
      return { ...row, createdAt: iso(saved[0].created_at), rowNumber: Number(id) };
    },

    async listSavingsGoals(userId) {
      const rows = await query<{
        id: string;
        goal_id: string;
        user_id: string;
        name: string;
        target_amount: string;
        current_amount: string;
        currency: string;
        target_date: string;
        status: SavingsGoalRecord["status"];
        created_at: Date;
        updated_at: Date;
      }>(
        settings,
        `select id, goal_id, user_id, name, target_amount::text, current_amount::text, currency, target_date,
                status, created_at, updated_at
         from public.savings_goals
         where user_id = $1 and status <> 'deleted'
         order by id`,
        [userId],
      );
      return rows.map((row) => goalFrom(row));
    },

    async appendSavingsGoal(row) {
      const inserted = await query<{ id: string }>(
        settings,
        `insert into public.savings_goals (
           goal_id, user_id, name, target_amount, current_amount, currency, target_date, status, created_at, updated_at
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         returning id`,
        [
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
        ],
      );
      const id = inserted[0]?.id;
      if (!id) throw new DatabaseError("The ledger did not confirm the savings goal.");
      return { ...row, rowNumber: Number(id) };
    },

    async updateSavingsGoal(userId, goalId, patch) {
      const current = await query<{
        id: string;
        goal_id: string;
        user_id: string;
        name: string;
        target_amount: string;
        current_amount: string;
        currency: string;
        target_date: string;
        status: SavingsGoalRecord["status"];
        created_at: Date;
        updated_at: Date;
      }>(
        settings,
        `select id, goal_id, user_id, name, target_amount::text, current_amount::text, currency, target_date,
                status, created_at, updated_at
         from public.savings_goals where goal_id = $1`,
        [goalId],
      );
      const row = current[0];
      if (!row || row.user_id !== userId) throw new AuthError();
      const next: SavingsGoalRecord = {
        ...goalFrom(row),
        name: patch.name ?? row.name,
        targetAmount: patch.targetAmount ? money(patch.targetAmount, true) : money(row.target_amount, true),
        currentAmount: patch.currentAmount ? money(patch.currentAmount, true) : money(row.current_amount, true),
        targetDate: patch.targetDate ?? row.target_date,
        status: patch.status ?? row.status,
        updatedAt: new Date().toISOString(),
      };
      await query(
        settings,
        `update public.savings_goals
         set name = $3, target_amount = $4, current_amount = $5, target_date = $6, status = $7, updated_at = $8
         where goal_id = $1 and user_id = $2`,
        [goalId, userId, next.name, next.targetAmount, next.currentAmount, next.targetDate, next.status, next.updatedAt],
      );
      return next;
    },

    async listPendingActions(userId) {
      const rows = await query<PendingRow>(
        settings,
        `select id, action_id, user_id, chat_id, action_type, payload_json, status, expires_at, created_at
         from public.pending_actions where user_id = $1 order by id`,
        [userId],
      );
      return rows.map(pendingFrom);
    },

    async getPendingAction(actionId) {
      const rows = await query<PendingRow>(
        settings,
        `select id, action_id, user_id, chat_id, action_type, payload_json, status, expires_at, created_at
         from public.pending_actions where action_id = $1`,
        [actionId],
      );
      return rows[0] ? pendingFrom(rows[0]) : null;
    },

    async appendPendingAction(row) {
      const inserted = await query<{ id: string }>(
        settings,
        `insert into public.pending_actions (
           action_id, user_id, chat_id, action_type, payload_json, status, expires_at, created_at
         ) values ($1,$2,$3,$4,$5,$6,$7,$8)
         returning id`,
        [row.actionId, row.userId, row.chatId, row.actionType, row.payloadJson, row.status, row.expiresAt, row.createdAt],
      );
      const id = inserted[0]?.id;
      if (!id) throw new DatabaseError("The ledger did not confirm the pending action.");
      return { ...row, rowNumber: Number(id) };
    },

    async updatePendingAction(actionId, patch) {
      const current = await query<PendingRow>(
        settings,
        `select id, action_id, user_id, chat_id, action_type, payload_json, status, expires_at, created_at
         from public.pending_actions where action_id = $1`,
        [actionId],
      );
      const row = current[0];
      if (!row) throw new SheetsError("missing_row", "Pending action was not found.");
      const next = pendingFrom(row);
      next.status = patch.status ?? next.status;
      next.payloadJson = patch.payloadJson ?? next.payloadJson;
      await query(
        settings,
        "update public.pending_actions set status = $2, payload_json = $3 where action_id = $1",
        [actionId, next.status, next.payloadJson],
      );
      return next;
    },
  };
}

function applyTransactionPatch(
  current: TransactionRecord,
  patch: Partial<TransactionChanges> & { status?: TransactionRecord["status"] },
): TransactionRecord {
  return {
    ...current,
    amount: patch.amount ?? current.amount,
    category: patch.category ?? current.category,
    description: patch.description ?? current.description,
    transactionDate: patch.date ?? current.transactionDate,
    type: patch.transactionType ?? current.type,
    status: patch.status ?? current.status,
    updatedAt: new Date().toISOString(),
  };
}

type PendingRow = {
  id: string;
  action_id: string;
  user_id: string;
  chat_id: string;
  action_type: string;
  payload_json: string;
  status: PendingStatus;
  expires_at: Date;
  created_at: Date;
};

function pendingFrom(row: PendingRow): PendingActionRecord {
  return {
    actionId: row.action_id,
    userId: row.user_id,
    chatId: row.chat_id,
    actionType: row.action_type,
    payloadJson: row.payload_json,
    status: row.status,
    expiresAt: iso(row.expires_at),
    createdAt: iso(row.created_at),
    rowNumber: Number(row.id),
  };
}

function goalFrom(row: {
  id: string;
  goal_id: string;
  user_id: string;
  name: string;
  target_amount: string;
  current_amount: string;
  currency: string;
  target_date: string;
  status: SavingsGoalRecord["status"];
  created_at: Date;
  updated_at: Date;
}): SavingsGoalRecord {
  return {
    goalId: row.goal_id,
    userId: row.user_id,
    name: row.name,
    targetAmount: money(row.target_amount, true),
    currentAmount: money(row.current_amount, true),
    currency: row.currency.trim(),
    targetDate: row.target_date,
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    rowNumber: Number(row.id),
  };
}
