import { z } from "zod";

import type { Channel } from "@/lib/ai/persona";
import { buildSystemPrompt, type RecentTransaction } from "@/lib/ai/prompts";
import { LIMITS, type DeepSeekSettings } from "@/lib/config";
import { AiError } from "@/lib/errors";
import type { ConversationContext } from "@/lib/finance/conversation";
import { zonedYmd } from "@/lib/finance/dates";
import { parseModelOutput, type InterpretedAction } from "@/lib/finance/schemas";

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
  toneNote?: string;
  channel?: Channel;
  budgets?: { period: string; category: string; amount: string; currency: string }[];
  goals?: { name: string; currentAmount: string; targetAmount: string; currency: string }[];
  history?: { role: "user" | "assistant"; body: string }[];
  /** Bank payments waiting for a label, so the user can answer about them in their own words. */
  waiting?: { lines: string[]; current: number } | null;
  /** What the user has told Alfred about people, one "Name: note" per line. */
  people?: string[];
  /** What Alfred has learnt about the user, one note per line. */
  about?: string[];
  /** The user's investments, one per line. */
  investments?: string[];
  /** What's open in the conversation: what Alfred just asked, offered, or promised. */
  open?: string[];
  /** A model to use instead of the configured one, for turns that need more care. */
  model?: string;
};

export async function interpretMessage(
  settings: DeepSeekSettings,
  request: InterpretRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<InterpretedAction> {
  const today = zonedYmd(request.now, request.timezone);
  const system = buildSystemPrompt({
    today,
    timezone: request.timezone,
    currency: request.currency,
    recent: request.recent,
    context: request.context,
    preferredName: request.preferredName,
    communicationPreference: request.communicationPreference,
    toneNote: request.toneNote,
    channel: request.channel,
    budgets: request.budgets,
    goals: request.goals,
    waiting: request.waiting,
    people: request.people,
    about: request.about,
    investments: request.investments,
    open: request.open,
  });
  const turnSettings = request.model ? { ...settings, model: request.model } : settings;
  const userText = request.text.slice(0, LIMITS.maxUserTextChars);
  const messages: ChatMessage[] = [{ role: "system", content: system }, ...conversationTurns(request.history ?? []), { role: "user", content: userText }];
  let first = "";
  try {
    first = await chatCompletion(turnSettings, messages, {}, fetchImpl);
  } catch (error) {
    if (!(error instanceof AiError) || error.code !== "invalid") throw error;
  }
  const parsed = parseModelOutput(first, { today });
  if (parsed.success) return parsed.data;
  const retryMessages: ChatMessage[] = first
    ? [
        ...messages,
        { role: "assistant", content: first },
        {
          role: "user",
          content: `That JSON did not match the schema (${parsed.issue}). Return one corrected JSON object using the field shapes in the instructions.`,
        },
      ]
    : messages;
  const second = await chatCompletion(turnSettings, retryMessages, {}, fetchImpl);
  const retry = parseModelOutput(second, { today });
  if (!retry.success) throw new AiError("invalid", "DeepSeek returned an invalid finance action.");
  return retry.data;
}

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export type ChatMessage = { role: "system" | "user" | "assistant"; content: string | ContentPart[] };

/** How much of an earlier message the model sees. */
const TURN_CHARS = 600;

/**
 * Earlier messages as real chat turns, oldest first, so the model reads the
 * latest message as a reply to what was just said. Messages in a row from the
 * same side are joined, since the API expects turns to alternate.
 */
export function conversationTurns(history: { role: "user" | "assistant"; body: string }[]): ChatMessage[] {
  const turns: ChatMessage[] = [];
  for (const item of history) {
    const body = item.body.trim().slice(0, TURN_CHARS);
    if (!body) continue;
    const last = turns.at(-1);
    if (last && last.role === item.role) last.content = `${last.content}\n\n${body}`;
    else turns.push({ role: item.role, content: body });
  }
  // The latest message is the user's, so the turns before it end with Alfred.
  while (turns.at(-1)?.role === "user") turns.pop();
  return turns;
}

export async function chatCompletion(
  settings: DeepSeekSettings,
  messages: ChatMessage[],
  options: { temperature?: number; maxTokens?: number; timeoutMs?: number },
  fetchImpl: typeof fetch = fetch,
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
        messages,
        response_format: { type: "json_object" },
        thinking: { type: "disabled" },
        temperature: options.temperature ?? 0,
        max_tokens: options.maxTokens ?? LIMITS.maxModelTokens,
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? LIMITS.aiTimeoutMs),
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
