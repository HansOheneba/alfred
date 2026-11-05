import Anthropic from "@anthropic-ai/sdk";

import type { ChatMessage, Completion } from "@/lib/ai/deepseek";
import { AiError } from "@/lib/errors";

/**
 * A Claude model answering the same prompt DeepSeek gets, so the evals can
 * compare them on identical conversations. Used by the evals only; the app
 * still runs on DeepSeek.
 */
export function claudeCompletion(model: string, options: { apiKey: string; effort?: "low" | "medium" | "high" }): Completion {
  // The base URL is fixed so a proxy configured for other tools on this machine can't redirect the calls.
  const client = new Anthropic({ apiKey: options.apiKey, baseURL: "https://api.anthropic.com" });
  return async (_settings, messages, request) => {
    const system = messages.filter((message) => message.role === "system").map((message) => textOf(message.content)).join("\n\n");
    const turns: Anthropic.MessageParam[] = messages
      .filter((message) => message.role !== "system")
      .map((message) => ({ role: message.role as "user" | "assistant", content: textOf(message.content) }));
    // The conversation must open with the person; earlier history can start with Alfred.
    if (turns[0]?.role === "assistant") turns.unshift({ role: "user", content: "(Earlier in our conversation.)" });
    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model,
        max_tokens: 8000,
        system: [{ type: "text", text: `${system}\n\nReply with exactly one JSON object and nothing else: no prose, no code fences.`, cache_control: { type: "ephemeral" } }],
        messages: turns,
        output_config: { effort: options.effort ?? "low" },
      }, { timeout: request.timeoutMs ?? 30_000, maxRetries: 1 });
    } catch (error) {
      if (error instanceof Anthropic.RateLimitError) throw new AiError("rate_limit", "Claude rate limited the request.");
      if (error instanceof Anthropic.APIConnectionTimeoutError) throw new AiError("timeout", "Claude timed out.");
      if (error instanceof Anthropic.APIError) throw new AiError("unavailable", `Claude failed with status ${error.status ?? "unknown"}.`);
      throw new AiError("unavailable", "Claude could not be reached.");
    }
    if (response.stop_reason === "refusal") throw new AiError("invalid", "Claude declined the request.");
    if (response.stop_reason === "max_tokens") throw new AiError("invalid", "Claude truncated the finance action.");
    const text = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("").trim();
    const start = text.indexOf("{"), end = text.lastIndexOf("}");
    if (start === -1 || end <= start) throw new AiError("invalid", "Claude returned no JSON.");
    return text.slice(start, end + 1);
  };
}

function textOf(content: ChatMessage["content"]): string {
  return typeof content === "string" ? content : content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}
