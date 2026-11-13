import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { interpretMessage } from "@/lib/ai/model";
import { alertOperator, resetOperatorAlerts } from "@/lib/ai/operator-alert";
import { AiError } from "@/lib/errors";
import { FALLBACKS } from "@/lib/learning/review";
import { AI_ACCOUNT_TEXT, userFacingError } from "@/lib/telegram/messages";

const settings = { apiKey: "sk-test-key", model: "claude-haiku-5-5", strongModel: "claude-sonnet-5-5" };
const request = {
  text: "Paid 12 cedis for a taxi, cash",
  timezone: "Africa/Accra",
  currency: "GHS",
  now: new Date("2026-10-11T15:00:00.000Z"),
  recent: [],
};
const operatorEnv = { ALFRED_OPERATOR_TELEGRAM_ID: "1000001", TELEGRAM_BOT_TOKEN: "123456:test-token-value" };

beforeEach(() => resetOperatorAlerts());
afterEach(() => vi.restoreAllMocks());

describe("model provider refusing Alfred's account", () => {
  const apiError = (status: number, message = "error") => Response.json({ type: "error", error: { type: "invalid_request_error", message } }, { status });

  it.each([401, 402, 403])("reads HTTP %i as an account problem and doesn't retry it", async (status) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => apiError(status));
    const error = await interpretMessage(settings, request, fetchImpl as typeof fetch).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).code).toBe("account");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("logs Claude's low-credit 400 as out of credit, and doesn't retry it", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => apiError(400, "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."));
    const caught = await interpretMessage(settings, request, fetchImpl as typeof fetch).catch((thrown: unknown) => thrown);
    expect((caught as AiError).code).toBe("account");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.map((call) => JSON.parse(String(call[0])).event)).toContain("ai_out_of_credit");
  });

  it("keeps an ordinary bad request apart from running out of credit", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => apiError(400, "messages: roles must alternate"));
    const caught = await interpretMessage(settings, request, fetchImpl as typeof fetch).catch((thrown: unknown) => thrown);
    expect((caught as AiError).code).not.toBe("account");
  });

  it("tells the person plainly, without 'try again in a minute'", () => {
    const text = userFacingError(new AiError("account", "out of credit"));
    expect(text).toBe(AI_ACCOUNT_TEXT);
    expect(text).toMatch(/nothing you did/i);
    expect(text).toMatch(/nothing was saved/i);
    expect(text).not.toMatch(/running slow|in a minute/i);
  });

  it("still says 'running slow' for a passing outage", () => {
    expect(userFacingError(new AiError("unavailable", "status 503"))).toMatch(/running slow/);
  });

  it("is caught by the daily failure review", () => {
    expect(FALLBACKS.some((item) => item.pattern.test(AI_ACCOUNT_TEXT))).toBe(true);
  });
});

describe("operator alert", () => {
  it("does nothing without an operator Telegram ID", async () => {
    const fetchImpl = vi.fn();
    expect(await alertOperator("ai_out_of_credit", "x", { env: { TELEGRAM_BOT_TOKEN: "t" }, fetchImpl })).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends once an hour per kind of alert", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const t = Date.parse("2026-10-11T10:00:00Z");
    expect(await alertOperator("ai_out_of_credit", "empty", { env: operatorEnv, fetchImpl, now: t })).toBe(true);
    expect(await alertOperator("ai_out_of_credit", "empty", { env: operatorEnv, fetchImpl, now: t + 10 * 60_000 })).toBe(false);
    expect(await alertOperator("ai_out_of_credit", "empty", { env: operatorEnv, fetchImpl, now: t + 61 * 60_000 })).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body).toEqual({ chat_id: 1000001, text: "Alfred alert: empty" });
  });

  it("never throws when Telegram fails, and tries again next time", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => { throw new Error("offline"); });
    expect(await alertOperator("ai_out_of_credit", "x", { env: operatorEnv, fetchImpl })).toBe(false);
    expect(await alertOperator("ai_out_of_credit", "x", { env: operatorEnv, fetchImpl })).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
