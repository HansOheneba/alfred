import { describe, expect, it, vi } from "vitest";

import { interpretMessage } from "@/lib/ai/deepseek";
import { buildSystemPrompt } from "@/lib/ai/prompts";
import { AiError } from "@/lib/errors";
import { parseModelOutput } from "@/lib/finance/schemas";
import { typedDecision } from "@/lib/finance/pending";

const settings = { apiKey: "sk-test-key", model: "deepseek-flash" };
const request = {
  text: "I spent GH₵45 on lunch",
  timezone: "Africa/Accra",
  currency: "GHS",
  now: new Date("2026-10-11T15:00:00.000Z"),
  recent: [],
};

function jsonResponse(content: string, status = 200): Response {
  return new Response(
    JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content } }],
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

describe("DeepSeek client", () => {
  it("sends JSON mode without putting the API key in the body", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string; thinking: { type: string } };
      expect(body.model).toBe("deepseek-flash");
      expect(body.thinking.type).toBe("disabled");
      expect(JSON.stringify(body)).not.toContain("sk-test-key");
      expect(String(init?.headers && new Headers(init.headers).get("authorization"))).toContain("Bearer ");
      return jsonResponse(JSON.stringify({ type: "help" }));
    });
    const action = await interpretMessage(settings, request, fetchImpl as typeof fetch);
    expect(action.type).toBe("help");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries once when the first JSON action is invalid", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse("{\"type\":\"nope\"}"))
      .mockResolvedValueOnce(jsonResponse(JSON.stringify({ type: "help" })));
    const action = await interpretMessage(settings, request, fetchImpl as typeof fetch);
    expect(action.type).toBe("help");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry a rate limit", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 429 }));
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

  it("sends the schema problem back to the model on retry", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse('{"type":"set_budget","category":"Food"}'))
      .mockResolvedValueOnce(jsonResponse(JSON.stringify({ type: "help" })));
    await interpretMessage(settings, request, fetchImpl as typeof fetch);
    const retry = JSON.parse(String(fetchImpl.mock.calls[1][1].body)) as { messages: { role: string; content: string }[] };
    expect(retry.messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(retry.messages[3].content).toContain("amount");
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
