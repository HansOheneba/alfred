import { payeeKey } from "@/lib/bank/parse";
import type { SupabaseSettings } from "@/lib/config";
import { query } from "@/lib/supabase/connection";

/** One movement of lent money: lending it out, or getting some back. */
export type LoanEntry = {
  id: string;
  person: string;
  personKey: string;
  kind: "lent" | "repaid";
  amount: string;
  currency: string;
  occurredAt: string;
  note: string;
  bankMessageId: string | null;
};

export type NewLoanEntry = Omit<LoanEntry, "id" | "personKey">;

/** What one person still owes, from everything lent to them and paid back. */
export type LoanBalance = { person: string; personKey: string; lent: string; repaid: string; owed: string; currency: string; since: string };

export interface LoanStore {
  add(ownerId: string, entry: NewLoanEntry): Promise<LoanEntry>;
  remove(ownerId: string, id: string): Promise<void>;
  list(ownerId: string): Promise<LoanEntry[]>;
}

export function personKey(name: string): string {
  return payeeKey(name);
}

const cents = (value: string) => Math.round(Number(value) * 100);
const money = (value: number) => (value / 100).toFixed(2);

/** Everyone who has borrowed from the person, with what they still owe, largest first. */
export function loanBalances(entries: LoanEntry[]): LoanBalance[] {
  const people = new Map<string, { person: string; lent: number; repaid: number; currency: string; since: string }>();
  for (const entry of [...entries].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))) {
    const current = people.get(entry.personKey) ?? { person: entry.person, lent: 0, repaid: 0, currency: entry.currency, since: entry.occurredAt };
    if (entry.kind === "lent") current.lent += cents(entry.amount);
    else current.repaid += cents(entry.amount);
    // The fullest version of a name wins, so "Deborah Ama Konadu" beats "Deborah".
    if (entry.person.length > current.person.length) current.person = entry.person;
    people.set(entry.personKey, current);
  }
  return [...people.entries()]
    .map(([key, item]) => ({
      person: item.person,
      personKey: key,
      lent: money(item.lent),
      repaid: money(item.repaid),
      owed: money(Math.max(0, item.lent - item.repaid)),
      currency: item.currency,
      since: item.since,
    }))
    .sort((left, right) => cents(right.owed) - cents(left.owed));
}

/**
 * Finds the person a name refers to among those Alfred already knows:
 * the same name, the same first name, or a nickname sharing its first three
 * letters (Debby for Deborah). Returns null unless exactly one person fits.
 */
export function findPerson<T extends { personKey: string }>(people: T[], name: string): T | null {
  const key = personKey(name);
  if (!key) return null;
  const exact = people.find((item) => item.personKey === key);
  if (exact) return exact;
  const first = key.split(" ")[0];
  const byFirst = people.filter((item) => item.personKey.split(" ")[0] === first);
  if (byFirst.length === 1) return byFirst[0];
  if (first.length < 3) return null;
  const byStart = people.filter((item) => item.personKey.split(" ")[0].slice(0, 3) === first.slice(0, 3));
  return byStart.length === 1 ? byStart[0] : null;
}

/** What a sender or recipient still owes, or null when they owe nothing. */
export async function owedBy(loans: LoanStore, ownerId: string, name: string): Promise<LoanBalance | null> {
  if (!name.trim()) return null;
  const match = findPerson(loanBalances(await loans.list(ownerId)), name);
  return match && Number(match.owed) > 0 ? match : null;
}

type LoanRow = {
  id: string;
  person: string;
  person_key: string;
  kind: LoanEntry["kind"];
  amount: string;
  currency: string;
  occurred_at: Date;
  note: string;
  bank_message_id: string | null;
};

function fromRow(row: LoanRow): LoanEntry {
  return {
    id: row.id,
    person: row.person,
    personKey: row.person_key,
    kind: row.kind,
    amount: Number(row.amount).toFixed(2),
    currency: row.currency,
    occurredAt: row.occurred_at.toISOString(),
    note: row.note,
    bankMessageId: row.bank_message_id,
  };
}

const columns = "id, person, person_key, kind, amount::text, currency, occurred_at, note, bank_message_id::text";

export function createSupabaseLoanStore(settings: SupabaseSettings): LoanStore {
  return {
    async add(ownerId, entry) {
      const rows = await query<LoanRow>(
        settings,
        `insert into public.loans (owner_id, person, person_key, kind, amount, currency, occurred_at, note, bank_message_id)
         values ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::uuid) returning ${columns}`,
        [ownerId, entry.person.slice(0, 120), personKey(entry.person), entry.kind, entry.amount, entry.currency, entry.occurredAt, entry.note.slice(0, 200), entry.bankMessageId],
      );
      return fromRow(rows[0]);
    },
    async remove(ownerId, id) {
      await query(settings, "delete from public.loans where owner_id = $1::uuid and id = $2::uuid", [ownerId, id]);
    },
    async list(ownerId) {
      const rows = await query<LoanRow>(settings, `select ${columns} from public.loans where owner_id = $1::uuid order by occurred_at`, [ownerId]);
      return rows.map(fromRow);
    },
  };
}

/** In-memory store for tests. */
export class MemoryLoanStore implements LoanStore {
  entries: (LoanEntry & { ownerId: string })[] = [];

  async add(ownerId: string, entry: NewLoanEntry) {
    const stored = { ...entry, ownerId, id: `00000000-0000-4000-8000-${String(this.entries.length + 1).padStart(12, "0")}`, personKey: personKey(entry.person) };
    this.entries.push(stored);
    return { ...stored };
  }
  async remove(ownerId: string, id: string) {
    this.entries = this.entries.filter((item) => !(item.ownerId === ownerId && item.id === id));
  }
  async list(ownerId: string) {
    return this.entries.filter((item) => item.ownerId === ownerId).map((item) => ({ ...item }));
  }
}
