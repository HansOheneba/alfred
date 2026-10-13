import { MemoryAccountDirectory } from "@/lib/accounts/directory";
import type { AppSettings, UserProfile } from "@/lib/config";
import { MemoryFinanceStore } from "@/lib/finance/memory-store";
import type { NewTransaction } from "@/lib/finance/store";
import { SlidingWindowRateLimiter } from "@/lib/security/rate-limit";
import { handleTelegramUpdate, type HandlerDeps } from "@/lib/telegram/handle-update";
import type { InlineButton, TelegramSender } from "@/lib/telegram/client";
import type { TelegramUpdate } from "@/lib/telegram/schemas";

export const NOW = new Date("2026-10-11T15:00:00.000Z");

export function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    telegramBotToken: "123456:telegram-test-token",
    webhookSecret: "test-webhook-secret",
    deepseek: { apiKey: "sk-test-key", model: "deepseek-flash" },
    google: null,
    supabase: null,
    authorizedUserIds: [42],
    timezone: "Africa/Accra",
    currency: "GHS",
    confirmTransactions: "auto",
    ...overrides,
  };
}

export function profile(id = 42, overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    profileId: String(id),
    telegramUserId: id,
    spreadsheetId: "sheet-configured-on-the-server-001",
    currency: "GHS",
    timezone: "Africa/Accra",
    preferredName: "",
    communicationPreference: "concise",
    ...overrides,
  };
}

export function expense(overrides: Partial<NewTransaction> = {}): NewTransaction {
  return {
    transactionId: "3f2a1c4e-1111-4111-8111-111111111111",
    createdAt: "2026-10-11T12:00:00.000Z",
    transactionDate: "2026-10-11",
    userId: "42",
    type: "expense",
    amount: "45.00",
    currency: "GHS",
    category: "Food",
    description: "Lunch",
    paymentMethod: "",
    notes: "",
    status: "active",
    updatedAt: "2026-10-11T12:00:00.000Z",
    sourceUpdateId: "update:1:0",
    ...overrides,
  };
}

export function fakeTelegram(): {
  sent: { chatId: number; text: string; buttons?: InlineButton[] }[];
  answers: { id: string; text?: string }[];
  edits: { chatId: number; messageId: number; text: string }[];
  client: TelegramSender;
} {
  const sent: { chatId: number; text: string; buttons?: InlineButton[] }[] = [];
  const answers: { id: string; text?: string }[] = [];
  const edits: { chatId: number; messageId: number; text: string }[] = [];
  return {
    sent,
    answers,
    edits,
    client: {
      async sendMessage(chatId, text, buttons) {
        sent.push({ chatId, text, buttons });
      },
      async answerCallbackQuery(id, text) {
        answers.push({ id, text });
      },
      async editMessageText(chatId, messageId, text) {
        edits.push({ chatId, messageId, text });
      },
    },
  };
}

export function textUpdate(updateId: number, userId: number, text: string, chatId = 100): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: chatId, type: "private" },
      from: { id: userId, username: "not-used-for-auth" },
      text,
    },
  };
}

export function harness(overrides: Partial<HandlerDeps> = {}): {
  deps: HandlerDeps;
  store: MemoryFinanceStore;
  telegram: ReturnType<typeof fakeTelegram>;
  interpret: { calls: number };
} {
  const store = new MemoryFinanceStore();
  const telegram = fakeTelegram();
  const interpret = { calls: 0 };
  let sequence = 1;
  const deps: HandlerDeps = {
    settings: settings(),
    store,
    telegram: telegram.client,
    interpret: async () => {
      interpret.calls += 1;
      return { type: "help" };
    },
    now: () => NOW,
    rateLimiter: new SlidingWindowRateLimiter(20, 60_000),
    accounts: MemoryAccountDirectory.fromIds(overrides.settings?.authorizedUserIds ?? [42], {
      currency: "GHS",
      timezone: "Africa/Accra",
      communicationPreference: "concise",
    }),
    createId: () => `3f2a1c4e-1111-4111-8111-${String(sequence++).padStart(12, "0")}`,
    createActionId: () => "actionid1234",
    ...overrides,
  };
  if (overrides.store) return { deps, store: overrides.store as MemoryFinanceStore, telegram, interpret };
  return { deps, store, telegram, interpret };
}

export async function runUpdate(update: TelegramUpdate, deps: HandlerDeps) {
  return handleTelegramUpdate(update, deps);
}
