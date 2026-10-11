import { afterEach, describe, expect, it } from "vitest";

import { ALFRED_SUPABASE_HOST, ALFRED_SUPABASE_PROJECT_REF, ALFRED_SUPABASE_USER } from "@/lib/config";
import { getStudioSettings, isStudioEnabled } from "@/lib/env";
import { MemoryFinanceStore } from "@/lib/finance/memory-store";
import type { FinanceAction } from "@/lib/finance/schemas";
import { handleStudioTurn, type StudioDeps } from "@/lib/studio/handle";
import { NOW, expense, settings } from "./helpers";

function studioDeps(interpret: StudioDeps["interpret"], store = new MemoryFinanceStore()): StudioDeps {
  const base = settings({
    google: {
      clientEmail: "studio@example.com",
      privateKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
      spreadsheetId: "abcdefghijklmnopqrst",
    },
    authorizedUserIds: [42, 77],
  });
  let updates = 1_000;
  let actions = 0;
  return {
    settings: {
      deepseek: base.deepseek!,
      google: base.google,
      supabase: {
        projectRef: ALFRED_SUPABASE_PROJECT_REF,
        host: ALFRED_SUPABASE_HOST,
        user: ALFRED_SUPABASE_USER,
        database: "postgres",
        password: "test-password",
      },
      authorizedUserIds: base.authorizedUserIds,
      timezone: base.timezone,
      currency: base.currency,
      confirmTransactions: base.confirmTransactions,
    },
    store,
    interpret,
    now: () => NOW,
    createId: () => "3f2a1c4e-2222-4222-8222-222222222222",
    createActionId: () => `actionid${String(++actions).padStart(4, "0")}`,
    nextUpdateId: () => updates++,
  };
}

const ENV_KEYS = [
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_MODEL",
  "GOOGLE_SERVICE_ACCOUNT_EMAIL",
  "GOOGLE_PRIVATE_KEY",
  "GOOGLE_SHEETS_SPREADSHEET_ID",
  "AUTHORIZED_TELEGRAM_USER_IDS",
  "STUDIO_ENABLED",
  "TELEGRAM_WEBHOOK_SECRET",
  "SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_DB_PASSWORD",
] as const;

describe("studio console", () => {
  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it("loads DeepSeek and the Alfred database without a Telegram webhook secret", () => {
    process.env.DEEPSEEK_API_KEY = "sk-studio-test";
    process.env.DEEPSEEK_MODEL = "deepseek-flash";
    process.env.SUPABASE_URL = "https://jcenaxceqynywmottkxu.supabase.co";
    process.env.SUPABASE_DB_PASSWORD = "test-password";
    process.env.AUTHORIZED_TELEGRAM_USER_IDS = "42,77";
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    const loaded = getStudioSettings();
    expect(loaded.authorizedUserIds).toEqual([42, 77]);
    expect(loaded.deepseek.model).toBe("deepseek-flash");
    expect(loaded.supabase.projectRef).toBe(ALFRED_SUPABASE_PROJECT_REF);
    expect(loaded.supabase.host).toBe(ALFRED_SUPABASE_HOST);
  });

  it("refuses a Supabase URL for a different project", () => {
    process.env.DEEPSEEK_API_KEY = "sk-studio-test";
    process.env.DEEPSEEK_MODEL = "deepseek-flash";
    process.env.SUPABASE_URL = "https://otherexampleproject.supabase.co";
    process.env.SUPABASE_DB_PASSWORD = "test-password";
    process.env.AUTHORIZED_TELEGRAM_USER_IDS = "42";
    expect(() => getStudioSettings()).toThrow(/Alfred project/);
  });

  it("stays disabled unless development mode or STUDIO_ENABLED is set", () => {
    delete process.env.STUDIO_ENABLED;
    expect(isStudioEnabled()).toBe(false);
    process.env.STUDIO_ENABLED = "true";
    expect(isStudioEnabled()).toBe(true);
    delete process.env.STUDIO_ENABLED;
  });

  it("records an explicit expense and answers from that row", async () => {
    const store = new MemoryFinanceStore();
    const deps = studioDeps(async () => {
      const action: FinanceAction = {
        type: "create_transaction",
        explicit: true,
        transactions: [
          {
            transaction_type: "expense",
            amount: "45.00",
            currency: "GHS",
            category: "Food",
            description: "Lunch",
            date: null,
          },
        ],
      };
      return action;
    }, store);

    const recorded = await handleStudioTurn({ userId: 42, text: "I spent GH₵45 on lunch" }, deps);
    expect(recorded.text).toContain("45.00");
    const rows = await store.listTransactions("42");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amount: "45.00", category: "Food", transactionDate: "2026-10-11", status: "active" });

    deps.interpret = async () => ({
      type: "get_spending_summary",
      period: "this_month",
      detail: "total",
    });
    const summary = await handleStudioTurn({ userId: 42, text: "How much have I spent this month?" }, deps);
    expect(summary.text).toContain("45.00");
  });

  it("cancels a deletion without a second write, then confirms it once", async () => {
    const store = new MemoryFinanceStore();
    await store.appendTransaction(expense());
    const deps = studioDeps(async () => ({ type: "delete_transaction", undo_last: true }), store);

    const pending = await handleStudioTurn({ userId: 42, text: "Delete the lunch" }, deps);
    expect(pending.actionId).toBeTruthy();
    expect((await store.listTransactions("42"))[0]?.status).toBe("active");

    const foreign = await handleStudioTurn(
      { userId: 77, decision: "cancel", actionId: pending.actionId! },
      deps,
    );
    expect(foreign.text).toContain("isn't for this chat");
    expect((await store.listTransactions("42"))[0]?.status).toBe("active");

    const cancelled = await handleStudioTurn(
      { userId: 42, decision: "cancel", actionId: pending.actionId! },
      deps,
    );
    expect(cancelled.text).toContain("Cancelled");
    expect(await store.listTransactions("42")).toHaveLength(1);
    expect((await store.listTransactions("42"))[0]?.status).toBe("active");

    const again = await handleStudioTurn({ userId: 42, text: "Delete the lunch" }, deps);
    const confirmed = await handleStudioTurn(
      { userId: 42, decision: "confirm", actionId: again.actionId! },
      deps,
    );
    expect(confirmed.text).toContain("Deleted");
    const after = await store.listTransactions("42");
    expect(after).toHaveLength(1);
    expect(after[0]?.status).toBe("deleted");
  });
});
