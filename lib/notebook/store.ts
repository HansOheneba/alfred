import type { SupabaseSettings } from "@/lib/config";
import { query } from "@/lib/supabase/connection";

/**
 * Something Alfred has learnt about the person, in their words. With an
 * `account`, texts from that account aren't their money and are ignored.
 */
export type AboutNote = { id: string; note: string; account: string | null; createdAt: string };

export interface NotebookStore {
  list(ownerId: string): Promise<AboutNote[]>;
  /** Saves a note; a note for an account already noted replaces the old one. */
  add(ownerId: string, note: { note: string; account?: string | null }): Promise<AboutNote>;
  remove(ownerId: string, id: string): Promise<void>;
}

/** How many notes about the person Alfred keeps in mind on each turn. */
const MAX_IN_PROMPT = 30;

/** The person's notebook as lines for the model, in their own words. */
export async function aboutForPrompt(notebook: NotebookStore | null | undefined, ownerId: string): Promise<string[]> {
  if (!notebook) return [];
  return (await notebook.list(ownerId)).slice(-MAX_IN_PROMPT).map(aboutLine);
}

export function aboutLine(item: AboutNote): string {
  return item.account ? `${item.note.replace(/[.\s]+$/, "")}. (Texts from the account ending ${item.account} are ignored.)` : item.note;
}

type Row = { id: string; note: string; account: string | null; created_at: Date };
const fromRow = (row: Row): AboutNote => ({ id: row.id, note: row.note, account: row.account, createdAt: row.created_at.toISOString() });

export function createSupabaseNotebookStore(settings: SupabaseSettings): NotebookStore {
  return {
    async list(ownerId) {
      const rows = await query<Row>(settings, "select id::text, note, account, created_at from public.about_me where owner_id = $1::uuid order by created_at limit 200", [ownerId]);
      return rows.map(fromRow);
    },
    async add(ownerId, item) {
      const values = [ownerId, item.note.trim().slice(0, 300), item.account ?? null];
      const rows = item.account
        ? await query<Row>(
            settings,
            `insert into public.about_me (owner_id, note, account) values ($1::uuid, $2, $3)
             on conflict (owner_id, account) where account is not null do update set note = excluded.note
             returning id::text, note, account, created_at`,
            values,
          )
        : await query<Row>(settings, "insert into public.about_me (owner_id, note, account) values ($1::uuid, $2, $3) returning id::text, note, account, created_at", values);
      return fromRow(rows[0]);
    },
    async remove(ownerId, id) {
      await query(settings, "delete from public.about_me where owner_id = $1::uuid and id = $2::uuid", [ownerId, id]);
    },
  };
}

/** In-memory store for tests. */
export class MemoryNotebookStore implements NotebookStore {
  notes: AboutNote[] = [];

  async list() {
    return this.notes.map((item) => ({ ...item }));
  }
  async add(_ownerId: string, item: { note: string; account?: string | null }) {
    const account = item.account ?? null;
    const saved = { id: `00000000-0000-4000-8000-${String(this.notes.length + 1).padStart(12, "0")}`, note: item.note.trim(), account, createdAt: new Date(0).toISOString() };
    this.notes = [...this.notes.filter((note) => !account || note.account !== account), saved];
    return { ...saved };
  }
  async remove(_ownerId: string, id: string) {
    this.notes = this.notes.filter((item) => item.id !== id);
  }
}
