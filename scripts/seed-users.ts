import { loadEnvFile } from "node:process";

import { createClient } from "@supabase/supabase-js";

import { getStudioSettings } from "@/lib/env";
import { query } from "@/lib/supabase/connection";

try {
  loadEnvFile();
} catch {
  // .env is loaded when the file exists.
}

const PEOPLE = [
  { name: "Hans", email: "hansopoku360@gmail.com", telegramUserId: 965699706 },
  { name: "Debby", email: "debbykontoh@gmail.com", telegramUserId: 568517419 },
] as const;

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceRole) {
    throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before seeding accounts.");
  }

  const admin = createClient(url, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const db = getStudioSettings().supabase;

  for (const person of PEOPLE) {
    const created = await admin.auth.admin.createUser({
      email: person.email,
      email_confirm: true,
      user_metadata: { preferred_name: person.name },
    });
    let userId = created.data.user?.id;
    if (!userId) {
      const existing = await query<{ id: string }>(db, "select id from auth.users where email = $1", [person.email]);
      userId = existing[0]?.id;
    }
    if (!userId) {
      const detail = created.error?.message ?? "unknown error";
      throw new Error(`Could not create or find ${person.email}: ${detail}`);
    }

    await query(
      db,
      `insert into public.profiles (id, preferred_name, currency, timezone)
       values ($1, $2, 'GHS', 'Africa/Accra')
       on conflict (id) do update
       set preferred_name = excluded.preferred_name, updated_at = now()`,
      [userId, person.name],
    );
    await query(
      db,
      `insert into public.telegram_accounts (owner_id, telegram_user_id)
       values ($1, $2)
       on conflict (owner_id) do update
       set telegram_user_id = case
             when public.telegram_accounts.locked_at is null then excluded.telegram_user_id
             else public.telegram_accounts.telegram_user_id
           end,
           updated_at = now()`,
      [userId, person.telegramUserId],
    );
    await query(db, `insert into public.conversations (owner_id) values ($1) on conflict (owner_id) do nothing`, [userId]);
    await query(
      db,
      `insert into public.reminder_preferences (owner_id) values ($1) on conflict (owner_id) do nothing`,
      [userId],
    );
    for (const table of ["transactions", "budgets", "savings_goals", "processed_updates", "pending_actions"]) {
      await query(
        db,
        `update public.${table}
         set owner_id = $1::uuid
         where user_id = $2 and owner_id is null`,
        [userId, String(person.telegramUserId)],
      );
    }
    console.log(`ready ${person.name} ${person.email}`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Seed failed.";
  console.error(message);
  process.exitCode = 1;
});
