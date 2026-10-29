import { learnable, titleCase } from "@/lib/bank/ingest";
import { payeeKey } from "@/lib/bank/parse";
import { classifyPayee } from "@/lib/bank/payees";
import type { BankStore } from "@/lib/bank/store";
import type { SupabaseSettings } from "@/lib/config";
import { query } from "@/lib/supabase/connection";

/** Something the person told Alfred about someone they send money to or get it from. */
export type PersonNote = { personKey: string; name: string; note: string; updatedAt: string };

export interface PeopleStore {
  list(ownerId: string): Promise<PersonNote[]>;
  save(ownerId: string, person: { name: string; note: string }): Promise<PersonNote>;
  remove(ownerId: string, personKey: string): Promise<void>;
}

/** How many notes Alfred keeps in mind on each turn. */
export const MAX_NOTES_IN_PROMPT = 40;

export function noteLine(person: PersonNote): string {
  return `${person.name}: ${person.note}`;
}

export function createSupabasePeopleStore(settings: SupabaseSettings): PeopleStore {
  return {
    async list(ownerId) {
      const rows = await query<{ person_key: string; name: string; note: string; updated_at: Date }>(
        settings,
        "select person_key, name, note, updated_at from public.people where owner_id = $1::uuid order by updated_at desc limit 200",
        [ownerId],
      );
      return rows.map((row) => ({ personKey: row.person_key, name: row.name, note: row.note, updatedAt: row.updated_at.toISOString() }));
    },
    async save(ownerId, person) {
      const rows = await query<{ person_key: string; name: string; note: string; updated_at: Date }>(
        settings,
        `insert into public.people (owner_id, person_key, name, note) values ($1::uuid, $2, $3, $4)
         on conflict (owner_id, person_key) do update set name = excluded.name, note = excluded.note, updated_at = now()
         returning person_key, name, note, updated_at`,
        [ownerId, payeeKey(person.name), person.name.trim().slice(0, 120), person.note.trim().slice(0, 300)],
      );
      return { personKey: rows[0].person_key, name: rows[0].name, note: rows[0].note, updatedAt: rows[0].updated_at.toISOString() };
    },
    async remove(ownerId, personKey) {
      await query(settings, "delete from public.people where owner_id = $1::uuid and person_key = $2", [ownerId, personKey]);
    },
  };
}

/** In-memory store for tests. */
export class MemoryPeopleStore implements PeopleStore {
  people = new Map<string, PersonNote>();

  async list() {
    return [...this.people.values()];
  }
  async save(_ownerId: string, person: { name: string; note: string }) {
    const saved = { personKey: payeeKey(person.name), name: person.name.trim(), note: person.note.trim(), updatedAt: new Date(0).toISOString() };
    this.people.set(saved.personKey, saved);
    return { ...saved };
  }
  async remove(_ownerId: string, personKey: string) {
    this.people.delete(personKey);
  }
}

/** Everyone named in the person's bank texts, by their full name. */
export async function payeeNamesFrom(bank: BankStore, ownerId: string): Promise<string[]> {
  const names = new Map<string, string>();
  for (const message of await bank.listMessages(ownerId)) {
    if (!learnable(message.counterparty) || classifyPayee(message.counterparty).kind !== "person") continue;
    names.set(payeeKey(message.counterparty), titleCase(message.counterparty));
  }
  return [...names.values()];
}

/** The notes as lines for the model, most recently changed first. */
export async function notesForPrompt(people: PeopleStore | null | undefined, ownerId: string): Promise<string[]> {
  return people ? (await people.list(ownerId)).slice(0, MAX_NOTES_IN_PROMPT).map(noteLine) : [];
}
