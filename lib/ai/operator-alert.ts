import { logError, logInfo } from "@/lib/log";

/**
 * Tells whoever runs Alfred that the model provider has cut it off, on
 * Telegram, so an empty account doesn't go unnoticed for hours. Optional:
 * without ALFRED_OPERATOR_TELEGRAM_ID it only logs. Never throws, and sends
 * each kind of alert at most once an hour per server instance, since every
 * failed chat turn would otherwise send one.
 */
export async function alertOperator(
  event: string,
  text: string,
  options: { env?: Record<string, string | undefined>; fetchImpl?: typeof fetch; now?: number } = {},
): Promise<boolean> {
  const env = options.env ?? process.env;
  const chatId = Number(env.ALFRED_OPERATOR_TELEGRAM_ID?.trim());
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!Number.isSafeInteger(chatId) || chatId === 0 || !token) return false;
  const now = options.now ?? Date.now();
  const last = lastSent.get(event);
  if (last !== undefined && now - last < ALERT_EVERY_MS) return false;
  lastSent.set(event, now);
  try {
    const response = await (options.fetchImpl ?? fetch)(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: `Alfred alert: ${text}` }),
      signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Telegram sendMessage failed with status ${response.status}.`);
    logInfo("operator_alert_sent", { event });
    return true;
  } catch (error) {
    lastSent.delete(event);
    logError("operator_alert_failed", error);
    return false;
  }
}

/** Forgets which alerts were sent, for tests. */
export function resetOperatorAlerts(): void {
  lastSent.clear();
}

const lastSent = new Map<string, number>();
const ALERT_EVERY_MS = 60 * 60_000;
/** Short, because a chat turn is waiting on it. */
const ALERT_TIMEOUT_MS = 3000;
