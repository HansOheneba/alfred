import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkModelBalance } from "@/lib/ai/balance";
import { interpretMessage } from "@/lib/ai/deepseek";
import { alertOperator, resetOperatorAlerts } from "@/lib/ai/operator-alert";
import { AiError } from "@/lib/errors";
import { FALLBACKS } from "@/lib/learning/review";
import { AI_ACCOUNT_TEXT, userFacingError } from "@/lib/telegram/messages";

const settings = { apiKey: "sk-test-key", model: "deepseek-flash" };
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
  it.each([401, 402, 403])("reads HTTP %i as an account problem and doesn't retry it", async (status) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response("{}", { status }));
    const error = await interpretMessage(settings, request, fetchImpl as typeof fetch).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).code).toBe("account");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("logs out-of-credit under its own event", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await interpretMessage(settings, request, (async () => new Response("{}", { status: 402 })) as typeof fetch).catch(() => {});
    expect(log.mock.calls.map((call) => JSON.parse(String(call[0])).event)).toContain("ai_out_of_credit");
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

describe("daily balance check", () => {
  const balance = (available: boolean, total: string) => vi.fn(async (url: string) =>
    url.includes("deepseek")
      ? Response.json({ is_available: available, balance_infos: [{ currency: "USD", total_balance: total, granted_balance: "0.00", topped_up_balance: total }] })
      : new Response("{}", { status: 200 }));

  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("is quiet with plenty of credit", async () => {
    const fetchImpl = balance(true, "8.40");
    expect(await checkModelBalance("sk-test", { fetchImpl: fetchImpl as unknown as typeof fetch, env: operatorEnv })).toEqual({ state: "ok", usd: 8.4 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("warns the operator when credit is low", async () => {
    const fetchImpl = balance(true, "0.40");
    expect((await checkModelBalance("sk-test", { fetchImpl: fetchImpl as unknown as typeof fetch, env: operatorEnv })).state).toBe("low");
    expect(String(fetchImpl.mock.calls[1][0])).toContain("api.telegram.org");
  });

  it("calls an unavailable account empty", async () => {
    const fetchImpl = balance(false, "0.00");
    expect((await checkModelBalance("sk-test", { fetchImpl: fetchImpl as unknown as typeof fetch, env: operatorEnv })).state).toBe("empty");
  });

  it("reports unknown instead of throwing when the check fails", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    expect(await checkModelBalance("sk-test", { fetchImpl: fetchImpl as unknown as typeof fetch, env: operatorEnv })).toEqual({ state: "unknown", usd: null });
  });
});
