import type { SupabaseSettings } from "@/lib/config";
import type { CommunicationPreference } from "@/lib/config";
import { DatabaseError } from "@/lib/errors";
import { createSupabaseAccountDirectory } from "@/lib/accounts/supabase-directory";
import { parseTelegramUserId } from "@/lib/accounts/directory";
import { findInvite } from "@/lib/auth/invites";
import { query } from "@/lib/supabase/connection";

export type AccountSettings = {
  preferredName: string;
  currency: string;
  timezone: string;
  communicationPreference: CommunicationPreference;
  financialGoals: string;
  telegramUserId: string;
  telegramLocked: boolean;
  morningEnabled: boolean;
  commuteEnabled: boolean;
  eveningEnabled: boolean;
  morningTime: string;
  commuteTime: string;
  eveningTime: string;
};

type SettingsRow = {
  preferred_name: string;
  currency: string;
  timezone: string;
  communication_preference: CommunicationPreference;
  financial_goals: string;
  telegram_user_id: string | null;
  locked_at: Date | null;
  morning_enabled: boolean;
  commute_enabled: boolean;
  evening_enabled: boolean;
  morning_minute: number;
  commute_minute: number;
  evening_minute: number;
};

export function formatMinute(minute: number): string {
  const hour = Math.floor(minute / 60);
  const rest = minute % 60;
  return `${String(hour).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

export function parseMinute(value: string): number | null {
  const match = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/**
 * Makes sure a signed-in person has an account. A new account needs an invite
 * (see lib/auth/invites.ts); its Telegram ID, if the invite has one, is linked
 * straight away. If another account already holds that ID it stays there.
 */
export async function openAccount(
  settings: SupabaseSettings,
  user: { id: string; email?: string | null },
): Promise<"ready" | "not_invited"> {
  const existing = await query<{ id: string }>(settings, "select id from public.profiles where id = $1", [user.id]);
  if (existing.length > 0) {
    await ensureAccount(settings, user.id);
    return "ready";
  }
  const invite = findInvite(user.email);
  if (!invite) return "not_invited";
  await ensureAccount(settings, user.id);
  if (invite.telegramUserId) await createSupabaseAccountDirectory(settings).updateTelegramId(user.id, invite.telegramUserId);
  return "ready";
}

export async function ensureAccount(settings: SupabaseSettings, ownerId: string): Promise<void> {
  await query(
    settings,
    `insert into public.profiles (id) values ($1) on conflict (id) do nothing`,
    [ownerId],
  );
  await query(
    settings,
    `insert into public.telegram_accounts (owner_id) values ($1) on conflict (owner_id) do nothing`,
    [ownerId],
  );
  await query(
    settings,
    `insert into public.conversations (owner_id) values ($1) on conflict (owner_id) do nothing`,
    [ownerId],
  );
  await query(
    settings,
    `insert into public.reminder_preferences (owner_id) values ($1) on conflict (owner_id) do nothing`,
    [ownerId],
  );
}

export async function loadAccountSettings(settings: SupabaseSettings, ownerId: string): Promise<AccountSettings> {
  await ensureAccount(settings, ownerId);
  const rows = await query<SettingsRow>(
    settings,
    `select p.preferred_name, p.currency, p.timezone, p.communication_preference, p.financial_goals,
            t.telegram_user_id::text, t.locked_at,
            r.morning_enabled, r.commute_enabled, r.evening_enabled,
            r.morning_minute, r.commute_minute, r.evening_minute
     from public.profiles p
     join public.telegram_accounts t on t.owner_id = p.id
     join public.reminder_preferences r on r.owner_id = p.id
     where p.id = $1`,
    [ownerId],
  );
  const row = rows[0];
  if (!row) throw new DatabaseError("The account profile is missing.");
  return {
    preferredName: row.preferred_name,
    currency: row.currency,
    timezone: row.timezone,
    communicationPreference: row.communication_preference,
    financialGoals: row.financial_goals,
    telegramUserId: row.telegram_user_id ?? "",
    telegramLocked: row.locked_at != null,
    morningEnabled: row.morning_enabled,
    commuteEnabled: row.commute_enabled,
    eveningEnabled: row.evening_enabled,
    morningTime: formatMinute(row.morning_minute),
    commuteTime: formatMinute(row.commute_minute),
    eveningTime: formatMinute(row.evening_minute),
  };
}

export async function saveAccountSettings(
  settings: SupabaseSettings,
  ownerId: string,
  next: AccountSettings,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const morning = parseMinute(next.morningTime);
  const commute = parseMinute(next.commuteTime);
  const evening = parseMinute(next.eveningTime);
  if (morning == null || commute == null || evening == null) {
    return { ok: false, message: "Reminder times must use HH:MM." };
  }
  const current = await loadAccountSettings(settings, ownerId);
  const submitted = next.telegramUserId.trim();
  if (current.telegramLocked && submitted !== current.telegramUserId) {
    return { ok: false, message: "Your Telegram ID is locked because Alfred has already received a message from it." };
  }
  if (!current.telegramLocked && submitted) {
    const telegramUserId = parseTelegramUserId(submitted);
    if (telegramUserId == null) return { ok: false, message: "Enter the numeric Telegram user ID." };
    if (String(telegramUserId) !== current.telegramUserId) {
      const result = await createSupabaseAccountDirectory(settings).updateTelegramId(ownerId, telegramUserId);
      if (result === "taken") return { ok: false, message: "That Telegram ID is already saved on another account." };
      if (result === "locked") {
        return { ok: false, message: "Your Telegram ID is locked because Alfred has already received a message from it." };
      }
      if (result !== "updated") return { ok: false, message: "The Telegram ID could not be saved." };
    }
  }
  if (!current.telegramLocked && !submitted && current.telegramUserId) {
    const cleared = await query(
      settings,
      `update public.telegram_accounts
       set telegram_user_id = null, updated_at = now()
       where owner_id = $1 and locked_at is null
       returning owner_id`,
      [ownerId],
    );
    if (!cleared[0]) {
      return { ok: false, message: "Your Telegram ID is locked because Alfred has already received a message from it." };
    }
  }
  await query(
    settings,
    `update public.profiles
     set preferred_name = $2, currency = $3, timezone = $4, communication_preference = $5,
         financial_goals = $6, updated_at = now()
     where id = $1`,
    [ownerId, next.preferredName.trim(), next.currency, next.timezone, next.communicationPreference, next.financialGoals.trim()],
  );
  await query(
    settings,
    `update public.reminder_preferences
     set morning_enabled = $2, commute_enabled = $3, evening_enabled = $4,
         morning_minute = $5, commute_minute = $6, evening_minute = $7, updated_at = now()
     where owner_id = $1`,
    [ownerId, next.morningEnabled, next.commuteEnabled, next.eveningEnabled, morning, commute, evening],
  );
  return { ok: true };
}
