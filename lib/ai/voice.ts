import { z } from "zod";

import { chatCompletion } from "@/lib/ai/deepseek";
import { BUILDER_NAME, personaLines, type Channel } from "@/lib/ai/persona";
import { DASHBOARD_URL, type DeepSeekSettings, type UserProfile } from "@/lib/config";
import type { Delivery } from "@/lib/finance/action-router";
import type { ChatCue } from "@/lib/finance/context";
import type { FinanceAction } from "@/lib/finance/schemas";
import { logError } from "@/lib/log";

export type VoiceRequest = {
  draft: string;
  userText: string;
  intent: FinanceAction["type"];
  profile: UserProfile;
  channel: Channel;
  /** Set for chat replies: the conversation so far and how long it has drifted. */
  cue?: ChatCue;
  topic?: "money" | "other";
  /** What's true right now: waiting payments and what's open in the conversation. The reply must never contradict it. */
  state?: string[];
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

/** The label stored with an assistant reply; chat is split so off-topic runs can be counted. */
export function intentOf(action: FinanceAction): string {
  return action.type === "chat" ? `chat:${action.topic ?? "other"}` : action.type;
}

function ladder(turn: number, topic: "money" | "other", builder: string): string {
  if (topic === "money") {
    return "This is about their money, so lean in: be supportive and practical, like a friend who is good with money. Two or three sentences.";
  }
  if (turn <= 1) {
    return `Reply the way a warm person would, briefly. A light money-flavoured touch is welcome, but don't push, don't ask them to log anything, and don't mention who built you.`;
  }
  if (turn === 2) {
    return `Play along briefly, then leave a soft, natural opening back to their money. Don't lecture and don't mention who built you yet.`;
  }
  if (turn === 3) {
    return [
      "They have been chatting off-topic for three messages in a row. Answer briefly, then steer back to their finances with gentle wit.",
      `Make the point that ${builder} built you to help with their money. If you are talking to ${builder} himself, say he built you for exactly this.`,
      "Stay warm; never refuse or sound like a wall.",
    ].join(" ");
  }
  return [
    `They are still off-topic (${turn} messages in a row) and you have already reminded them why ${builder} built you, so don't say that again.`,
    "Answer in a few words, then offer one concrete thing you could do right now, such as showing this week's spending or logging today's expenses. Keep it light.",
  ].join(" ");
}

/** The person's local date and time, e.g. "Sunday 25 October 2026 at 12:57". */
function nowLine(timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit", timeZone }).format(new Date());
}

function chatSystem(request: VoiceRequest): string {
  const cue = request.cue;
  const history = cue?.history.length ? cue.history.map((item) => `${item.role}: ${item.body}`).join("\n") : "None.";
  return [
    ...personaLines(request.profile, request.channel),
    `Right now it is ${nowLine(request.profile.timezone)} where they are. Use this if they ask the date or time; never guess.`,
    "You are replying in an ongoing chat. Recent conversation, oldest first:",
    history,
    `Facts you may use if they help, word for word: ${cue?.snapshot ?? "none"}`,
    "What's true right now. Never contradict it, and never say nothing is waiting when something is:",
    ...(request.state?.length ? request.state : ["Nothing in particular."]),
    "Keep what the draft does: if it answers, asks, or offers something, your reply does the same. Never promise to do something the draft doesn't.",
    "If they ask a general question, such as a fact or a recommendation, answer it in one short line first.",
    ladder(cue?.offTopicTurn ?? 1, request.topic ?? "other", BUILDER_NAME),
    "Keep it to one or two sentences unless the line above allows more. Never state any figure that is not in the facts above.",
    'Reply with JSON only, in the form {"reply":"..."}.',
  ].join("\n");
}

export function createVoice(settings: DeepSeekSettings, fetchImpl: typeof fetch = fetch): Voice {
  return async (request) => {
    if (request.intent === "chat") {
      const content = await chatCompletion(
        settings,
        [
          { role: "system", content: chatSystem(request) },
          { role: "user", content: `${request.userText}\n\n(A plain draft you can improve on: ${request.draft})` },
        ],
        { temperature: 0.85, maxTokens: 300, timeoutMs: 10_000 },
        fetchImpl,
      );
      const parsed = replySchema.safeParse(JSON.parse(content));
      if (!parsed.success) throw new Error("Voice reply did not match the schema.");
      return parsed.data.reply.trim();
    }
    const system = [
      ...personaLines(request.profile, request.channel),
      "The server has already worked out the facts below from the user's stored records. Rewrite them as your reply to the user's message.",
      "Every number, amount, percentage, and date you mention must appear exactly as written in the facts. Do not calculate, round, estimate, or add any new figure.",
      "You may leave out minor facts, but never change their meaning, and never claim something was saved, changed, or deleted unless the facts say so.",
      ...(request.state?.length ? ["Also true right now, so never contradict it:", ...request.state] : []),
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
  const chat = action.type === "chat";
  if (!voice || delivery.kind !== "text" || (!chat && !VOICED.has(action.type))) return delivery;
  try {
    const reply = await voice({
      ...request,
      draft: delivery.text,
      intent: action.type,
      topic: chat ? (action.topic ?? "other") : undefined,
    });
    const source = `${delivery.text}\n${request.userText}\n${chat ? `${request.cue?.snapshot ?? ""}\n${nowLine(request.profile.timezone)}` : ""}`;
    if (!keepsFacts(reply, source)) return delivery;
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
