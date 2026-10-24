import { z } from "zod";

import { chatCompletion } from "@/lib/ai/deepseek";
import { personaLines, type Channel } from "@/lib/ai/persona";
import { DASHBOARD_URL, type DeepSeekSettings, type UserProfile } from "@/lib/config";
import type { Delivery } from "@/lib/finance/action-router";
import type { FinanceAction } from "@/lib/finance/schemas";
import { logError } from "@/lib/log";

export type VoiceRequest = {
  draft: string;
  userText: string;
  intent: FinanceAction["type"];
  profile: UserProfile;
  channel: Channel;
};

export type Voice = (request: VoiceRequest) => Promise<string>;

/** Replies that state facts and can safely be reworded. Confirmations, errors and lists keep their exact text. */
const VOICED: ReadonlySet<FinanceAction["type"]> = new Set([
  "create_transaction",
  "get_spending_summary",
  "get_income_summary",
  "get_financial_overview",
  "get_insights",
  "get_budget_status",
  "set_budget",
  "create_savings_goal",
  "update_savings_goal",
]);

const replySchema = z.object({ reply: z.string().min(1).max(1500) });

export function createVoice(settings: DeepSeekSettings, fetchImpl: typeof fetch = fetch): Voice {
  return async (request) => {
    const system = [
      ...personaLines(request.profile, request.channel),
      "The server has already worked out the facts below from the user's stored records. Rewrite them as your reply to the user's message.",
      "Every number, amount, percentage, and date you mention must appear exactly as written in the facts. Do not calculate, round, estimate, or add any new figure.",
      "You may leave out minor facts, but never change their meaning, and never claim something was saved, changed, or deleted unless the facts say so.",
      request.intent === "get_insights" || request.intent === "get_financial_overview"
        ? "This is an insight request. Say plainly what takes most of their money, point out any pattern in the facts, and offer one or two practical, kind suggestions for improvement drawn from those facts."
        : "Keep it brief. Confirm the key fact first.",
      "Reply with JSON only, in the form {\"reply\":\"...\"}.",
    ].join("\n");
    const content = await chatCompletion(
      settings,
      [
        { role: "system", content: system },
        { role: "user", content: `User's message:\n${request.userText}\n\nFacts:\n${request.draft}` },
      ],
      { temperature: 0.6, maxTokens: 700, timeoutMs: 10_000 },
      fetchImpl,
    );
    const parsed = replySchema.safeParse(JSON.parse(content));
    if (!parsed.success) throw new Error("Voice reply did not match the schema.");
    return parsed.data.reply.trim();
  };
}

/**
 * Rewords a factual reply in Alfred's voice. Falls back to the server's own
 * text when the voice is off, fails, or mentions a figure the server didn't.
 */
export async function voiceDelivery(
  voice: Voice | null | undefined,
  action: FinanceAction,
  delivery: Delivery,
  request: Omit<VoiceRequest, "draft" | "intent">,
): Promise<Delivery> {
  if (!voice || delivery.kind !== "text" || !VOICED.has(action.type)) return delivery;
  try {
    const reply = await voice({ ...request, draft: delivery.text, intent: action.type });
    if (!keepsFacts(reply, `${delivery.text}\n${request.userText}`)) return delivery;
    return { ...delivery, text: reply };
  } catch (error) {
    logError("voice", error);
    return delivery;
  }
}

const NUMBER = /\d[\d,]*(?:\.\d+)?/g;
const LINK = /https?:\/\/\S+|www\.\S+|\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|app|me)\b/gi;
const UNSAFE = /spreadsheet|private key|api[_ -]?key|system prompt|private guidance/i;

/** True when every figure and link in the reply already appears in the source text. */
export function keepsFacts(reply: string, source: string): boolean {
  if (UNSAFE.test(reply)) return false;
  const allowed = new Set((source.match(NUMBER) ?? []).map(normalizeNumber));
  if (!(reply.match(NUMBER) ?? []).every((value) => allowed.has(normalizeNumber(value)))) return false;
  const host = new URL(DASHBOARD_URL).host;
  return (reply.match(LINK) ?? []).every((link) => link.replace(/^https?:\/\//, "").replace(/[/.,!?)]+$/, "") === host);
}

function normalizeNumber(value: string): string {
  return String(Number(value.replace(/,/g, "")));
}
