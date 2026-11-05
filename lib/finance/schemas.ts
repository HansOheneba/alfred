import { z } from "zod";

import { LIMITS } from "@/lib/config";
import { RELATIVE_PERIODS, isRealDate } from "@/lib/finance/dates";
import { canonicalizeAmount, toMinor } from "@/lib/finance/money";
import { INVESTMENT_KINDS } from "@/lib/investments/kinds";
import { billActionSchemas, billPendingSchemas } from "@/lib/finance/bill-management-schema";
import { accountActionSchemas, accountPendingSchemas } from "@/lib/accounts/management-schema";
import { preferenceActionSchemas, preferencePendingSchemas } from "@/lib/accounts/preference-management-schema";

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

/** What some of the payments waiting for a label were, by their number in the list Alfred was shown. */
export const labelAnswerSchema = z.object({
  items: z.array(z.number().int().min(1).max(60)).min(1).max(60),
  action: z.enum(["category", "chip_in", "refund", "pass_through", "own_transfer", "lent", "repaid", "borrowed", "paid_back", "investment", "skip"]),
  category: z.string().max(40).nullable().optional(),
  description: z.string().max(200).nullable().optional(),
  person: z.string().max(120).nullable().optional(),
  /** For an investment: which one, by name, like "Risevest" or "T-bill". */
  investment: z.string().max(80).nullable().optional(),
  /** The month (YYYY-MM) a payment counts in when it's for another month, like next month's rent. */
  for_month: z.string().regex(/^\d{4}-\d{2}$/).nullable().optional(),
  /** Fee already included inside the recorded amount, to split out into a separate Fees entry. */
  included_fee: amountSchema.nullable().optional(),
});

export type LabelAnswer = z.infer<typeof labelAnswerSchema>;

/** A holding: a ticker (VOO, MTNGH) and how many shares or units. */
const holdingSchema = z.object({
  symbol: z.string().regex(/^[A-Za-z0-9.:-]{1,16}$/).transform((value) => value.toUpperCase()),
  quantity: z.number().min(0).max(1_000_000_000),
});

/** What the person said about an investment; null for anything they didn't say. */
const investmentFields = {
  name: z.string().min(1).max(80),
  provider: z.string().max(80).nullable().optional(),
  currency: currencySchema.nullable().optional(),
  /** What it's worth now, in its currency. */
  value: nonNegativeAmountSchema.nullable().optional(),
  /** What was in it before, in its currency. */
  invested_before: nonNegativeAmountSchema.nullable().optional(),
  principal: amountSchema.nullable().optional(),
  rate: z.number().min(0).max(200).nullable().optional(),
  started_on: isoDateSchema.nullable().optional(),
  matures_on: isoDateSchema.nullable().optional(),
  holdings: z.array(holdingSchema).max(30).nullable().optional(),
};

/** One lookup: which records, and what narrows them. Every lookup is scoped to the person asking. */
export const lookupQuerySchema = z.object({
  tool: z.enum(["transactions", "bank_payments", "loans", "investments", "notes"]),
  /** Words to match, like a shop, a person or "claude". */
  text: z.string().max(80).nullable().optional(),
  category: z.string().max(40).nullable().optional(),
  type: z.enum(["income", "expense"]).nullable().optional(),
  from: isoDateSchema.nullable().optional(),
  to: isoDateSchema.nullable().optional(),
  person: z.string().max(120).nullable().optional(),
});
export type LookupQuery = z.infer<typeof lookupQuerySchema>;

export const financeActionSchema = z.discriminatedUnion("type", [
  ...billActionSchemas,
  ...accountActionSchemas,
  ...preferenceActionSchemas,
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
    type: z.literal("remember_person"),
    name: z.string().min(1).max(120),
    note: z.string().min(1).max(300),
  }),
  z.object({
    type: z.literal("forget_person"),
    name: z.string().min(1).max(120),
  }),
  z.object({
    type: z.literal("ignore_account"),
    account: z.string().regex(/^\d{3,12}$/),
    note: z.string().max(300).nullable().optional(),
  }),
  z.object({
    type: z.literal("remember_about_me"),
    note: z.string().min(1).max(300),
  }),
  z.object({
    type: z.literal("get_loans"),
    person: z.string().min(1).max(120).nullable().optional(),
  }),
  z.object({
    type: z.literal("record_loan"),
    direction: z.enum(["lent", "repaid", "borrowed", "paid_back"]),
    person: z.string().min(1).max(120),
    amount: amountSchema,
    currency: currencySchema,
    date: isoDateSchema.nullable().optional(),
    note: z.string().max(200).nullable().optional(),
  }),
  z.object({
    type: z.literal("get_investments"),
    name: z.string().min(1).max(80).nullable().optional(),
    /** Include cash balances from bank texts, for net worth. */
    net_worth: z.boolean().nullable().optional(),
  }),
  z.object({
    type: z.literal("add_investment"),
    ...investmentFields,
    kind: z.enum(INVESTMENT_KINDS),
  }),
  z.object({
    type: z.literal("update_investment"),
    ...investmentFields,
    kind: z.enum(INVESTMENT_KINDS).nullable().optional(),
    /** True when the person has sold or cashed it all out. */
    closed: z.boolean().nullable().optional(),
  }),
  z.object({
    type: z.literal("invest_money"),
    name: z.string().min(1).max(80),
    amount: amountSchema,
    currency: currencySchema,
    /** in: money put into the investment; out: money taken out of it. */
    direction: z.enum(["in", "out"]),
    date: isoDateSchema.nullable().optional(),
  }),
  z.object({
    type: z.literal("get_categories"),
    transaction_type: z.enum(["income", "expense"]).nullable().optional(),
  }),
  z.object({
    type: z.literal("create_category"),
    name: z.string().trim().min(1).max(40),
    transaction_type: z.enum(["income", "expense"]),
    budget: z.object({
      amount: amountSchema,
      currency: currencySchema.nullable().optional(),
      period: yearMonthSchema.nullable().optional(),
    }).nullable().optional(),
  }),
  z.object({
    type: z.literal("delete_budget"),
    budget_id: z.string().min(8).max(80).nullable().optional(),
    category: z.string().min(1).max(40).nullable().optional(),
    period: yearMonthSchema.nullable().optional(),
    currency: currencySchema.nullable().optional(),
  }),
  z.object({
    type: z.literal("set_budget"),
    category: z.string().min(1).max(40),
    amount: amountSchema,
    currency: currencySchema.nullable().optional(),
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
    type: z.literal("label_payments"),
    answers: z.array(labelAnswerSchema).min(1).max(20),
  }),
  z.object({
    /** Show the next payment waiting for a label, e.g. when told "ask" or "go on". */
    type: z.literal("ask_next"),
    /** Move past the group Alfred is asking about without filing it. */
    skip: z.boolean().nullable().optional(),
  }),
  z.object({
    /** Answer for a group of imported or held payments from the Needs attention list, by its number. */
    type: z.literal("file_movements"),
    group: z.number().int().min(1).max(8),
    outcome: z.enum(["category", "own_money", "not_charged", "duplicate"]),
    category: z.string().min(1).max(40).nullable().optional(),
  }),
  z.object({
    /** Settle the confirmation Alfred has open, from a reply like "yes go ahead" or "no leave it". */
    type: z.literal("answer_confirmation"),
    decision: z.enum(["confirm", "cancel"]),
  }),
  z.object({
    /** Look records up before answering; the results come back and the model answers on the next round. */
    type: z.literal("look_up"),
    queries: z.array(lookupQuerySchema).min(1).max(3),
  }),
  z.object({
    type: z.literal("clarify"),
    question: z.string().min(1).max(500),
    /** When the question asks whether to do something specific, exactly what Alfred would do on a yes. */
    offer: z.array(z.record(z.string(), z.unknown())).max(3).nullable().optional(),
  }),
  z.object({
    type: z.literal("chat"),
    message: z.string().min(1).max(500),
    /** money for feelings, plans, or advice about money; other for anything else. */
    topic: z.enum(["money", "other"]).nullable().optional(),
  }),
]);

export type FinanceAction = z.infer<typeof financeActionSchema>;

/** Two or three separate things asked in one message, done in order. */
export const severalActionsSchema = z.object({
  type: z.literal("several"),
  actions: z.array(financeActionSchema).min(2).max(3),
});

/** What the model makes of one message: one action, or a few in order. */
export type InterpretedAction = FinanceAction | z.infer<typeof severalActionsSchema>;

/** The actions in a turn, in the order to do them. */
export function actionsOf(action: InterpretedAction): FinanceAction[] {
  return action.type === "several" ? action.actions : [action];
}

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

const optionalText = (max: number) => z.string().max(max).nullable().optional();

/** A label Alfred proposed for a captured payment, saved only after the person confirms it. */
export const proposedLabelSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("category"), category: z.string().min(1).max(40), description: optionalText(200) }),
  z.object({ kind: z.literal("transfer") }),
  z.object({ kind: z.literal("pass_through"), person: optionalText(120), note: optionalText(200) }),
  z.object({ kind: z.literal("refund"), category: z.string().min(1).max(40), description: optionalText(200) }),
  z.object({ kind: z.literal("lent"), person: optionalText(120), note: optionalText(200) }),
  z.object({ kind: z.literal("repaid"), person: optionalText(120) }),
  z.object({ kind: z.literal("borrowed"), person: optionalText(120), note: optionalText(200) }),
  z.object({ kind: z.literal("paid_back"), person: optionalText(120) }),
  z.object({ kind: z.literal("invest"), investment: optionalText(80) }),
  z.object({ kind: z.literal("chip_in"), category: z.string().min(1).max(40), description: optionalText(200), person: optionalText(120) }),
]);

/** Actions a question may offer: ones that write, with their own checks, never another question. */
export const OFFERABLE = new Set<FinanceAction["type"]>([
  "create_transaction", "record_loan", "invest_money", "set_budget", "create_category", "delete_budget", "create_savings_goal", "update_savings_goal",
  "correct_transaction", "remember_about_me", "remember_person", "add_investment", "update_investment",
]);

/** The actions a clarifying question offered, valid and safe to do on a yes, or none. */
export function offeredActions(offer: unknown[] | null | undefined): FinanceAction[] {
  if (!offer?.length) return [];
  const parsed = offer.map((item) => financeActionSchema.safeParse(item));
  if (!parsed.every((item) => item.success && OFFERABLE.has(item.data.type))) return [];
  return parsed.map((item) => item.data!);
}

export const pendingPayloadSchema = z.discriminatedUnion("type", [
  ...billPendingSchemas,
  ...accountPendingSchemas,
  ...preferencePendingSchemas,
  z.object({
    type: z.literal("offer"),
    originUpdateId: z.string().regex(/^\d+$/),
    actions: z.array(z.record(z.string(), z.unknown())).min(1).max(3),
  }),
  z.object({
    type: z.literal("label_payments"),
    originUpdateId: z.string().regex(/^\d+$/),
    items: z.array(z.object({ bankMessageId: z.string().min(1).max(80), label: proposedLabelSchema })).min(1).max(4),
  }),
  z.object({
    type: z.literal("file_movements"),
    originUpdateId: z.string().regex(/^\d+$/),
    groupId: z.string().regex(/^[0-9a-f]{10}$/),
    status: z.enum(["confirmed", "excluded", "duplicate"]),
    category: z.string().min(1).max(40).nullable(),
  }),
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
    type: z.literal("record_loan"),
    originUpdateId: z.string().regex(/^\d+$/),
    direction: z.enum(["lent", "repaid", "borrowed", "paid_back"]),
    person: z.string().min(1).max(120),
    amount: amountSchema,
    currency: currencySchema,
    date: isoDateSchema,
    note: z.string().max(200),
  }),
  z.object({
    type: z.literal("create_category"),
    originUpdateId: z.string().regex(/^\d+$/),
    name: z.string().min(1).max(40),
    transactionType: z.enum(["income", "expense"]),
    budget: z.object({ amount: amountSchema, currency: currencySchema, period: yearMonthSchema }).nullable(),
  }),
  z.object({
    type: z.literal("delete_budget"),
    originUpdateId: z.string().regex(/^\d+$/),
    budgetId: z.string().min(8).max(80),
    expected: z.object({
      category: z.string().min(1).max(40), amount: amountSchema, currency: currencySchema,
      period: yearMonthSchema, updatedAt: z.string().min(1).max(80),
    }),
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
export type ProposedLabel = z.infer<typeof proposedLabelSchema>;

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
  if (next.type === "clarify" && Array.isArray(next.offer)) next.offer = next.offer.map((item) => normalizeModelValue(item, today));
  if (next.type === "chat" && next.message == null && typeof next.question === "string") next.message = next.question;
  if (next.type === "set_budget" || next.type === "get_budget_status" || next.type === "delete_budget") next.period = budgetPeriod(next.period, today);
  if (next.type === "create_category" && asRecord(next.budget)) {
    const budget = { ...asRecord(next.budget)! };
    budget.amount = canonicalizeAmount(budget.amount) ?? budget.amount;
    if (typeof budget.currency === "string") budget.currency = budget.currency.trim().toUpperCase();
    budget.period = budgetPeriod(budget.period, today);
    next.budget = budget;
  }
  if (next.type === "update_bill" && asRecord(next.changes)) {
    const changes = { ...asRecord(next.changes)! };
    if (changes.amount != null) changes.amount = canonicalizeAmount(changes.amount) ?? changes.amount;
    if (typeof changes.currency === "string") changes.currency = changes.currency.trim().toUpperCase();
    next.changes = changes;
  }
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
  for (const key of ["value", "invested_before", "principal"] as const) {
    if (key in next && next[key] != null) next[key] = canonicalizeAmount(next[key], { allowZero: key !== "principal" }) ?? next[key];
  }
  if (typeof next.rate === "string") next.rate = Number(next.rate.replace("%", ""));
  if (Array.isArray(next.holdings)) {
    next.holdings = next.holdings.map((item) => {
      const holding = asRecord(item);
      return holding && typeof holding.quantity === "string" ? { ...holding, quantity: Number(holding.quantity.replace(/,/g, "")) } : item;
    });
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
): { success: true; data: InterpretedAction } | { success: false; issue: string } {
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
  const several = asRecord(value);
  if (several && Array.isArray(several.actions) && (!several.type || several.type === "several")) {
    const items = several.actions.map((item) => parseModelOutput(item, options));
    const failed = items.find((item) => !item.success);
    if (failed && !failed.success) return failed;
    const actions = items.flatMap((item) => (item.success ? actionsOf(item.data) : [])).slice(0, 3);
    if (actions.length === 1) return { success: true, data: actions[0] };
    const parsedSeveral = severalActionsSchema.safeParse({ type: "several", actions });
    return parsedSeveral.success ? { success: true, data: parsedSeveral.data } : { success: false, issue: "actions: expected two or three actions" };
  }
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
