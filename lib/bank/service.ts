import { createSupabaseAccountDirectory } from "@/lib/accounts/supabase-directory";
import { createSupabaseMessageLog } from "@/lib/accounts/supabase-messages";
import { ingestBankText, type IngestOutcome } from "@/lib/bank/ingest";
import { announceOutcomes } from "@/lib/bank/notify";
import { createSupabaseBankStore, hashIngestToken, type BankMessage } from "@/lib/bank/store";
import type { SupabaseSettings, UserProfile } from "@/lib/config";
import { newTransactionId } from "@/lib/finance/ids";
import { createSupabaseFinanceStore } from "@/lib/supabase/finance-store";
import { query } from "@/lib/supabase/connection";
import { createTelegramClient } from "@/lib/telegram/client";

/** The person a forwarding secret belongs to, if it's valid. */
export async function ownerForToken(settings: SupabaseSettings, token: string): Promise<UserProfile | null> {
  if (!/^alf_[A-Za-z0-9_-]{20,64}$/.test(token.trim())) return null;
  const rows = await query<{ owner_id: string }>(
    settings,
    "update public.ingest_tokens set last_used_at = now() where token_hash = $1 returning owner_id::text",
    [hashIngestToken(token)],
  );
  const ownerId = rows[0]?.owner_id;
  return ownerId ? createSupabaseAccountDirectory(settings).loadOwner(ownerId) : null;
}

/**
 * Reads bank text for one person, files what it can, and tells them on
 * Telegram about the rest. Shared by the Shortcut endpoint and screenshots.
 */
export async function ingestAndAnnounce(
  settings: SupabaseSettings,
  profile: UserProfile,
  text: string,
  options: { channel: BankMessage["channel"]; sender?: string | null; receivedAt?: Date; announce?: boolean },
): Promise<{ outcomes: IngestOutcome[]; duplicates: number; found: number }> {
  const now = new Date();
  const bank = createSupabaseBankStore(settings);
  const result = await ingestBankText(
    { bank, ledger: createSupabaseFinanceStore(settings), now, createId: newTransactionId },
    profile,
    text,
    options,
  );
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (options.announce !== false && result.outcomes.length > 0 && token) {
    await announceOutcomes(
      { settings, bank, telegram: createTelegramClient(token), messages: createSupabaseMessageLog(settings), profile, now },
      result.outcomes,
    );
  }
  return result;
}
