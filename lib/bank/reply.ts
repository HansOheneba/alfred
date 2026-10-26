import { z } from "zod";

import { chatCompletion } from "@/lib/ai/deepseek";
import { applyLabel, labelQuestion, type IngestDeps, type Label } from "@/lib/bank/ingest";
import type { BankMessage } from "@/lib/bank/store";
import type { DeepSeekSettings, UserProfile } from "@/lib/config";
import { categoryList } from "@/lib/finance/categories";
import { logError } from "@/lib/log";

const ANSWER_WINDOW_MS = 72 * 3_600_000;

const verdictSchema = z.object({
  answers: z.boolean(),
  category: z.string().nullable().optional(),
  description: z.string().max(200).nullable().optional(),
  own_transfer: z.boolean().optional(),
  skip: z.boolean().optional(),
});

export type ReplyClassifier = (question: string, reply: string, message: BankMessage) => Promise<Label | null>;

/** Asks the model whether a typed message answers Alfred's question about a payment. */
export function createReplyClassifier(settings: DeepSeekSettings, fetchImpl: typeof fetch = fetch): ReplyClassifier {
  return async (question, reply, message) => {
    const categories = categoryList(message.direction === "out" ? "expense" : "income").join(", ");
    const system = [
      "Alfred, a finance assistant, asked the user about a payment from their bank messages. Decide whether their reply answers that question.",
      "It answers if it says what the payment was for, names a category, says it was their own money moving between accounts, or says to ignore it.",
      "Saying it was a test, a mistake, a reversal, not real, or not to count it means skip is true.",
      "If the question asks whether it was their own money and they agree, own_transfer is true.",
      "A new request, such as logging a different expense or asking a question, does not answer it.",
      `Categories: ${categories}. Pick the closest one.`,
      "description is a short label in the user's words, such as Lunch with Kofi, or null.",
      'Reply with JSON only: {"answers":true,"category":"Food","description":"Lunch","own_transfer":false,"skip":false}',
    ].join("\n");
    const content = await chatCompletion(
      settings,
      [
        { role: "system", content: system },
        { role: "user", content: `Question: ${question}\nReply: ${reply}` },
      ],
      { temperature: 0, maxTokens: 120, timeoutMs: 10_000 },
      fetchImpl,
    );
    const parsed = verdictSchema.safeParse(JSON.parse(content));
    if (!parsed.success || !parsed.data.answers) return null;
    if (parsed.data.skip) return { kind: "skip" };
    if (parsed.data.own_transfer) return { kind: "transfer" };
    if (!parsed.data.category) return null;
    return { kind: "category", category: parsed.data.category, description: parsed.data.description ?? null };
  };
}

export type LabelReply = { text: string; next: BankMessage | null };

/** "What are those?", "which ones?", "show me" while payments are waiting. */
const LIST_QUERY = /^(?:what|which)\b.*\b(?:those|they|them|ones|payments?)\b|^(?:show|list)\b.*\b(?:them|those|payments?)\b|^(?:what's|whats) (?:left|pending|waiting)/i;

/**
 * Picks the oldest payment still waiting for a label and marks it as the one
 * being asked about now, so the next typed reply answers it.
 */
export async function askNext(deps: IngestDeps, profile: UserProfile): Promise<BankMessage | null> {
  const waiting = await deps.bank.listMessages(profile.profileId, "needs_label");
  const next = [...waiting].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))[0] ?? null;
  if (next) await deps.bank.updateMessage(profile.profileId, next.id, { askedAt: deps.now.toISOString() });
  return next;
}

function nextLine(next: BankMessage, profile: UserProfile, remaining: number): string {
  const more = remaining > 1 ? ` (${remaining - 1} more after this)` : "";
  return `Next${more}: ${labelQuestion(next, profile.timezone, profile.preferredName)}`;
}

/**
 * When payments are waiting for a label, handles the person's message if it's
 * about them: an answer to the current question, or "what are those?".
 * Returns null to let the message go through as a normal chat turn.
 */
export async function answerLabelReply(
  deps: IngestDeps,
  profile: UserProfile,
  text: string,
  classify: ReplyClassifier,
): Promise<LabelReply | null> {
  const waiting = await deps.bank.listMessages(profile.profileId, "needs_label");
  if (waiting.length === 0) return null;

  if (LIST_QUERY.test(text.trim())) {
    const next = await askNext(deps, profile);
    if (!next) return null;
    const amounts = waiting.length === 1 ? "One payment is waiting for a label." : `${waiting.length} payments are waiting for a label.`;
    return { text: `${amounts} Let's go one at a time.\n\n${labelQuestion(next, profile.timezone, profile.preferredName)}`, next };
  }

  const open = waiting.filter((item) => item.askedAt && deps.now.getTime() - Date.parse(item.askedAt) < ANSWER_WINDOW_MS);
  if (open.length === 0) return null;
  // The most recently asked question is the one a typed reply most likely answers.
  const target = [...open].sort(
    (left, right) => (right.askedAt ?? "").localeCompare(left.askedAt ?? "") || left.occurredAt.localeCompare(right.occurredAt),
  )[0];
  let label: Label | null;
  try {
    label = await classify(labelQuestion(target, profile.timezone, profile.preferredName), text, target);
  } catch (error) {
    logError("label_reply", error);
    return null;
  }
  if (!label) return null;
  const result = await applyLabel(deps, profile, target.id, label);
  if (!result.ok) return null;
  const next = await askNext(deps, profile);
  if (!next) return { text: result.text, next: null };
  return { text: `${result.text}\n\n${nextLine(next, profile, waiting.length - 1)}`, next };
}
