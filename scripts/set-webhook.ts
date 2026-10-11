import { loadEnvFile } from "node:process";

import { getSettings } from "@/lib/env";
import { setTelegramWebhook } from "@/lib/telegram/client";

try {
  loadEnvFile();
} catch {
  // The webhook URL is passed as an argument. Secrets stay in the environment.
}

async function main(): Promise<void> {
  const url = process.argv[2]?.trim();
  if (!url || !url.startsWith("https://") || !url.endsWith("/api/telegram/webhook")) {
    throw new Error("Usage: npm run setup:webhook -- https://<domain>/api/telegram/webhook");
  }
  const settings = getSettings();
  await setTelegramWebhook({
    token: settings.telegramBotToken,
    url,
    secret: settings.webhookSecret,
  });
  console.log(`Webhook registered for ${url}`);
  console.log("Allowed updates: message, callback_query");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Webhook setup failed.";
  console.error(message);
  process.exitCode = 1;
});
