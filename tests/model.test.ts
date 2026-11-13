import { describe, expect, it, vi } from "vitest";

import { chatCompletion, interpretMessage } from "@/lib/ai/model";
import { buildSystemPrompt, buildSystemPromptParts } from "@/lib/ai/prompts";
import { AiError } from "@/lib/errors";
import { parseModelOutput } from "@/lib/finance/schemas";
import { typedDecision } from "@/lib/finance/pending";

const settings = { apiKey: "sk-test-key", model: "claude-haiku-5-5", strongModel: "claude-sonnet-5-5" };
const request = {
  text: "I spent GH₵45 on lunch",
  timezone: "Africa/Accra",
  currency: "GHS",
  now: new Date("2026-10-11T15:00:00.000Z"),
  recent: [],
};

type SentBody = {
  model: string;
  max_tokens: number;
  thinking?: { type: string };
  temperature?: number;
  system: { type: string; text: string; cache_control?: { type: string } }[];
  messages: { role: string; content: string | { type: string; source?: { type: string; media_type?: string } }[] }[];
};

function claudeReply(text: string, stop_reason = "end_turn"): Response {
  return Response.json({
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content: text ? [{ type: "text", text }] : [],
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  });
}

function apiError(status: number, message = "error"): Response {
  return Response.json({ type: "error", error: { type: "api_error", message } }, { status });
}

const sent = (fetchImpl: ReturnType<typeof vi.fn>, call: number) => JSON.parse(String(fetchImpl.mock.calls[call][1].body)) as SentBody;

describe("Claude client", () => {
  it("calls the Messages API with the key in a header, never the body", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.anthropic.com/v1/messages");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-test-key");
      expect(String(init?.body)).not.toContain("sk-test-key");
      return claudeReply(JSON.stringify({ type: "help" }));
    });
    const action = await interpretMessage(settings, request, fetchImpl as typeof fetch);
    expect(action.type).toBe("help");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = sent(fetchImpl, 0);
    expect(body.model).toBe("claude-haiku-5-5");
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.temperature).toBeUndefined();
    expect(body.messages.map((message) => message.role)).toEqual(["user"]);
  });

  it("caches the stable part of the system prompt and the whole of it", async () => {
    const fetchImpl = vi.fn(async () => claudeReply(JSON.stringify({ type: "help" })));
    await interpretMessage(settings, { ...request, recent: [{ transactionId: "t1", transactionDate: "2026-10-11", type: "expense", amount: "45.00", currency: "GHS", category: "Food", description: "Lunch" }] }, fetchImpl as typeof fetch);
    const { system } = sent(fetchImpl, 0);
    expect(system).toHaveLength(3);
    expect(system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(system[1].cache_control).toBeUndefined();
    expect(system[2].cache_control).toEqual({ type: "ephemeral" });
    // What changes from message to message stays out of the first, cached block.
    expect(system[0].text).toContain("Today is 2026-10-11");
    expect(system[0].text).not.toContain("Lunch");
    expect(system[1].text).toContain("Lunch");
    expect(system[2].text).toMatch(/exactly one JSON object/);
  });

  it("reads JSON wrapped in prose or a code fence", async () => {
    const fetchImpl = vi.fn(async () => claudeReply('```json\n{"type":"help"}\n```'));
    expect((await interpretMessage(settings, request, fetchImpl as typeof fetch)).type).toBe("help");
  });

  it("sends turns that need care to the strong model with thinking off", async () => {
    const fetchImpl = vi.fn(async () => claudeReply(JSON.stringify({ type: "help" })));
    await interpretMessage(settings, { ...request, strong: true }, fetchImpl as typeof fetch);
    const body = sent(fetchImpl, 0);
    expect(body.model).toBe("claude-sonnet-5-5");
    expect(body.thinking).toEqual({ type: "between_tools" });
  });

  it("retries once when the first JSON action is invalid", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(claudeReply("{\"type\":\"nope\"}"))
      .mockResolvedValueOnce(claudeReply(JSON.stringify({ type: "help" })));
    const action = await interpretMessage(settings, request, fetchImpl as typeof fetch);
    expect(action.type).toBe("help");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("falls back to the everyday model when the strong model keeps coming back empty", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(claudeReply(""))
      .mockResolvedValueOnce(claudeReply(""))
      .mockResolvedValueOnce(claudeReply(JSON.stringify({ type: "help" })));
    const action = await interpretMessage(settings, { ...request, strong: true }, fetchImpl as typeof fetch);
    expect(action.type).toBe("help");
    expect(fetchImpl.mock.calls.map((_call, index) => sent(fetchImpl, index).model)).toEqual(["claude-sonnet-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
  });

  it("treats a refusal or a cut-off reply as unusable", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(claudeReply("", "refusal"))
      .mockResolvedValueOnce(claudeReply('{"type":"he', "max_tokens"));
    await expect(interpretMessage(settings, request, fetchImpl as typeof fetch)).rejects.toMatchObject({ code: "invalid" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("gives up after two empty replies on the everyday model", async () => {
    const fetchImpl = vi.fn(async () => claudeReply(""));
    await expect(interpretMessage(settings, request, fetchImpl as typeof fetch)).rejects.toMatchObject({ code: "invalid" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("moves to the everyday model when the strong model is down", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(apiError(529, "Overloaded"))
      .mockResolvedValueOnce(claudeReply(JSON.stringify({ type: "help" })));
    const action = await interpretMessage(settings, { ...request, strong: true }, fetchImpl as typeof fetch);
    expect(action.type).toBe("help");
    expect(fetchImpl.mock.calls.map((_call, index) => sent(fetchImpl, index).model)).toEqual(["claude-sonnet-5-5", "claude-haiku-5-5"]);
  });

  it("tries the everyday model once more after a brief outage", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(apiError(503))
      .mockResolvedValueOnce(claudeReply(JSON.stringify({ type: "help" })));
    const action = await interpretMessage(settings, request, fetchImpl as typeof fetch);
    expect(action.type).toBe("help");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("gives up on the everyday model when it times out, leaving time to reply", async () => {
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    const fetchImpl = vi.fn().mockRejectedValue(timeout);
    await expect(interpretMessage(settings, request, fetchImpl as typeof fetch)).rejects.toMatchObject({ code: "timeout" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports a reply that times out mid-body as a timeout", async () => {
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    const slow = () => new Response(new ReadableStream({ pull: (controller) => controller.error(timeout) }), { headers: { "content-type": "application/json" } });
    const fetchImpl = vi.fn().mockImplementation(async () => slow());
    await expect(interpretMessage(settings, { ...request, strong: true }, fetchImpl as typeof fetch)).rejects.toMatchObject({ code: "timeout" });
  });

  it("does not retry a rate limit", async () => {
    const fetchImpl = vi.fn(async () => apiError(429));
    await expect(interpretMessage(settings, request, fetchImpl as typeof fetch)).rejects.toBeInstanceOf(AiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps the API key out of the prompt", () => {
    const prompt = buildSystemPrompt({
      today: "2026-10-11",
      timezone: "Africa/Accra",
      currency: "GHS",
      recent: [],
    });
    expect(prompt).toContain("JSON");
    expect(prompt).toContain("Food");
    expect(prompt).not.toContain("sk-");
  });

  it("joins the two prompt parts back into the same prompt", () => {
    const input = { today: "2026-10-11", timezone: "Africa/Accra", currency: "GHS", recent: [] };
    expect(buildSystemPromptParts(input).join("\n")).toBe(buildSystemPrompt(input));
  });

  it("sends the schema problem back to the model on retry", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(claudeReply('{"type":"set_budget","category":"Food"}'))
      .mockResolvedValueOnce(claudeReply(JSON.stringify({ type: "help" })));
    await interpretMessage(settings, request, fetchImpl as typeof fetch);
    const retry = sent(fetchImpl, 1);
    expect(retry.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(retry.messages[2].content).toContain("amount");
  });

  it("sends images as base64 image blocks", async () => {
    const fetchImpl = vi.fn(async () => claudeReply(JSON.stringify({ text: "Paid GHS 20", kind: "bank_sms" })));
    await chatCompletion(settings, [
      { role: "system", content: "Transcribe." },
      { role: "user", content: [{ type: "text", text: "Transcribe this image." }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }] },
    ], {}, fetchImpl as typeof fetch);
    const content = sent(fetchImpl, 0).messages[0].content as { type: string; source?: { type: string; media_type?: string } }[];
    expect(content[1]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/png" } });
  });
});

describe("model output repair", () => {
  it("moves top-level correction fields into changes", () => {
    const parsed = parseModelOutput(
      '{"type":"correct_transaction","transaction_id":"11111111-1111-4111-8111-111111111111","amount":"60","category":"Food"}',
    );
    expect(parsed.success && parsed.data.type === "correct_transaction" && parsed.data.changes).toEqual({
      amount: "60.00",
      category: "Food",
    });
  });

  it("accepts message as the question of a clarify", () => {
    const parsed = parseModelOutput('{"type":"clarify","message":"What was it for?"}');
    expect(parsed.success && parsed.data.type === "clarify" && parsed.data.question).toBe("What was it for?");
  });

  it("turns relative budget periods into months", () => {
    const parsed = parseModelOutput('{"type":"set_budget","category":"Food","amount":"800","currency":"GHS","period":"last_month"}', {
      today: "2026-01-15",
    });
    expect(parsed.success && parsed.data.type === "set_budget" && parsed.data.period).toBe("2025-12");
  });

  it("recognizes short typed confirmations only", () => {
    expect(typedDecision("Yes!")).toBe("confirm");
    expect(typedDecision("ok")).toBe("confirm");
    expect(typedDecision("no.")).toBe("cancel");
    expect(typedDecision("never mind")).toBe("cancel");
    expect(typedDecision("yes I spent 40 on lunch")).toBeNull();
  });
});
