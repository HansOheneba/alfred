import { AuthError } from "@/lib/errors";
import { billRecordSchema } from "@/lib/finance/bill-management-schema";
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

export type ConfirmedBillOperation =
  | { kind: "create"; bill: BillRecord }
  | { kind: "update"; before: BillRecord; after: BillRecord }
  | { kind: "delete"; before: BillRecord };
export type BillWriteResult = "applied" | "already_applied" | "stale" | "missing";

export interface BillStore {
  list(ownerId: string): Promise<BillRecord[]>;
  /** Strict reads are required for chat: an unavailable store must never look like an empty list. */
  strictList?(ownerId: string): Promise<BillRecord[]>;
  /** Owner-scoped atomic compare-and-write for reviewed conversational changes. */
  applyConfirmed?(ownerId: string, operation: ConfirmedBillOperation): Promise<BillWriteResult>;
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
  created_at: Date | string;
  updated_at: Date | string;
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
    createdAt: typeof row.created_at === "string" ? row.created_at : row.created_at.toISOString(),
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : row.updated_at.toISOString(),
  };
}

const SELECT_BILL = `id::text, owner_id::text, name, next_date::text, amount::text, currency, cadence, active,
  to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
  to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at`;

/** Normalize formatting while retaining PostgreSQL's microsecond version precision. */
function timestampKey(value: string): string {
  const fraction = value.match(/\.(\d+)(?:Z|[+-])/i)?.[1] ?? "";
  return `${new Date(value).toISOString().slice(0,19)}.${fraction.padEnd(6,"0")}Z`;
}

function sameBill(left: BillRecord, right: BillRecord): boolean {
  return left.id === right.id && left.ownerId === right.ownerId && left.name === right.name
    && left.nextDate === right.nextDate && left.amount === right.amount && left.currency === right.currency
    && left.cadence === right.cadence && left.active === right.active
    && timestampKey(left.createdAt) === timestampKey(right.createdAt) && timestampKey(left.updatedAt) === timestampKey(right.updatedAt);
}

function validOperation(ownerId: string, operation: ConfirmedBillOperation): boolean {
  const records = operation.kind === "create" ? [operation.bill] : operation.kind === "update" ? [operation.before, operation.after] : [operation.before];
  return records.every(record => billRecordSchema.safeParse(record).success && record.ownerId === ownerId)
    && (operation.kind !== "update" || operation.before.id === operation.after.id && operation.before.createdAt === operation.after.createdAt);
}

export function createSupabaseBillStore(settings: SupabaseSettings): BillStore {
  const strictList = async (ownerId: string) => (await query<BillRow>(settings,
    `select ${SELECT_BILL} from public.bills where owner_id=$1::uuid order by active desc,next_date asc,name asc`, [ownerId])).map(fromRow);
  return {
    // Existing screens retain their previous graceful fallback; chat explicitly uses strictList.
    async list(ownerId) { return strictList(ownerId).catch(() => []); },
    strictList,
    async applyConfirmed(ownerId, operation) {
      if (!validOperation(ownerId, operation)) return "missing";
      if (operation.kind === "create") {
        const bill = operation.bill;
        const rows = await query<BillRow>(settings,
          `insert into public.bills (id,owner_id,name,next_date,amount,currency,cadence,active,created_at,updated_at)
           values ($1::uuid,$2::uuid,$3,$4::date,$5::numeric,$6,$7,$8,$9::timestamptz,$10::timestamptz)
           on conflict (id) do nothing returning ${SELECT_BILL}`,
          [bill.id,ownerId,bill.name,bill.nextDate,bill.amount,bill.currency,bill.cadence,bill.active,bill.createdAt,bill.updatedAt]);
        if (rows[0]) return "applied";
        const current = (await query<BillRow>(settings, `select ${SELECT_BILL} from public.bills where owner_id=$1::uuid and id=$2::uuid`, [ownerId,bill.id]))[0];
        return current ? sameBill(fromRow(current),bill) ? "already_applied" : "stale" : "missing";
      }
      const before = operation.before;
      const expected = [ownerId,before.id,before.name,before.nextDate,before.amount,before.currency,before.cadence,before.active,before.createdAt,before.updatedAt];
      const predicate = `owner_id=$1::uuid and id=$2::uuid and name=$3 and next_date=$4::date
        and amount is not distinct from $5::numeric and currency=$6 and cadence=$7 and active=$8
        and created_at=$9::timestamptz and updated_at=$10::timestamptz`;
      if (operation.kind === "delete") {
        const rows = await query<BillRow>(settings, `delete from public.bills where ${predicate} returning ${SELECT_BILL}`, expected);
        if (rows[0]) return "applied";
      } else {
        const after = operation.after;
        const rows = await query<BillRow>(settings,
          `update public.bills set name=$11,next_date=$12::date,amount=$13::numeric,currency=$14,cadence=$15,active=$16,updated_at=$17::timestamptz
           where ${predicate} returning ${SELECT_BILL}`,
          [...expected,after.name,after.nextDate,after.amount,after.currency,after.cadence,after.active,after.updatedAt]);
        if (rows[0]) return "applied";
      }
      const current = (await query<BillRow>(settings, `select ${SELECT_BILL} from public.bills where owner_id=$1::uuid and id=$2::uuid`, [ownerId,before.id]))[0];
      if (!current) return "missing";
      return operation.kind === "update" && sameBill(fromRow(current),operation.after) ? "already_applied" : "stale";
    },
    async save(ownerId, bill) {
      if (bill.id) {
        const rows = await query<BillRow>(
          settings,
          `update public.bills
           set name = $3, next_date = $4::date, amount = $5::numeric, currency = $6, cadence = $7, active = $8, updated_at = now()
           where owner_id = $1::uuid and id = $2::uuid
           returning ${SELECT_BILL}`,
          [ownerId, bill.id, bill.name.trim(), bill.nextDate, bill.amount, bill.currency, bill.cadence, bill.active ?? true],
        );
        if (rows[0]) return fromRow(rows[0]);
        throw new AuthError("That bill is no longer available.");
      }
      const rows = await query<BillRow>(
        settings,
        `insert into public.bills (owner_id, name, next_date, amount, currency, cadence, active)
         values ($1::uuid, $2, $3::date, $4::numeric, $5, $6, $7)
         returning ${SELECT_BILL}`,
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
  async strictList(ownerId: string): Promise<BillRecord[]> { return this.list(ownerId); }
  async applyConfirmed(ownerId: string, operation: ConfirmedBillOperation): Promise<BillWriteResult> {
    if (!validOperation(ownerId, operation)) return "missing";
    const target = operation.kind === "create" ? operation.bill : operation.before;
    const index = this.bills.findIndex(item => item.ownerId === ownerId && item.id === target.id);
    const existing = this.bills[index];
    if (operation.kind === "create") {
      if (existing) return sameBill(existing,operation.bill) ? "already_applied" : "stale";
      if (this.bills.some(item => item.id === target.id)) return "missing";
      this.bills.push({ ...operation.bill });
      return "applied";
    }
    if (!existing) return "missing";
    if (operation.kind === "update" && sameBill(existing,operation.after)) return "already_applied";
    if (!sameBill(existing,operation.before)) return "stale";
    if (operation.kind === "delete") this.bills.splice(index,1);
    else this.bills[index] = { ...operation.after };
    return "applied";
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
    if (bill.id) throw new AuthError("That bill is no longer available.");
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
    if (bill) { bill.active = active; bill.updatedAt = new Date().toISOString(); }
  }
  async remove(ownerId: string, id: string): Promise<void> {
    this.bills = this.bills.filter((item) => !(item.ownerId === ownerId && item.id === id));
  }
}
