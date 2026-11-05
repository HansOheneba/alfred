import type { SupabaseSettings } from "@/lib/config";
import { DatabaseError } from "@/lib/errors";
import type { PaydaySetting } from "@/lib/finance/payday";
import { query } from "@/lib/supabase/connection";

/** Where the payday a person confirmed or set is kept. Server-only. */
export interface PaydayStore {
  get(ownerId: string): Promise<PaydaySetting | null>;
  set(ownerId: string, setting: PaydaySetting): Promise<void>;
}

export class MemoryPaydayStore implements PaydayStore {
  settings = new Map<string, PaydaySetting>();
  async get(ownerId: string) { return this.settings.get(ownerId) ?? null; }
  async set(ownerId: string, setting: PaydaySetting) { this.settings.set(ownerId, { ...setting }); }
}

export function createSupabasePaydayStore(settings: SupabaseSettings): PaydayStore {
  return {
    async get(ownerId) {
      // One query on the Overview's critical path: a missing table means nothing confirmed yet, not an error.
      try {
        const rows = await query<{ day: number | null; regular: boolean }>(settings, "select day, regular from public.paydays where owner_id = $1::uuid", [ownerId]);
        return rows[0] ? { day: rows[0].day, regular: rows[0].regular } : null;
      } catch (error) {
        const state = error instanceof DatabaseError ? error.sqlState : (error as { code?: unknown } | null)?.code;
        if (state === "42P01") return null;
        throw error;
      }
    },
    async set(ownerId, setting) {
      await query(settings, `insert into public.paydays(owner_id, day, regular) values ($1::uuid, $2, $3)
        on conflict(owner_id) do update set day = excluded.day, regular = excluded.regular, updated_at = now()`, [ownerId, setting.regular ? setting.day : null, setting.regular]);
    },
  };
}
