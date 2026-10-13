import { z } from "zod";

import { buildSystemPrompt, type RecentTransaction } from "@/lib/ai/prompts";
import { LIMITS, type DeepSeekSettings } from "@/lib/config";
import { AiError } from "@/lib/errors";
import type { ConversationContext } from "@/lib/finance/conversation";
import { zonedYmd } from "@/lib/finance/dates";
import { parseModelOutput, type FinanceAction } from "@/lib/finance/schemas";

const completionSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable().optional(),
        message: z.object({
          content: z.string().nullable().optional(),
        }),
      }),
    )
    .min(1),
});

export type InterpretRequest = {
  text: string;
  timezone: string;
  currency: string;
  now: Date;
  recent: RecentTransaction[];
  context?: ConversationContext | null;
  preferredName?: string;
  communicationPreference?: "concise" | "detailed";
  budgets?: { period: string; category: string; amount: string; currency: string }[];
  goals?: { name: string; currentAmount: string; targetAmount: string; currency: string }[];
  history?: { role: "user" | "assistant"; body: string }[];
};

export async function interpretMessage(
  settings: DeepSeekSettings,
  request: InterpretRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<FinanceAction> {
  const today = zonedYmd(request.now, request.timezone);
  const system = buildSystemPrompt({
    today,
    timezone: request.timezone,
    currency: request.currency,
    recent: request.recent,
    context: request.context,
    preferredName: request.preferredName,
    communicationPreference: request.communicationPreference,
    budgets: request.budgets,
    goals: request.goals,
    history: request.history,
  });
  const userText = request.text.slice(0, LIMITS.maxUserTextChars);
  let first = "";
  try {
    first = await complete(settings, system, userText, fetchImpl);
  } catch (error) {
    if (!(error instanceof AiError) || error.code !== "invalid") throw error;
  }
  const parsed = parseModelOutput(first);
  if (parsed.success) return parsed.data;
  const second = await complete(
    settings,
    system,
    `${userText}\n\nReturn one JSON object that matches the finance action schema.`,
    fetchImpl,
  );
  const retry = parseModelOutput(second);
  if (!retry.success) throw new AiError("invalid", "DeepSeek returned an invalid finance action.");
  return retry.data;
}

async function complete(
  settings: DeepSeekSettings,
  system: string,
  userText: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${settings.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: settings.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userText },
        ],
        response_format: { type: "json_object" },
        thinking: { type: "disabled" },
        temperature: 0,
        max_tokens: LIMITS.maxModelTokens,
      }),
      signal: AbortSignal.timeout(LIMITS.aiTimeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new AiError("timeout", "DeepSeek timed out.");
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new AiError("timeout", "DeepSeek timed out.");
    }
    throw new AiError("unavailable", "DeepSeek could not be reached.");
  }

  if (response.status === 429) throw new AiError("rate_limit", "DeepSeek rate limited the request.");
  if (!response.ok) throw new AiError("unavailable", `DeepSeek failed with status ${response.status}.`);

  const parsed = completionSchema.safeParse(await response.json());
  if (!parsed.success) throw new AiError("invalid", "DeepSeek returned an unexpected payload.");
  const choice = parsed.data.choices[0];
  if (choice.finish_reason === "length") {
    throw new AiError("invalid", "DeepSeek truncated the finance action.");
  }
  const content = choice.message.content?.trim() ?? "";
  if (!content || content.length > 12_000) throw new AiError("invalid", "DeepSeek returned empty JSON.");
  return content;
}
