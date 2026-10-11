import { describe, expect, it, vi } from "vitest";

import { interpretMessage } from "@/lib/ai/deepseek";
import { buildSystemPrompt } from "@/lib/ai/prompts";
import { AiError } from "@/lib/errors";

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
});
