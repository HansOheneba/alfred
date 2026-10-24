import { cacheLife } from "next/cache";

/**
 * The bot's @username for "Open on Telegram" links, or null when unknown.
 * The token stays on the server; only the username is returned.
 */
export async function telegramBotUsername(): Promise<string | null> {
  const configured = process.env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "");
  if (configured) return configured;
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return null;
  return fetchBotUsername(token);
}

async function fetchBotUsername(token: string): Promise<string | null> {
  "use cache";
  cacheLife("days");
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return null;
    const json = (await response.json()) as { ok?: boolean; result?: { username?: unknown } };
    const username = json.ok && typeof json.result?.username === "string" ? json.result.username : null;
    return username && /^[A-Za-z0-9_]{5,64}$/.test(username) ? username : null;
  } catch {
    return null;
  }
}
