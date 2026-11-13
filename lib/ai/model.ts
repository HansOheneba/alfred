import Anthropic from "@anthropic-ai/sdk";

import type { Channel } from "@/lib/ai/persona";
import { buildSystemPromptParts, type RecentTransaction } from "@/lib/ai/prompts";
import { LIMITS, type ModelSettings } from "@/lib/config";
import { alertOperator } from "@/lib/ai/operator-alert";
import { AiError } from "@/lib/errors";
import { logError } from "@/lib/log";
import type { CategoryRecord } from "@/lib/finance/types";
import type { ConversationContext } from "@/lib/finance/conversation";
import { zonedYmd } from "@/lib/finance/dates";
import { parseModelOutput, type InterpretedAction } from "@/lib/finance/schemas";

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
  /** What's open in the conversation: what Alfred just asked, offered, or promised. */
  open?: string[];
  /** What the model looked up earlier in this turn, with the results. */
  lookups?: { query: string; lines: string[] }[];
  /** How many more lookup rounds the model may ask for; 0 means answer now. */
  lookupsLeft?: number;
  /** Use the stronger model, for turns that need more care. */
  strong?: boolean;
};

export async function interpretMessage(
  settings: ModelSettings,
  request: InterpretRequest,
  fetchImpl: typeof fetch = fetch,
  /** Which completion answers; tests and evals can swap it. */
  complete: Completion = chatCompletion,
): Promise<InterpretedAction> {
  const today = zonedYmd(request.now, request.timezone);
  const [stable, perTurn] = buildSystemPromptParts({
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
    open: request.open,
    lookups: request.lookups,
    lookupsLeft: request.lookupsLeft,
  });
  const turnSettings = request.strong ? { ...settings, model: settings.strongModel } : settings;
  const userText = request.text.slice(0, LIMITS.maxUserTextChars);
  const messages: ChatMessage[] = [{ role: "system", content: stable }, { role: "system", content: perTurn }, ...conversationTurns(request.history ?? []), { role: "user", content: userText }];
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
  const retry = await attempt(turnSettings, retryMessages, {}, today, fetchImpl, complete);
  if (retry.success) return retry.data;
  // A last try on the everyday model, when this turn asked for a different one.
  if (turnSettings.model !== settings.model) {
    const fallback = await attempt(settings, messages, {}, today, fetchImpl, complete);
    if (fallback.success) return fallback.data;
  }
  // The schema issue (field paths and messages, never the user's words) is what the logs need to explain a fallback.
  throw new AiError("invalid", `Claude returned an invalid finance action (${retry.issue}).`);
}

/** Claude being down or too slow, as opposed to a reply that couldn't be used. */
function outage(error: unknown): error is AiError {
  return error instanceof AiError && (error.code === "unavailable" || error.code === "timeout");
}

/** A pause before retrying a model that just failed, long enough for a brief overload to pass. */
export const OUTAGE_PAUSE_MS = 800;

/** How long a second try may take, so both fit in one request with time left for the reply. */
const SECOND_TRY_MS = 15_000;

/**
 * One more try after Claude failed or timed out: on the everyday model when
 * the turn asked for a stronger one, otherwise the same model after a short
 * pause. A timeout on the everyday model already used most of the time
 * budget, so it isn't retried.
 */
async function afterOutage(
  error: AiError,
  settings: ModelSettings,
  turnSettings: ModelSettings,
  messages: ChatMessage[],
  today: string,
  fetchImpl: typeof fetch,
): Promise<InterpretedAction> {
  const switching = turnSettings.model !== settings.model;
  if (!switching && error.code === "timeout") throw error;
  if (!switching) await new Promise((resolve) => setTimeout(resolve, OUTAGE_PAUSE_MS));
  const retry = await attempt(settings, messages, { timeoutMs: SECOND_TRY_MS }, today, fetchImpl);
  if (retry.success) return retry.data;
  throw new AiError("invalid", `Claude returned an invalid finance action (${retry.issue}).`);
}

/** One completion read as a finance action; an unreadable reply comes back as an issue instead of throwing. */
async function attempt(
  settings: ModelSettings,
  messages: ChatMessage[],
  options: { timeoutMs?: number },
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

/** One model call returning the reply text; chatCompletion is Claude's. */
export type Completion = typeof chatCompletion;

/** How the reply must look, added after every system prompt: the callers parse it as JSON. */
const JSON_ONLY = "Reply with exactly one JSON object and nothing else: no prose, no code fences.";

/**
 * Thinking off where the model allows it: the replies are
 * short JSON, and thinking would add cost and seconds to every turn. Haiku 5.5
 * takes "disabled"; Sonnet 5.5 rejects it and turns thinking off with
 * "between_tools" (with no tools, it never thinks). Other models keep their default.
 */
function thinkingFor(model: string): Anthropic.ThinkingConfigParam | undefined {
  if (model.startsWith("claude-sonnet-5-5")) return { type: "between_tools" };
  if (model.startsWith("claude-haiku")) return { type: "disabled" };
  return undefined;
}

/** Claude has no image_url parts: a data URL becomes a base64 image block. */
function contentFor(content: ChatMessage["content"]): string | Anthropic.ContentBlockParam[] {
  if (typeof content === "string") return content;
  return content.map((part): Anthropic.ContentBlockParam => {
    if (part.type === "text") return { type: "text", text: part.text };
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/.exec(part.image_url.url);
    if (!match) return { type: "image", source: { type: "url", url: part.image_url.url } };
    return { type: "image", source: { type: "base64", media_type: match[1] as "image/png", data: match[2] } };
  });
}

function textOf(content: ChatMessage["content"]): string {
  return typeof content === "string" ? content : content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

/** Out of credit: Claude answers 400 "credit balance is too low", not 402. */
function outOfCredit(error: InstanceType<typeof Anthropic.APIError>): boolean {
  return error.status === 402 || (error.status === 400 && /credit balance/i.test(error.message));
}

async function refuseAccount(status: number | undefined, credit: boolean): Promise<never> {
  const error = new AiError("account", `Claude refused Alfred's account with status ${status ?? "unknown"}.`);
  const event = credit ? "ai_out_of_credit" : "ai_key_rejected";
  logError(event, error);
  await alertOperator(event, credit
    ? "Claude is out of credit. Alfred can't read chat messages until the Anthropic account is topped up."
    : `Claude rejected Alfred's API key (HTTP ${status ?? "unknown"}). Alfred can't read chat messages until ANTHROPIC_API_KEY is fixed.`);
  throw error;
}

export async function chatCompletion(
  settings: ModelSettings,
  messages: ChatMessage[],
  options: { maxTokens?: number; timeoutMs?: number },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  // The base URL is fixed so a proxy configured for other tools on this machine can't redirect the calls.
  // Retries are Alfred's own (see interpretMessage), so the SDK makes exactly one attempt.
  const client = new Anthropic({ apiKey: settings.apiKey, baseURL: "https://api.anthropic.com", fetch: fetchImpl, maxRetries: 0 });
  // System messages become system blocks, each cached: the first is the long, stable part.
  const systemTexts = messages.filter((message) => message.role === "system").map((message) => textOf(message.content));
  const system: Anthropic.TextBlockParam[] = [...systemTexts, JSON_ONLY].map((text, index, all) => ({
    type: "text",
    text,
    // At most two cache breakpoints: after the stable part and after the whole system prompt.
    ...(index === 0 || (index === all.length - 1 && all.length > 1) ? { cache_control: { type: "ephemeral" as const } } : {}),
  }));
  const turns: Anthropic.MessageParam[] = messages
    .filter((message) => message.role !== "system")
    .map((message) => ({ role: message.role as "user" | "assistant", content: contentFor(message.content) }));
  // The conversation must open with the person; earlier history can start with Alfred.
  if (turns[0]?.role === "assistant") turns.unshift({ role: "user", content: "(Earlier in our conversation.)" });
  const thinking = thinkingFor(settings.model);

  let response: Anthropic.Message;
  try {
    response = await client.messages.create(
      {
        model: settings.model,
        max_tokens: options.maxTokens ?? LIMITS.maxModelTokens,
        system,
        messages: turns,
        ...(thinking ? { thinking } : {}),
      },
      { timeout: options.timeoutMs ?? LIMITS.aiTimeoutMs },
    );
  } catch (error) {
    if (error instanceof Anthropic.APIConnectionTimeoutError) throw new AiError("timeout", "Claude timed out.");
    if (error instanceof Anthropic.RateLimitError) throw new AiError("rate_limit", "Claude rate limited the request.");
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) return refuseAccount(error.status, false);
    if (error instanceof Anthropic.APIError && outOfCredit(error)) return refuseAccount(error.status, true);
    if (error instanceof Anthropic.APIConnectionError) throw new AiError("unavailable", "Claude could not be reached.");
    if (error instanceof Anthropic.APIError) throw new AiError("unavailable", `Claude failed with status ${error.status ?? "unknown"}.`);
    // A body that times out while it is read surfaces as the fetch's own timeout.
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) throw new AiError("timeout", "Claude timed out.");
    throw new AiError("unavailable", "Claude could not be reached.");
  }

  if (response.stop_reason === "refusal") throw new AiError("invalid", "Claude declined the request.");
  if (response.stop_reason === "max_tokens") throw new AiError("invalid", "Claude truncated the finance action.");
  const text = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("").trim();
  // Claude has no JSON mode here, so take the object out of anything wrapped around it.
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new AiError("invalid", "Claude returned empty JSON.");
  const content = text.slice(start, end + 1);
  if (content.length > 12_000) throw new AiError("invalid", "Claude returned too much JSON.");
  return content;
}
