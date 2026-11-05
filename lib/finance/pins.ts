import { z } from "zod";

import type { SupabaseSettings } from "@/lib/config";
import { RELATIVE_PERIODS } from "@/lib/finance/dates";
import type { ChartQuery } from "@/lib/finance/charts";
import { query } from "@/lib/supabase/connection";

/**
 * Charts kept on the Overview. Only the chart's description is stored; its
 * numbers are worked out from the books each time the Overview loads.
 */

export type PinnedChart = { id: string; ownerId: string; title: string; query: ChartQuery; createdAt: string };

export const MAX_PINS = 8;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** A chart description as the app sends it back: the same fields the chat chart carries, nothing else. */
export const chartQuerySchema = z.strictObject({
  measure: z.enum(["spending", "income", "net"]),
  by: z.enum(["category", "merchant", "day", "week", "month"]),
  style: z.enum(["bar", "line", "donut", "table"]).nullable().optional(),
  compare: z.boolean().nullable().optional(),
  category: z.string().trim().min(1).max(40).nullable().optional(),
  period: z.enum(RELATIVE_PERIODS).nullable().optional(),
  month: z.number().int().min(1).max(12).nullable().optional(),
  year: z.number().int().min(2000).max(2100).nullable().optional(),
  startDate: isoDate.nullable().optional(),
  endDate: isoDate.nullable().optional(),
});

export type PinStore = {
  list(ownerId: string): Promise<PinnedChart[]>;
  /** Keeps a chart; the same chart twice is kept once. Null when the Overview is full. */
  add(ownerId: string, title: string, chart: ChartQuery): Promise<PinnedChart | null>;
  remove(ownerId: string, id: string): Promise<boolean>;
};

export class MemoryPinStore implements PinStore {
  pins: PinnedChart[] = [];
  private sequence = 0;
  async list(ownerId: string) { return this.pins.filter((pin) => pin.ownerId === ownerId); }
  async add(ownerId: string, title: string, chart: ChartQuery) {
    const same = this.pins.find((pin) => pin.ownerId === ownerId && JSON.stringify(pin.query) === JSON.stringify(chart));
    if (same) return same;
    if ((await this.list(ownerId)).length >= MAX_PINS) return null;
    const pin = { id: `00000000-0000-4000-8000-${String(++this.sequence).padStart(12, "0")}`, ownerId, title, query: chart, createdAt: new Date().toISOString() };
    this.pins.push(pin);
    return pin;
  }
  async remove(ownerId: string, id: string) {
    const before = this.pins.length;
    this.pins = this.pins.filter((pin) => !(pin.ownerId === ownerId && pin.id === id));
    return this.pins.length < before;
  }
}

type PinRow = { id: string; owner_id: string; title: string; query: ChartQuery; created_at: Date };
const fromRow = (row: PinRow): PinnedChart => ({ id: row.id, ownerId: row.owner_id, title: row.title, query: row.query, createdAt: row.created_at.toISOString() });

export function createSupabasePinStore(settings: SupabaseSettings): PinStore {
  // The Overview keeps working before the additive migration is applied.
  const ready = async () => (await query<{ ready: boolean }>(settings, "select to_regclass('public.pinned_charts') is not null as ready"))[0]?.ready === true;
  return {
    async list(ownerId) {
      if (!await ready()) return [];
      return (await query<PinRow>(settings, "select id::text, owner_id::text, title, query, created_at from public.pinned_charts where owner_id=$1::uuid order by created_at, id", [ownerId])).map(fromRow);
    },
    async add(ownerId, title, chart) {
      if (!await ready()) throw new Error("Pinned charts aren't available yet.");
      // One statement: the cap and the duplicate check can't race a second tap.
      const rows = await query<PinRow>(settings, `
        with existing as (
          select id, owner_id, title, query, created_at from public.pinned_charts where owner_id=$1::uuid and md5(query::text)=md5($3::jsonb::text)
        ), inserted as (
          insert into public.pinned_charts (owner_id, title, query)
          select $1::uuid, $2, $3::jsonb
          where not exists (select 1 from existing) and (select count(*) from public.pinned_charts where owner_id=$1::uuid) < $4
          on conflict do nothing
          returning id, owner_id, title, query, created_at
        )
        select id::text, owner_id::text, title, query, created_at from existing
        union all select id::text, owner_id::text, title, query, created_at from inserted`, [ownerId, title, JSON.stringify(chart), MAX_PINS]);
      return rows[0] ? fromRow(rows[0]) : null;
    },
    async remove(ownerId, id) {
      if (!await ready()) return false;
      return (await query<{ id: string }>(settings, "delete from public.pinned_charts where owner_id=$1::uuid and id=$2::uuid returning id::text", [ownerId, id])).length > 0;
    },
  };
}
