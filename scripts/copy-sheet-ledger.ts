import { loadEnvFile } from "node:process";

import { getStudioSettings } from "@/lib/env";
import { createSheetsFinanceStore } from "@/lib/google/finance-store";
import { query } from "@/lib/supabase/connection";

try {
  loadEnvFile();
} catch {
  // .env is loaded when the file exists.
}

async function main(): Promise<void> {
  const settings = getStudioSettings();
  if (!settings.google) {
    throw new Error("Google Sheets is not configured, so existing rows cannot be copied.");
  }
  const sheets = createSheetsFinanceStore(settings.google);
  let copied = 0;
  for (const userId of settings.authorizedUserIds) {
    const rows = await sheets.listTransactions(String(userId));
    for (const row of rows) {
      const inserted = await query<{ transaction_id: string }>(
        settings.supabase,
        `insert into public.transactions (
           transaction_id, created_at, transaction_date, user_id, type, amount, currency, category,
           description, payment_method, notes, status, updated_at, source_update_id
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         on conflict (transaction_id) do nothing
         returning transaction_id`,
        [
          row.transactionId,
          row.createdAt,
          row.transactionDate,
          row.userId,
          row.type,
          row.amount,
          row.currency,
          row.category,
          row.description,
          row.paymentMethod,
          row.notes,
          row.status,
          row.updatedAt,
          row.sourceUpdateId,
        ],
      );
      copied += inserted.length;
    }
  }
  console.log(`copied ${copied} transaction rows into ${settings.supabase.projectRef}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Copy failed.";
  console.error(message);
  process.exitCode = 1;
});
