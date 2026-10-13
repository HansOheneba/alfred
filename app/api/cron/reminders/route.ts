import { getSettings } from "@/lib/env";
import { logError } from "@/lib/log";
import { deliverDueReminders } from "@/lib/reminders/deliver";
import { createTelegramClient } from "@/lib/telegram/client";

export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ ok: false }, { status: 401 });
  }
  try {
    const settings = getSettings();
    if (!settings.supabase) return Response.json({ ok: false }, { status: 500 });
    const telegram = createTelegramClient(settings.telegramBotToken);
    const result = await deliverDueReminders({
      settings: settings.supabase,
      now: new Date(),
      send: (chatId, text) => telegram.sendMessage(chatId, text),
    });
    return Response.json({ ok: true, sent: result.sent });
  } catch (error) {
    logError("reminders", error);
    return Response.json({ ok: false }, { status: 500 });
  }
}
