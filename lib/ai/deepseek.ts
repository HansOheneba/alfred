import { z } from "zod";

import type { Channel } from "@/lib/ai/persona";
import { buildSystemPrompt, type RecentTransaction } from "@/lib/ai/prompts";
import { LIMITS, type DeepSeekSettings } from "@/lib/config";
import { alertOperator } from "@/lib/ai/operator-alert";
import { AiError } from "@/lib/errors";
import { logError } from "@/lib/log";
import type { CategoryRecord } from "@/lib/finance/types";
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
  /** Optional management adapters available for this owner/channel; availability is checked again by the server. */
  services?: string[];
  text: string;
  timezone: string;
  currency: string;
  now: Date;
  recent: RecentTransaction[];
  context?: ConversationContext | null;
  preferredName?: string;
  communicationPreference?: "concise" | "detailed";
  toneNote?: string;
  /** Who Alfred is talking to, so it knows whether to name who built it. */
  telegramUserId?: number | null;
  channel?: Channel;
  budgets?: { period: string; category: string; amount: string; currency: string }[];
  categories?: CategoryRecord[];
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
  /** The team's shared projects, for members only: the other members' names and one line per project. */
  team?: { others: string[]; projects: string[] } | null;
  /** What's open in the conversation: what Alfred just asked, offered, or promised. */
  open?: string[];
  /** What the model looked up earlier in this turn, with the results. */
  lookups?: { query: string; lines: string[] }[];
  /** How many more lookup rounds the model may ask for; 0 means answer now. */
  lookupsLeft?: number;
  /** A model to use instead of the configured one, for turns that need more care. */
  model?: string;
};

export async function interpretMessage(
  settings: DeepSeekSettings,
  request: InterpretRequest,
  fetchImpl: typeof fetch = fetch,
  /** Which model answers. DeepSeek unless the evals compare another one. */
  complete: Completion = chatCompletion,
): Promise<InterpretedAction> {
  const today = zonedYmd(request.now, request.timezone);
  const system = buildSystemPrompt({
    services: request.services,
    today,
    timezone: request.timezone,
    currency: request.currency,
    recent: request.recent,
    context: request.context,
    preferredName: request.preferredName,
    communicationPreference: request.communicationPreference,
    toneNote: request.toneNote,
    telegramUserId: request.telegramUserId,
    channel: request.channel,
    budgets: request.budgets,
    categories: request.categories,
    goals: request.goals,
    waiting: request.waiting,
    people: request.people,
    about: request.about,
    investments: request.investments,
    team: request.team,
    open: request.open,
    lookups: request.lookups,
    lookupsLeft: request.lookupsLeft,
  });
  const turnSettings = request.model ? { ...settings, model: request.model } : settings;
  const userText = request.text.slice(0, LIMITS.maxUserTextChars);
  const messages: ChatMessage[] = [{ role: "system", content: system }, ...conversationTurns(request.history ?? []), { role: "user", content: userText }];
  let first = "";
  try {
    first = await complete(turnSettings, messages, {}, fetchImpl);
  } catch (error) {
    if (outage(error)) return afterOutage(error, settings, turnSettings, messages, today, fetchImpl);
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
  // JSON mode now and then returns nothing at all; the identical request at temperature 0
  // tends to come back empty again, so an empty retry is nudged off that path.
  const retry = await attempt(turnSettings, retryMessages, { temperature: first ? 0 : 0.3 }, today, fetchImpl, complete);
  if (retry.success) return retry.data;
  // A last try on the everyday model, when this turn asked for a different one.
  if (turnSettings.model !== settings.model) {
    const fallback = await attempt(settings, messages, {}, today, fetchImpl, complete);
    if (fallback.success) return fallback.data;
  }
  // Some conversations (a link after a few turns, say) make JSON mode come back empty every time.
  // The message on its own, with everything else in the instructions, still reads the request.
  if (!first && request.history?.length) {
    const alone = await attempt(turnSettings, [messages[0], messages.at(-1)!], {}, today, fetchImpl, complete);
    if (alone.success) return alone.data;
  }
  // The schema issue (field paths and messages, never the user's words) is what the logs need to explain a fallback.
  throw new AiError("invalid", `DeepSeek returned an invalid finance action (${retry.issue}).`);
}

/** DeepSeek being down or too slow, as opposed to a reply that couldn't be used. */
function outage(error: unknown): error is AiError {
  return error instanceof AiError && (error.code === "unavailable" || error.code === "timeout");
}

/** A pause before retrying a model that just failed, long enough for a brief overload to pass. */
export const OUTAGE_PAUSE_MS = 800;

/** How long a second try may take, so both fit in one request with time left for the reply. */
const SECOND_TRY_MS = 15_000;

/**
 * One more try after DeepSeek failed or timed out: on the everyday model when
 * the turn asked for a stronger one, otherwise the same model after a short
 * pause. A timeout on the everyday model already used most of the time
 * budget, so it isn't retried.
 */
async function afterOutage(
  error: AiError,
  settings: DeepSeekSettings,
  turnSettings: DeepSeekSettings,
  messages: ChatMessage[],
  today: string,
  fetchImpl: typeof fetch,
): Promise<InterpretedAction> {
  const switching = turnSettings.model !== settings.model;
  if (!switching && error.code === "timeout") throw error;
  if (!switching) await new Promise((resolve) => setTimeout(resolve, OUTAGE_PAUSE_MS));
  const retry = await attempt(settings, messages, { timeoutMs: SECOND_TRY_MS }, today, fetchImpl);
  if (retry.success) return retry.data;
  throw new AiError("invalid", `DeepSeek returned an invalid finance action (${retry.issue}).`);
}

/** One completion read as a finance action; an unreadable reply comes back as an issue instead of throwing. */
async function attempt(
  settings: DeepSeekSettings,
  messages: ChatMessage[],
  options: { temperature?: number; timeoutMs?: number },
  today: string,
  fetchImpl: typeof fetch,
  complete: Completion = chatCompletion,
): Promise<{ success: true; data: InterpretedAction } | { success: false; issue: string }> {
  let content: string;
  try {
    content = await complete(settings, messages, options, fetchImpl);
  } catch (error) {
    if (error instanceof AiError && error.code === "invalid") return { success: false, issue: error.message };
    throw error;
  }
  return parseModelOutput(content, { today });
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

/** Statuses that mean the provider refused Alfred's account (no credit, bad key), not a passing outage. */
const ACCOUNT_STATUSES = new Set([401, 402, 403]);

/** One model call returning the reply text; chatCompletion is DeepSeek's. */
export type Completion = typeof chatCompletion;

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
  if (ACCOUNT_STATUSES.has(response.status)) {
    const error = new AiError("account", `DeepSeek refused Alfred's account with status ${response.status}.`);
    const event = response.status === 402 ? "ai_out_of_credit" : "ai_key_rejected";
    logError(event, error);
    await alertOperator(event, response.status === 402
      ? "DeepSeek is out of credit (HTTP 402). Alfred can't read chat messages until it's topped up."
      : `DeepSeek rejected Alfred's API key (HTTP ${response.status}). Alfred can't read chat messages until the key is fixed.`);
    throw error;
  }
  if (!response.ok) throw new AiError("unavailable", `DeepSeek failed with status ${response.status}.`);

  // The time limit also covers reading the body, so a slow reply can time out here too.
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) throw new AiError("timeout", "DeepSeek timed out.");
    throw new AiError("invalid", "DeepSeek returned an unexpected payload.");
  }
  const parsed = completionSchema.safeParse(body);
  if (!parsed.success) throw new AiError("invalid", "DeepSeek returned an unexpected payload.");
  const choice = parsed.data.choices[0];
  if (choice.finish_reason === "length") {
    throw new AiError("invalid", "DeepSeek truncated the finance action.");
  }
  const content = choice.message.content?.trim() ?? "";
  if (!content || content.length > 12_000) throw new AiError("invalid", "DeepSeek returned empty JSON.");
  return content;
}
