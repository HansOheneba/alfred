import { createSupabaseAccountDirectory } from "@/lib/accounts/supabase-directory";
import { createSupabaseMessageLog } from "@/lib/accounts/supabase-messages";
import { ingestBankText, type IngestOutcome } from "@/lib/bank/ingest";
import { announceOutcomes } from "@/lib/bank/notify";
import { createUnknownTextReader } from "@/lib/bank/read-unknown";
import { createSupabaseInvestmentStore } from "@/lib/investments/store";
import { createSupabaseBankStore, hashIngestToken, type BankMessage } from "@/lib/bank/store";
import type { SupabaseSettings, UserProfile } from "@/lib/config";
import { newTransactionId } from "@/lib/finance/ids";
import { createSupabasePeopleStore } from "@/lib/people/store";
import { createSupabaseLoanStore } from "@/lib/finance/loans";
import { createSupabaseFinanceStore } from "@/lib/supabase/finance-store";
import { query } from "@/lib/supabase/connection";
import { createTelegramClient } from "@/lib/telegram/client";
import { getStudioSettings } from "@/lib/env";

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

/** Reads bank text for one person and files what it can. Announcing is separate: see announceWhenQuiet. */
export async function ingestBankMessages(
  settings: SupabaseSettings,
  profile: UserProfile,
  text: string,
  options: { channel: BankMessage["channel"]; sender?: string | null; receivedAt?: Date },
): Promise<{ outcomes: IngestOutcome[]; duplicates: number; found: number }> {
  return ingestBankText(
    {
      bank: createSupabaseBankStore(settings),
      ledger: createSupabaseFinanceStore(settings),
      loans: createSupabaseLoanStore(settings),
      investments: createSupabaseInvestmentStore(settings),
      now: new Date(),
      createId: newTransactionId,
      readUnknown: unknownReader(),
    },
    profile,
    text,
    options,
  );
}

/** The model reader for unfamiliar banks, or null when DeepSeek isn't configured. */
function unknownReader() {
  try {
    return createUnknownTextReader(getStudioSettings().deepseek);
  } catch {
    return null;
  }
}

/** How long a burst of forwarded texts must go quiet before Alfred sums it up. */
export const ANNOUNCE_QUIET_MS = 6_000;

function outcomeOf(message: BankMessage, filed: Map<string, { category: string; chipIn: boolean }>, invested: Map<string, string>): IngestOutcome {
  const settled = ["needs_label", "recorded", "matched", "transfer", "loan", "skipped", "invested"] as const;
  const outcome = settled.find((status) => status === message.status) ?? "recorded";
  const transaction = message.transactionId ? filed.get(message.transactionId) : undefined;
  return {
    message,
    outcome,
    category: message.status === "invested" ? invested.get(message.id) ?? "an investment" : transaction?.category,
    chipIn: transaction?.chipIn,
    feeRecorded: Boolean(message.feeTransactionId),
  };
}

/**
 * Waits for forwarded texts to stop arriving, then tells the person about all
 * of them in one Telegram message. Every request schedules this; only the one
 * that finds the burst finished claims and announces it.
 */
export async function announceWhenQuiet(
  settings: SupabaseSettings,
  profile: UserProfile,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
  await wait(ANNOUNCE_QUIET_MS + 500);
  const bank = createSupabaseBankStore(settings);
  const claimed = await bank.claimUnannounced(profile.profileId, ANNOUNCE_QUIET_MS);
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (claimed.length === 0 || !token) return;
  const ids = claimed.map((item) => item.transactionId).filter((id): id is string => Boolean(id));
  const rows = ids.length
    ? await query<{ transaction_id: string; category: string; chip_in: boolean }>(
        settings,
        "select transaction_id::text, category, amount < 0 as chip_in from public.transactions where owner_id = $1::uuid and transaction_id::text = any($2::text[])",
        [profile.profileId, ids],
      )
    : [];
  const filed = new Map(rows.map((row) => [row.transaction_id, { category: row.category, chipIn: row.chip_in }]));
  // Which investment each payment went into, by the bank message it came from.
  const investedIds = claimed.filter((item) => item.status === "invested").map((item) => item.id);
  const investedRows = investedIds.length
    ? await query<{ bank_message_id: string; name: string }>(
        settings,
        `select c.bank_message_id::text, i.name from public.investment_contributions c join public.investments i on i.id = c.investment_id
         where c.owner_id = $1::uuid and c.bank_message_id::text = any($2::text[])`,
        [profile.profileId, investedIds],
      )
    : [];
  const invested = new Map(investedRows.map((row) => [row.bank_message_id, row.name]));
  await announceOutcomes(
    {
      settings,
      bank,
      loans: createSupabaseLoanStore(settings),
      people: createSupabasePeopleStore(settings),
      telegram: createTelegramClient(token),
      messages: createSupabaseMessageLog(settings),
      profile,
      now: new Date(),
    },
    claimed.map((message) => outcomeOf(message, filed, invested)),
  );
}
