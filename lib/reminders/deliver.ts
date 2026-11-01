import type { SupabaseSettings } from "@/lib/config";
import { nextOccurrence, type BillCadence } from "@/lib/finance/bills";
import { addDays, formatDisplayDate, zonedYmd } from "@/lib/finance/dates";
import { formatAmount } from "@/lib/finance/money";
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
  const billReminders = await deliverBillRenewalReminders(input).catch((error) => {
    logError("bill_reminder_send", error);
    return 0;
  });
  return { sent: sentCount + billReminders };
}

type BillDueRow = {
  id: string;
  owner_id: string;
  name: string;
  next_date: string | Date;
  amount: string | null;
  currency: string;
  cadence: BillCadence;
  active: boolean;
  reminded_for: string | Date | null;
  preferred_name: string;
  timezone: string;
  chat_id: string;
};

async function deliverBillRenewalReminders(input: {
  settings: SupabaseSettings;
  now: Date;
  send: (chatId: number, text: string) => Promise<void>;
}): Promise<number> {
  const rows = await query<BillDueRow>(
    input.settings,
    `select b.id::text, b.owner_id::text, b.name, b.next_date::text, b.amount::text, b.currency, b.cadence, b.active, b.reminded_for::text,
            p.preferred_name, p.timezone, t.chat_id::text
     from public.bills b
     join public.profiles p on p.id = b.owner_id
     join public.telegram_accounts t on t.owner_id = p.id
     where b.active = true and t.locked_at is not null and t.chat_id is not null`,
  ).catch(() => [] as BillDueRow[]);

  let sent = 0;
  for (const row of rows) {
    const today = zonedYmd(input.now, row.timezone);
    const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: row.timezone }).format(input.now));
    if (hour < 9 || hour >= 20) continue;
    const tomorrow = addDays(today, 1);
    const nextDate = typeof row.next_date === "string" ? row.next_date.slice(0, 10) : row.next_date.toISOString().slice(0, 10);
    const renewal = nextOccurrence({ active: row.active, nextDate, cadence: row.cadence }, today);
    if (renewal !== tomorrow) continue;
    const reminded = row.reminded_for
      ? typeof row.reminded_for === "string"
        ? row.reminded_for.slice(0, 10)
        : row.reminded_for.toISOString().slice(0, 10)
      : null;
    if (reminded === renewal) continue;

    const claimed = await query<{ id: string }>(
      input.settings,
      `update public.bills set reminded_for = $2::date, updated_at = now()
       where id = $1::uuid and (reminded_for is distinct from $2::date)
       returning id::text`,
      [row.id, renewal],
    );
    if (!claimed[0]) continue;
    const hello = row.preferred_name.trim() ? `${row.preferred_name.trim()}, ` : "";
    const money = row.amount ? ` (${formatAmount(Number(row.amount).toFixed(2), row.currency)})` : "";
    try {
      await input.send(Number(row.chat_id), `${hello}heads up: ${row.name}${money} is due tomorrow (${formatDisplayDate(renewal)}).`);
      sent += 1;
    } catch (error) {
      logError("bill_reminder_telegram", error);
      await query(input.settings, "update public.bills set reminded_for = null where id = $1::uuid", [row.id]);
    }
  }
  return sent;
}
