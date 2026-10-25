import { LIMITS } from "@/lib/config";

export type InlineButton = {
  text: string;
  callbackData: string;
};

export type TelegramSender = {
  /** Buttons in one row, or several rows when given as nested arrays. */
  sendMessage(chatId: number, text: string, buttons?: InlineButton[] | InlineButton[][]): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
  editMessageText(chatId: number, messageId: number, text: string): Promise<void>;
};

type TelegramResponse = {
  ok?: boolean;
  description?: string;
};

function clip(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= 4000) return trimmed;
  return `${trimmed.slice(0, 3950)}\n…`;
}

async function callTelegram(
  token: string,
  method: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(LIMITS.googleTimeoutMs),
    });
  } catch {
    throw new Error(`Telegram ${method} timed out.`);
  }
  let payload: TelegramResponse = {};
  try {
    payload = (await response.json()) as TelegramResponse;
  } catch {
    payload = {};
  }
  if (!response.ok || payload.ok === false) {
    throw new Error(`Telegram ${method} failed with status ${response.status}.`);
  }
}

export function createTelegramClient(
  token: string,
  fetchImpl: typeof fetch = fetch,
): TelegramSender {
  return {
    async sendMessage(chatId, text, buttons) {
      const rows = buttons?.length ? (Array.isArray(buttons[0]) ? (buttons as InlineButton[][]) : [buttons as InlineButton[]]) : [];
      const replyMarkup = rows.length
        ? {
            inline_keyboard: rows.map((row) =>
              row.map((button) => ({
                text: button.text,
                callback_data: button.callbackData,
              })),
            ),
          }
        : undefined;
      await callTelegram(
        token,
        "sendMessage",
        {
          chat_id: chatId,
          text: clip(text),
          link_preview_options: { is_disabled: true },
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        },
        fetchImpl,
      );
    },
    async answerCallbackQuery(callbackQueryId, text) {
      await callTelegram(
        token,
        "answerCallbackQuery",
        {
          callback_query_id: callbackQueryId,
          ...(text ? { text: text.slice(0, 180) } : {}),
        },
        fetchImpl,
      );
    },
    async editMessageText(chatId, messageId, text) {
      await callTelegram(
        token,
        "editMessageText",
        {
          chat_id: chatId,
          message_id: messageId,
          text: clip(text),
          link_preview_options: { is_disabled: true },
          reply_markup: { inline_keyboard: [] },
        },
        fetchImpl,
      );
    },
  };
}

export async function setTelegramWebhook(input: {
  token: string;
  url: string;
  secret: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  await callTelegram(
    input.token,
    "setWebhook",
    {
      url: input.url,
      secret_token: input.secret,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false,
    },
    input.fetchImpl ?? fetch,
  );
}
