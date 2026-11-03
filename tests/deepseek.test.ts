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

  it("retries an empty reply with a little temperature", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(""))
      .mockResolvedValueOnce(jsonResponse(JSON.stringify({ type: "help" })));
    const action = await interpretMessage(settings, request, fetchImpl as typeof fetch);
    expect(action.type).toBe("help");
    const retry = JSON.parse(String(fetchImpl.mock.calls[1][1].body)) as { temperature: number };
    expect(retry.temperature).toBeGreaterThan(0);
  });

  it("falls back to the everyday model when the turn's model keeps coming back empty", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(""))
      .mockResolvedValueOnce(jsonResponse(""))
      .mockResolvedValueOnce(jsonResponse(JSON.stringify({ type: "help" })));
    const action = await interpretMessage(settings, { ...request, model: "deepseek-pro" }, fetchImpl as typeof fetch);
    expect(action.type).toBe("help");
    const models = fetchImpl.mock.calls.map((call) => (JSON.parse(String(call[1].body)) as { model: string }).model);
    expect(models).toEqual(["deepseek-pro", "deepseek-pro", "deepseek-flash"]);
  });

  it("gives up after two empty replies on the everyday model", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(""));
    await expect(interpretMessage(settings, request, fetchImpl as typeof fetch)).rejects.toMatchObject({ code: "invalid" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("moves to the everyday model when the turn's model is down", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(jsonResponse(JSON.stringify({ type: "help" })));
    const action = await interpretMessage(settings, { ...request, model: "deepseek-pro" }, fetchImpl as typeof fetch);
    expect(action.type).toBe("help");
    const models = fetchImpl.mock.calls.map((call) => (JSON.parse(String(call[1].body)) as { model: string }).model);
    expect(models).toEqual(["deepseek-pro", "deepseek-flash"]);
  });

  it("tries the everyday model once more after a brief outage", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(jsonResponse(JSON.stringify({ type: "help" })));
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
    const slow = { ok: true, status: 200, json: async () => { throw timeout; } } as unknown as Response;
    const fetchImpl = vi.fn().mockResolvedValueOnce(slow).mockResolvedValueOnce(slow);
    await expect(interpretMessage(settings, { ...request, model: "deepseek-pro" }, fetchImpl as typeof fetch)).rejects.toMatchObject({ code: "timeout" });
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
