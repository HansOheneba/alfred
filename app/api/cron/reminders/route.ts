import { createSupabaseAccountDirectory } from "@/lib/accounts/supabase-directory";
import { createSupabaseMessageLog } from "@/lib/accounts/supabase-messages";
import { askHeldQuestions } from "@/lib/bank/notify";
import { createSupabaseLoanStore } from "@/lib/finance/loans";
import { createSupabaseBankStore } from "@/lib/bank/store";
import type { SupabaseSettings, UserProfile } from "@/lib/config";
import { getSettings } from "@/lib/env";
import { query } from "@/lib/supabase/connection";
import { logError } from "@/lib/log";
import { deliverDueReminders } from "@/lib/reminders/deliver";
import { createTelegramClient, type TelegramSender } from "@/lib/telegram/client";

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
    const asked = await askHeldBankQuestions(settings.supabase, telegram).catch((error) => {
      logError("bank_questions", error);
      return 0;
    });
    return Response.json({ ok: true, sent: result.sent, asked });
  } catch (error) {
    logError("reminders", error);
    return Response.json({ ok: false }, { status: 500 });
  }
}

/** Asks about bank payments that arrived during quiet hours or were never asked about. */
async function askHeldBankQuestions(settings: SupabaseSettings, telegram: TelegramSender): Promise<number> {
  const owners = await query<{ owner_id: string }>(
    settings,
    "select distinct owner_id::text from public.bank_messages where status = 'needs_label' and asked_at is null",
  );
  const directory = createSupabaseAccountDirectory(settings);
  const profiles = (await Promise.all(owners.map((row) => directory.loadOwner(row.owner_id)))).filter(
    (profile): profile is UserProfile => profile != null,
  );
  return askHeldQuestions(
    { settings, bank: createSupabaseBankStore(settings), loans: createSupabaseLoanStore(settings), telegram, messages: createSupabaseMessageLog(settings), now: new Date() },
    profiles,
  );
}
