import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

/**
 * A conversation Alfred must keep getting right, written as data: what the
 * person's books look like, what they say, and what should be saved by the
 * end. Most come from real conversations that went wrong. Checks look at what
 * was saved, not at the wording, so a reworded reply still passes.
 */

const amount = z.string().regex(/^\d+\.\d{2}$/);

const paymentSchema = z.object({
  /** Name the steps and checks use for this payment, like "topUp". */
  ref: z.string().min(1),
  direction: z.enum(["in", "out"]),
  amount,
  counterparty: z.string().default(""),
  occurredAt: z.string().datetime(),
  source: z.enum(["momo", "gcb", "absa", "hubtel"]).default("gcb"),
  status: z.literal("needs_label").default("needs_label"),
});

const stepSchema = z.object({
  /** What the person types. */
  say: z.string().min(1).optional(),
  /** Taps Confirm or Cancel on the last confirmation Alfred showed. */
  tap: z.enum(["confirm", "cancel"]).optional(),
  /** Tap only if Alfred asked, for answers it may either file straight away or confirm first. */
  ifAsked: z.boolean().optional(),
  /** The payment alert this message replies to, by ref. */
  replyTo: z.string().optional(),
  expect: z.object({
    /** Alfred shows Confirm and Cancel. */
    asksToConfirm: z.boolean().optional(),
    /** No ledger, loan, label or investment change from this step. */
    savesNothing: z.boolean().optional(),
    /** Regex the reply must match. Use sparingly: wording is allowed to change. */
    reply: z.string().optional(),
    /** Regex the reply must not match, like a known wrong fallback. */
    notReply: z.string().optional(),
  }).prefault({}),
}).refine((step) => Boolean(step.say) !== Boolean(step.tap), "A step either says something or taps a button.");

export const evalCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(1),
  /** Where it came from, like "Hans, 2026-11-04: refused 'George owes me'". */
  source: z.string().min(1),
  tags: z.array(z.string()).default([]),
  now: z.string().datetime(),
  name: z.string().default("Hans"),
  setup: z.object({
    /** Raw bank SMS, read the way the Mac collector would send them. */
    bankTexts: z.array(z.string()).default([]),
    payments: z.array(paymentSchema).default([]),
    /** A payment alert Alfred sent, asking what this payment was for. */
    notice: z.string().optional(),
    investments: z.array(z.object({ name: z.string(), kind: z.enum(["us_stocks", "gse_stocks", "tbill", "fixed_deposit", "bond", "mutual_fund", "pension", "crypto", "other"]), investedBefore: amount })).default([]),
    budgets: z.array(z.object({ category: z.string(), amount })).default([]),
    /** Earlier chat, oldest first. */
    messages: z.array(z.object({ role: z.enum(["user", "assistant"]), body: z.string(), intent: z.string().optional() })).default([]),
  }).prefault({}),
  steps: z.array(stepSchema).min(1),
  /** What must be true once the conversation ends. */
  final: z.object({
    payments: z.record(z.string(), z.enum(["needs_label", "recorded", "transfer", "lent", "borrowed", "repaid", "paid_back", "skipped", "invested"])).default({}),
    loans: z.array(z.object({ person: z.string(), owed: amount.optional(), owe: amount.optional() })).optional(),
    transactions: z.array(z.object({ type: z.enum(["income", "expense"]).optional(), amount, category: z.string().optional() })).optional(),
    /** Money into (+) or out of (-) an investment, like { "investment": "Risevest", "amount": "-1500.00" }. */
    investmentFlows: z.array(z.object({ investment: z.string(), amount: z.string().regex(/^-?\d+\.\d{2}$/) })).optional(),
    /** Regexes the person's notebook must contain, for facts Alfred should remember. */
    remembers: z.array(z.string()).optional(),
  }).prefault({}),
});

export type EvalCase = z.infer<typeof evalCaseSchema>;

export const CASES_DIR = path.join(process.cwd(), "evals", "cases");

/** Every case in evals/cases, validated, sorted by id. */
export async function loadCases(directory = CASES_DIR): Promise<EvalCase[]> {
  const files = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  const cases: EvalCase[] = [];
  for (const file of files) {
    const parsed = evalCaseSchema.safeParse(JSON.parse(await readFile(path.join(directory, file), "utf8")));
    if (!parsed.success) throw new Error(`${file}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`);
    if (`${parsed.data.id}.json` !== file) throw new Error(`${file}: id must match the file name`);
    const refs = new Set(parsed.data.setup.payments.map((payment) => payment.ref));
    for (const ref of [parsed.data.setup.notice, ...parsed.data.steps.map((step) => step.replyTo), ...Object.keys(parsed.data.final.payments)]) {
      if (ref && !refs.has(ref)) throw new Error(`${file}: unknown payment ref "${ref}"`);
    }
    cases.push(parsed.data);
  }
  return cases;
}
