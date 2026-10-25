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

/**
 * When Alfred has an open question about a bank payment, treats the person's
 * next message as the answer if it is one. Returns null to let the message
 * go through as a normal chat turn.
 */
export async function answerLabelReply(
  deps: IngestDeps,
  profile: UserProfile,
  text: string,
  classify: ReplyClassifier,
): Promise<{ text: string } | null> {
  const open = (await deps.bank.listMessages(profile.profileId, "needs_label")).filter(
    (item) => item.askedAt && deps.now.getTime() - Date.parse(item.askedAt) < ANSWER_WINDOW_MS,
  );
  if (open.length === 0) return null;
  // The most recently asked question is the one a typed reply most likely answers.
  const target = [...open].sort((left, right) => (right.askedAt ?? "").localeCompare(left.askedAt ?? ""))[0];
  let label: Label | null;
  try {
    label = await classify(labelQuestion(target, profile.timezone), text, target);
  } catch (error) {
    logError("label_reply", error);
    return null;
  }
  if (!label) return null;
  const result = await applyLabel(deps, profile, target.id, label);
  if (!result.ok) return null;
  const remaining = open.length - 1;
  return { text: remaining > 0 ? `${result.text}\n\n${remaining} more payment${remaining === 1 ? "" : "s"} still need${remaining === 1 ? "s" : ""} a label above.` : result.text };
}
