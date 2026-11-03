import type { SupabaseSettings } from "@/lib/config";
export { nextOccurrence, upcomingBills } from "@/lib/finance/bill-schedule";
export { detectRenewalCandidates } from "@/lib/finance/bill-renewals";
import { query } from "@/lib/supabase/connection";

export type BillCadence = "once" | "weekly" | "monthly" | "yearly";

export type BillRecord = {
  id: string;
  ownerId: string;
  name: string;
  nextDate: string;
  /** Expected amount in canonical "123.45" format, or null when the amount varies. */
  amount: string | null;
  currency: string;
  cadence: BillCadence;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type NewBill = {
  id?: string;
  name: string;
  nextDate: string;
  amount: string | null;
  currency: string;
  cadence: BillCadence;
  active?: boolean;
};

export type UpcomingBill = BillRecord & { renewalDate: string };

export type RenewalSuggestion = {
  id: string;
  name: string;
  paymentCount: number;
  lastDate: string;
  lastAmount: string;
  currency: string;
  expectedDate: string;
  cadence: BillCadence;
  expectedAmount: string | null;
  variableAmount: boolean;
  basis: string;
};

export interface BillStore {
  list(ownerId: string): Promise<BillRecord[]>;
  save(ownerId: string, bill: NewBill): Promise<BillRecord>;
  setActive(ownerId: string, id: string, active: boolean): Promise<void>;
  remove(ownerId: string, id: string): Promise<void>;
}


type BillRow = {
  id: string;
  owner_id: string;
  name: string;
  next_date: string | Date;
  amount: string | null;
  currency: string;
  cadence: BillCadence;
  active: boolean;
  created_at: Date;
  updated_at: Date;
};

function toYmd(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function fromRow(row: BillRow): BillRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    nextDate: toYmd(row.next_date),
    amount: row.amount == null ? null : Number(row.amount).toFixed(2),
    currency: row.currency,
    cadence: row.cadence,
    active: row.active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function createSupabaseBillStore(settings: SupabaseSettings): BillStore {
  return {
    async list(ownerId) {
      const rows = await query<BillRow>(
        settings,
        `select id::text, owner_id::text, name, next_date::text, amount::text, currency, cadence, active, created_at, updated_at
         from public.bills
         where owner_id = $1::uuid
         order by active desc, next_date asc, name asc`,
        [ownerId],
      ).catch(() => [] as BillRow[]);
      return rows.map(fromRow);
    },
    async save(ownerId, bill) {
      if (bill.id) {
        const rows = await query<BillRow>(
          settings,
          `update public.bills
           set name = $3, next_date = $4::date, amount = $5::numeric, currency = $6, cadence = $7, active = $8, updated_at = now()
           where owner_id = $1::uuid and id = $2::uuid
           returning id::text, owner_id::text, name, next_date::text, amount::text, currency, cadence, active, created_at, updated_at`,
          [ownerId, bill.id, bill.name.trim(), bill.nextDate, bill.amount, bill.currency, bill.cadence, bill.active ?? true],
        );
        if (rows[0]) return fromRow(rows[0]);
      }
      const rows = await query<BillRow>(
        settings,
        `insert into public.bills (owner_id, name, next_date, amount, currency, cadence, active)
         values ($1::uuid, $2, $3::date, $4::numeric, $5, $6, $7)
         returning id::text, owner_id::text, name, next_date::text, amount::text, currency, cadence, active, created_at, updated_at`,
        [ownerId, bill.name.trim(), bill.nextDate, bill.amount, bill.currency, bill.cadence, bill.active ?? true],
      );
      return fromRow(rows[0]!);
    },
    async setActive(ownerId, id, active) {
      await query(settings, "update public.bills set active = $3, updated_at = now() where owner_id = $1::uuid and id = $2::uuid", [
        ownerId,
        id,
        active,
      ]);
    },
    async remove(ownerId, id) {
      await query(settings, "delete from public.bills where owner_id = $1::uuid and id = $2::uuid", [ownerId, id]);
    },
  };
}

export class MemoryBillStore implements BillStore {
  bills: BillRecord[] = [];

  async list(ownerId: string): Promise<BillRecord[]> {
    return this.bills.filter((item) => item.ownerId === ownerId).map((item) => ({ ...item }));
  }
  async save(ownerId: string, bill: NewBill): Promise<BillRecord> {
    const now = new Date().toISOString();
    const existing = bill.id ? this.bills.find((item) => item.ownerId === ownerId && item.id === bill.id) : undefined;
    if (existing) {
      Object.assign(existing, {
        name: bill.name.trim(),
        nextDate: bill.nextDate,
        amount: bill.amount,
        currency: bill.currency,
        cadence: bill.cadence,
        active: bill.active ?? existing.active,
        updatedAt: now,
      });
      return { ...existing };
    }
    const created: BillRecord = {
      id: bill.id ?? `00000000-0000-4000-8000-${String(this.bills.length + 1).padStart(12, "0")}`,
      ownerId,
      name: bill.name.trim(),
      nextDate: bill.nextDate,
      amount: bill.amount,
      currency: bill.currency,
      cadence: bill.cadence,
      active: bill.active ?? true,
      createdAt: now,
      updatedAt: now,
    };
    this.bills.push(created);
    return { ...created };
  }
  async setActive(ownerId: string, id: string, active: boolean): Promise<void> {
    const bill = this.bills.find((item) => item.ownerId === ownerId && item.id === id);
    if (bill) bill.active = active;
  }
  async remove(ownerId: string, id: string): Promise<void> {
    this.bills = this.bills.filter((item) => !(item.ownerId === ownerId && item.id === id));
  }
}
