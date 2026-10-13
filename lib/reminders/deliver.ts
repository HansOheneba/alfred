import type { SupabaseSettings } from "@/lib/config";
import { zonedYmd } from "@/lib/finance/dates";
import { logError } from "@/lib/log";
import { dueReminders, reminderText, type ReminderCandidate, type ReminderKind } from "@/lib/reminders/due";
import { query } from "@/lib/supabase/connection";

type ReminderRow = {
  owner_id: string;
  preferred_name: string;
  timezone: string;
  chat_id: string | null;
  morning_enabled: boolean;
  commute_enabled: boolean;
  evening_enabled: boolean;
  morning_minute: number;
  commute_minute: number;
  evening_minute: number;
};

export async function deliverDueReminders(input: {
  settings: SupabaseSettings;
  now: Date;
  send: (chatId: number, text: string) => Promise<void>;
}): Promise<{ sent: number }> {
  const rows = await query<ReminderRow>(
    input.settings,
    `select p.id as owner_id, p.preferred_name, p.timezone, t.chat_id::text,
            r.morning_enabled, r.commute_enabled, r.evening_enabled,
            r.morning_minute, r.commute_minute, r.evening_minute
     from public.reminder_preferences r
     join public.profiles p on p.id = r.owner_id
     join public.telegram_accounts t on t.owner_id = p.id
     where t.locked_at is not null and t.chat_id is not null`,
  );
  const candidates: ReminderCandidate[] = [];
  const names = new Map<string, string>();
  for (const row of rows) {
    names.set(row.owner_id, row.preferred_name);
    const localDate = zonedYmd(input.now, row.timezone);
    const [sent, expenses] = await Promise.all([
      query<{ kind: ReminderKind }>(
        input.settings,
        "select kind from public.reminder_deliveries where owner_id = $1 and local_date = $2",
        [row.owner_id, localDate],
      ),
      query<{ present: boolean }>(
        input.settings,
        `select exists (
           select 1 from public.transactions
           where owner_id = $1 and status = 'active' and type = 'expense' and transaction_date = $2
         ) as present`,
        [row.owner_id, localDate],
      ),
    ]);
    candidates.push({
      ownerId: row.owner_id,
      timezone: row.timezone,
      chatId: row.chat_id == null ? null : Number(row.chat_id),
      morningEnabled: row.morning_enabled,
      commuteEnabled: row.commute_enabled,
      eveningEnabled: row.evening_enabled,
      morningMinute: row.morning_minute,
      commuteMinute: row.commute_minute,
      eveningMinute: row.evening_minute,
      expenseRecordedToday: Boolean(expenses[0]?.present),
      alreadySent: sent.map((item) => item.kind),
    });
  }

  let sentCount = 0;
  for (const item of dueReminders(candidates, input.now)) {
    const claimed = await query<{ id: string }>(
      input.settings,
      `insert into public.reminder_deliveries (owner_id, kind, local_date)
       values ($1, $2, $3)
       on conflict (owner_id, kind, local_date) do nothing
       returning id`,
      [item.ownerId, item.kind, item.localDate],
    );
    if (!claimed[0]) continue;
    try {
      await input.send(item.chatId, reminderText(item.kind, names.get(item.ownerId) ?? ""));
      sentCount += 1;
    } catch (error) {
      logError("reminder_send", error);
      await query(input.settings, "delete from public.reminder_deliveries where id = $1", [claimed[0].id]);
    }
  }
  return { sent: sentCount };
}
