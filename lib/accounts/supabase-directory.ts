import type { SupabaseSettings } from "@/lib/config";
import type { UserProfile } from "@/lib/config";
import { DatabaseError } from "@/lib/errors";
import { profileFromLink, type AccountDirectory, type TelegramIdUpdate, type TelegramLink } from "@/lib/accounts/directory";
import { query } from "@/lib/supabase/connection";

type AccountRow = {
  id: string;
  preferred_name: string;
  currency: string;
  timezone: string;
  communication_preference: TelegramLink["communicationPreference"];
  telegram_user_id: string | null;
  chat_id: string | null;
  locked_at: Date | null;
};

function linkFrom(row: AccountRow): TelegramLink {
  return {
    ownerId: row.id,
    telegramUserId: row.telegram_user_id == null ? null : Number(row.telegram_user_id),
    chatId: row.chat_id == null ? null : Number(row.chat_id),
    lockedAt: row.locked_at ? row.locked_at.toISOString() : null,
    preferredName: row.preferred_name,
    currency: row.currency,
    timezone: row.timezone,
    communicationPreference: row.communication_preference,
  };
}

const accountSql = `
  select p.id, p.preferred_name, p.currency, p.timezone, p.communication_preference,
         t.telegram_user_id::text, t.chat_id::text, t.locked_at
  from public.profiles p
  join public.telegram_accounts t on t.owner_id = p.id
`;

export function createSupabaseAccountDirectory(settings: SupabaseSettings): AccountDirectory & {
  loadOwner(ownerId: string): Promise<UserProfile | null>;
  updateTelegramId(ownerId: string, telegramUserId: number): Promise<TelegramIdUpdate>;
} {
  return {
    async resolveTelegram(telegramUserId) {
      if (!Number.isSafeInteger(telegramUserId) || telegramUserId <= 0) return null;
      const rows = await query<AccountRow>(settings, `${accountSql} where t.telegram_user_id = $1`, [telegramUserId]);
      const row = rows[0];
      return row ? profileFromLink(linkFrom(row)) : null;
    },
    async lockTelegram(telegramUserId, chatId, now) {
      await query(
        settings,
        `update public.telegram_accounts
         set locked_at = $3, chat_id = $2, updated_at = $3
         where telegram_user_id = $1 and locked_at is null`,
        [telegramUserId, chatId, now.toISOString()],
      );
    },
    async loadOwner(ownerId) {
      const rows = await query<AccountRow>(settings, `${accountSql} where p.id = $1`, [ownerId]);
      const row = rows[0];
      return row ? profileFromLink(linkFrom(row)) : null;
    },
    async updateTelegramId(ownerId, telegramUserId) {
      if (!Number.isSafeInteger(telegramUserId) || telegramUserId <= 0) return "invalid";
      const current = await query<{ locked_at: Date | null }>(
        settings,
        "select locked_at from public.telegram_accounts where owner_id = $1",
        [ownerId],
      );
      if (!current[0]) return "missing";
      if (current[0].locked_at) return "locked";
      try {
        const updated = await query<{ owner_id: string }>(
          settings,
          `update public.telegram_accounts
           set telegram_user_id = $2, updated_at = now()
           where owner_id = $1 and locked_at is null
           returning owner_id`,
          [ownerId, telegramUserId],
        );
        return updated[0] ? "updated" : "locked";
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (/telegram id is locked/i.test(message)) return "locked";
        if (/duplicate key|unique/i.test(message)) return "taken";
        throw new DatabaseError("The Telegram ID could not be saved.");
      }
    },
  };
}
