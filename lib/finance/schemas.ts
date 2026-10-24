import { z } from "zod";

import { LIMITS } from "@/lib/config";
import { RELATIVE_PERIODS, isRealDate } from "@/lib/finance/dates";
import { canonicalizeAmount, toMinor } from "@/lib/finance/money";

export const amountSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,6})\.\d{2}$/)
  .refine((value) => {
    const minor = toMinor(value);
    return minor > 0 && minor <= LIMITS.maxMinor;
  }, "Amount must be a positive value with at most two decimal places.");

export const nonNegativeAmountSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,6})\.\d{2}$/)
  .refine((value) => {
    const minor = toMinor(value);
    return minor >= 0 && minor <= LIMITS.maxMinor;
  }, "Amount must be zero or positive with at most two decimal places.");

export const currencySchema = z.string().regex(/^[A-Z]{3}$/);

export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isRealDate, "Date must be a real calendar date.");

export const yearMonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

export const periodSchema = z.enum(RELATIVE_PERIODS);

const draftSchema = z.object({
  transaction_type: z.enum(["income", "expense"]),
  amount: amountSchema,
  currency: currencySchema,
  category: z.string().min(1).max(40),
  description: z.string().min(1).max(200),
  date: isoDateSchema.nullable().optional(),
  payment_method: z.string().max(40).nullable().optional(),
  notes: z.string().max(300).nullable().optional(),
});

const rangeFields = {
  period: periodSchema.nullable().optional(),
  month: z.number().int().min(1).max(12).nullable().optional(),
  year: z.number().int().min(2000).max(2100).nullable().optional(),
  start_date: isoDateSchema.nullable().optional(),
  end_date: isoDateSchema.nullable().optional(),
  category: z.string().min(1).max(40).nullable().optional(),
  continue_previous: z.boolean().optional(),
};

const changesSchema = z
  .object({
    amount: amountSchema.nullable().optional(),
    category: z.string().min(1).max(40).nullable().optional(),
    description: z.string().min(1).max(200).nullable().optional(),
    date: isoDateSchema.nullable().optional(),
    transaction_type: z.enum(["income", "expense"]).nullable().optional(),
  })
  .refine((changes) => Object.values(changes).some((value) => value != null), {
    message: "At least one change is required.",
  });

export const financeActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create_transaction"),
    explicit: z.boolean().default(false),
    transactions: z.array(draftSchema).min(1).max(LIMITS.maxTransactionsPerMessage),
  }),
  z.object({
    type: z.literal("get_transaction_history"),
    ...rangeFields,
    limit: z.number().int().min(1).max(LIMITS.maxHistory).nullable().optional(),
  }),
  z.object({
    type: z.literal("get_spending_summary"),
    ...rangeFields,
    detail: z.enum(["total", "by_category", "largest", "comparison"]).nullable().optional(),
  }),
  z.object({
    type: z.literal("get_income_summary"),
    ...rangeFields,
  }),
  z.object({
    type: z.literal("get_financial_overview"),
    ...rangeFields,
  }),
  z.object({
    type: z.literal("get_insights"),
    ...rangeFields,
  }),
  z.object({
    type: z.literal("set_budget"),
    category: z.string().min(1).max(40),
    amount: amountSchema,
    currency: currencySchema,
    period: yearMonthSchema.nullable().optional(),
  }),
  z.object({
    type: z.literal("get_budget_status"),
    category: z.string().min(1).max(40).nullable().optional(),
    period: yearMonthSchema.nullable().optional(),
  }),
  z.object({
    type: z.literal("create_savings_goal"),
    name: z.string().min(1).max(80),
    target_amount: amountSchema,
    currency: currencySchema,
    target_date: isoDateSchema.nullable().optional(),
    current_amount: nonNegativeAmountSchema.nullable().optional(),
  }),
  z
    .object({
      type: z.literal("update_savings_goal"),
      goal_id: z.string().min(8).max(80).nullable().optional(),
      name: z.string().min(1).max(80).nullable().optional(),
      contribution: amountSchema.nullable().optional(),
      set_current_amount: nonNegativeAmountSchema.nullable().optional(),
      target_amount: amountSchema.nullable().optional(),
      target_date: isoDateSchema.nullable().optional(),
      status: z.enum(["active", "completed"]).nullable().optional(),
    })
    .refine((value) => !(value.contribution != null && value.set_current_amount != null), {
      message: "Use either a contribution or a new current amount.",
    }),
  z.object({
    type: z.literal("correct_transaction"),
    transaction_id: z.string().min(8).max(80).nullable().optional(),
    description_query: z.string().min(1).max(120).nullable().optional(),
    changes: changesSchema,
  }),
  z.object({
    type: z.literal("delete_transaction"),
    transaction_id: z.string().min(8).max(80).nullable().optional(),
    description_query: z.string().min(1).max(120).nullable().optional(),
    undo_last: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("help"),
  }),
  z.object({
    type: z.literal("clarify"),
    question: z.string().min(1).max(500),
  }),
  z.object({
    type: z.literal("chat"),
    message: z.string().min(1).max(500),
    /** money for feelings, plans, or advice about money; other for anything else. */
    topic: z.enum(["money", "other"]).nullable().optional(),
  }),
]);

export type FinanceAction = z.infer<typeof financeActionSchema>;

export const strictDraftSchema = z.object({
  transactionType: z.enum(["income", "expense"]),
  amount: amountSchema,
  currency: currencySchema,
  category: z.string().min(1).max(40),
  description: z.string().min(1).max(200),
  date: isoDateSchema,
  paymentMethod: z.string().max(40),
  notes: z.string().max(300),
});

export const pendingPayloadSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create_transaction"),
    originUpdateId: z.string().regex(/^\d+$/),
    transactions: z.array(strictDraftSchema).min(1).max(LIMITS.maxTransactionsPerMessage),
  }),
  z.object({
    type: z.literal("delete_transaction"),
    originUpdateId: z.string().regex(/^\d+$/),
    transactionId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("set_budget"),
    originUpdateId: z.string().regex(/^\d+$/),
    category: z.string().min(1).max(40),
    amount: amountSchema,
    currency: currencySchema,
    period: yearMonthSchema,
  }),
  z.object({
    type: z.literal("create_savings_goal"),
    originUpdateId: z.string().regex(/^\d+$/),
    name: z.string().min(1).max(80),
    targetAmount: amountSchema,
    currentAmount: nonNegativeAmountSchema,
    currency: currencySchema,
    targetDate: z.union([isoDateSchema, z.literal("")]),
  }),
  z.object({
    type: z.literal("update_savings_goal"),
    originUpdateId: z.string().regex(/^\d+$/),
    goalId: z.string().min(8).max(80),
    currentAmount: nonNegativeAmountSchema,
    targetAmount: amountSchema,
    targetDate: z.union([isoDateSchema, z.literal("")]),
    status: z.enum(["active", "completed"]),
  }),
  z.object({
    type: z.literal("correct_transaction"),
    originUpdateId: z.string().regex(/^\d+$/),
    transactionId: z.string().uuid(),
    changes: z
      .object({
        amount: amountSchema.optional(),
        category: z.string().min(1).max(40).optional(),
        description: z.string().min(1).max(200).optional(),
        date: isoDateSchema.optional(),
        transactionType: z.enum(["income", "expense"]).optional(),
      })
      .refine((changes) => Object.values(changes).some((value) => value != null), {
        message: "At least one change is required.",
      }),
  }),
]);

export type PendingPayload = z.infer<typeof pendingPayloadSchema>;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeDraft(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return value;
  const next = { ...record };
  if (typeof next.currency === "string") next.currency = next.currency.trim().toUpperCase();
  if ("amount" in next) next.amount = canonicalizeAmount(next.amount) ?? next.amount;
  for (const key of ["category", "description", "payment_method", "notes"] as const) {
    if (typeof next[key] === "string") next[key] = next[key].trim();
  }
  if (next.date === "") next.date = null;
  return next;
}

function normalizeChanges(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return value;
  const next = { ...record };
  if ("amount" in next && next.amount != null) {
    next.amount = canonicalizeAmount(next.amount) ?? next.amount;
  }
  if (typeof next.category === "string") next.category = next.category.trim();
  if (typeof next.description === "string") next.description = next.description.trim();
  return next;
}

const CHANGE_FIELDS = ["amount", "category", "description", "date", "transaction_type"] as const;

/** Models sometimes send correction fields at the top level instead of inside changes. */
function liftChanges(next: Record<string, unknown>): void {
  if (next.type !== "correct_transaction" || asRecord(next.changes)) return;
  const changes: Record<string, unknown> = {};
  for (const key of CHANGE_FIELDS) {
    if (next[key] != null) changes[key] = next[key];
    delete next[key];
  }
  next.changes = changes;
}

function budgetPeriod(value: unknown, today: string | undefined): unknown {
  if (!today || typeof value !== "string") return value;
  const [year, month] = today.split("-").map(Number);
  const shift = value === "this_month" ? 0 : value === "last_month" ? -1 : value === "next_month" ? 1 : null;
  if (shift === null) return value;
  const date = new Date(Date.UTC(year, month - 1 + shift, 1));
  return date.toISOString().slice(0, 7);
}

export function normalizeModelValue(value: unknown, today?: string): unknown {
  const record = asRecord(value);
  if (!record) return value;
  const next = { ...record };
  if (typeof next.type === "string") next.type = next.type.trim();
  liftChanges(next);
  if (next.type === "clarify" && next.question == null && typeof next.message === "string") next.question = next.message;
  if (next.type === "chat" && next.message == null && typeof next.question === "string") next.message = next.question;
  if (next.type === "set_budget" || next.type === "get_budget_status") next.period = budgetPeriod(next.period, today);
  if (typeof next.currency === "string") next.currency = next.currency.trim().toUpperCase();
  if ("amount" in next && next.amount != null) {
    next.amount = canonicalizeAmount(next.amount) ?? next.amount;
  }
  if ("target_amount" in next && next.target_amount != null) {
    next.target_amount = canonicalizeAmount(next.target_amount) ?? next.target_amount;
  }
  if ("current_amount" in next && next.current_amount != null) {
    next.current_amount =
      canonicalizeAmount(next.current_amount, { allowZero: true }) ?? next.current_amount;
  }
  if ("contribution" in next && next.contribution != null) {
    next.contribution = canonicalizeAmount(next.contribution) ?? next.contribution;
  }
  if ("set_current_amount" in next && next.set_current_amount != null) {
    next.set_current_amount =
      canonicalizeAmount(next.set_current_amount, { allowZero: true }) ?? next.set_current_amount;
  }
  if (typeof next.category === "string") next.category = next.category.trim();
  if (typeof next.name === "string") next.name = next.name.trim();
  if (typeof next.question === "string") next.question = next.question.trim();
  if (typeof next.message === "string") next.message = next.message.trim();
  if (Array.isArray(next.transactions)) next.transactions = next.transactions.map(normalizeDraft);
  if ("changes" in next) next.changes = normalizeChanges(next.changes);
  return next;
}

export function parseModelOutput(
  input: unknown,
  options: { today?: string } = {},
): { success: true; data: FinanceAction } | { success: false; issue: string } {
  let value = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input) as unknown;
    } catch {
      return { success: false, issue: "The reply was not valid JSON." };
    }
  }
  const record = asRecord(value);
  if (record && record.action && !record.type) value = record.action;
  const parsed = financeActionSchema.safeParse(normalizeModelValue(value, options.today));
  if (!parsed.success) {
    const issue = parsed.error.issues
      .slice(0, 3)
      .map((item) => `${item.path.join(".") || "type"}: ${item.message}`)
      .join("; ");
    return { success: false, issue };
  }
  return { success: true, data: parsed.data };
}
