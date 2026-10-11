import { describe, expect, it } from "vitest";

import { parseModelOutput } from "@/lib/finance/schemas";
import { normalizeCategory } from "@/lib/finance/categories";
import { rangeForPeriod, zonedYmd } from "@/lib/finance/dates";
import { canonicalizeAmount, formatMinor } from "@/lib/finance/money";
import { authorizeUser } from "@/lib/security/authorization";
import { parseCallbackData, telegramUpdateSchema } from "@/lib/telegram/schemas";
import { verifyWebhookSecret } from "@/lib/telegram/verify";
import { settings } from "./helpers";

describe("telegram updates", () => {
  it("accepts a text message and a callback query", () => {
    expect(
      telegramUpdateSchema.safeParse({
        update_id: 10,
        message: { message_id: 1, chat: { id: 5, type: "private" }, from: { id: 42 }, text: "lunch" },
      }).success,
    ).toBe(true);
    const callback = telegramUpdateSchema.parse({
      update_id: 11,
      callback_query: {
        id: "cb",
        from: { id: 42 },
        data: "c:actionid1234",
        message: { message_id: 3, chat: { id: 5, type: "private" } },
      },
    });
    expect(callback.callback_query?.from.id).toBe(42);
  });

  it("rejects a payload without an update id", () => {
    expect(telegramUpdateSchema.safeParse({ message: { text: "hi" } }).success).toBe(false);
  });

  it("parses confirmation callbacks and ignores malformed button data", () => {
    expect(parseCallbackData("c:actionid1234")).toEqual({ decision: "confirm", actionId: "actionid1234" });
    expect(parseCallbackData("x:actionid1234")?.decision).toBe("cancel");
    expect(parseCallbackData("confirm:all")).toBeNull();
  });
});

describe("webhook secret", () => {
  it("accepts only the exact secret", () => {
    expect(verifyWebhookSecret("test-webhook-secret", "test-webhook-secret")).toBe(true);
    expect(verifyWebhookSecret("test-webhook-secreT", "test-webhook-secret")).toBe(false);
    expect(verifyWebhookSecret("short", "test-webhook-secret")).toBe(false);
    expect(verifyWebhookSecret(null, "test-webhook-secret")).toBe(false);
    expect(verifyWebhookSecret("test-webhook-secret", "")).toBe(false);
  });
});

describe("authorization", () => {
  it("uses the numeric Telegram id and the configured spreadsheet", () => {
    const config = settings({
      authorizedUserIds: [42],
      google: {
        clientEmail: "bot@example.iam.gserviceaccount.com",
        privateKey: "key",
        spreadsheetId: "sheet-configured-on-the-server-001",
      },
    });
    expect(authorizeUser(42, config)?.spreadsheetId).toBe("sheet-configured-on-the-server-001");
    expect(authorizeUser(7, config)).toBeNull();
    expect(authorizeUser(42.5, config)).toBeNull();
  });
});

describe("amounts and currency", () => {
  it("canonicalizes finite positive amounts with at most two decimals", () => {
    expect(canonicalizeAmount(45)).toBe("45.00");
    expect(canonicalizeAmount("GH₵1,200.50")).toBe("1200.50");
    expect(canonicalizeAmount("45.555")).toBeNull();
    expect(canonicalizeAmount(-5)).toBeNull();
    expect(canonicalizeAmount(Number.POSITIVE_INFINITY)).toBeNull();
    expect(canonicalizeAmount(0)).toBeNull();
    expect(canonicalizeAmount(0, { allowZero: true })).toBe("0.00");
  });

  it("formats Ghanaian cedi amounts", () => {
    expect(formatMinor(4500, "GHS")).toBe("GH₵45.00");
    expect(formatMinor(120000, "GHS")).toBe("GH₵1,200.00");
  });
});

describe("dates", () => {
  it("starts weeks on Monday in the configured timezone", () => {
    const today = zonedYmd(new Date("2026-10-11T15:00:00.000Z"), "Africa/Accra");
    expect(today).toBe("2026-10-11");
    expect(rangeForPeriod("this_week", today)).toEqual({ start: "2026-10-05", end: "2026-10-11" });
    expect(rangeForPeriod("this_month", today).start).toBe("2026-10-01");
    expect(rangeForPeriod("last_month", today)).toEqual({ start: "2026-09-01", end: "2026-09-30" });
    expect(zonedYmd(new Date("2026-10-11T03:00:00.000Z"), "America/New_York")).toBe("2026-10-10");
  });
});

describe("categories", () => {
  it("maps obvious expenses and does not invent categories", () => {
    expect(normalizeCategory("lunch", "expense")).toBe("Food");
    expect(normalizeCategory("trotro", "expense")).toBe("Transport");
    expect(normalizeCategory("spaceship", "expense")).toBeNull();
    expect(normalizeCategory("Food", "income")).toBeNull();
    expect(normalizeCategory("salary", "income")).toBe("Salary");
  });
});

describe("model output", () => {
  it("accepts a transaction proposal and rejects unknown actions", () => {
    const parsed = parseModelOutput({
      type: "create_transaction",
      explicit: true,
      transactions: [
        {
          transaction_type: "expense",
          amount: 45,
          currency: "ghs",
          category: "Food",
          description: "Lunch",
          date: null,
        },
      ],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.type === "create_transaction" && parsed.data.transactions[0].amount).toBe("45.00");
    expect(parseModelOutput({ type: "drop_table", query: "transactions" }).success).toBe(false);
    expect(parseModelOutput("not json").success).toBe(false);
    expect(parseModelOutput({ amount: -10, type: "create_transaction", transactions: [] }).success).toBe(false);
  });
});
