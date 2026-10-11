import { loadEnvFile } from "node:process";

import { getSettings } from "@/lib/env";

try {
  loadEnvFile();
} catch {
  // getUpdates only works before a webhook is registered.
}

type Update = {
  message?: { from?: { id?: number; first_name?: string }; chat?: { type?: string } };
  callback_query?: { from?: { id?: number; first_name?: string } };
};

async function main(): Promise<void> {
  const settings = getSettings();
  const response = await fetch(`https://api.telegram.org/bot${settings.telegramBotToken}/getUpdates`);
  const body = (await response.json()) as { ok?: boolean; result?: Update[]; description?: string };
  if (!response.ok || !body.ok) {
    console.error("Could not read recent chats. Delete the webhook first if one is already set.");
    process.exitCode = 1;
    return;
  }
  const seen = new Set<string>();
  for (const update of body.result ?? []) {
    const from = update.message?.from ?? update.callback_query?.from;
    if (!from?.id) continue;
    const key = String(from.id);
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`${from.id}\t${from.first_name ?? ""}\t${update.message?.chat?.type ?? "callback"}`);
  }
  if (seen.size === 0) {
    console.log("No recent users. Send /id to the bot before registering the webhook.");
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Could not list Telegram user ids.";
  console.error(message);
  process.exitCode = 1;
});
