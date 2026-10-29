import { titleCase } from "@/lib/bank/ingest";
import type { StudioSettings, UserProfile } from "@/lib/config";
import { createSupabasePeopleStore } from "@/lib/people/store";
import { query } from "@/lib/supabase/connection";

/** Someone Alfred knows: what the person said about them, and how their payments get filed. */
export type KnownPerson = {
  personKey: string;
  name: string;
  note: string;
  /** "Food · Office snacks", or "their share of Utilities"; empty when Alfred hasn't learned one. */
  filing: string;
};

export async function loadPeople(profile: UserProfile, settings: StudioSettings): Promise<KnownPerson[]> {
  const [notes, rules] = await Promise.all([
    createSupabasePeopleStore(settings.supabase).list(profile.profileId),
    query<{ payee_key: string; category: string; description: string; kind: "category" | "chip_in" }>(
      settings.supabase,
      "select payee_key, category, description, kind from public.payee_rules where owner_id = $1::uuid order by updated_at desc limit 200",
      [profile.profileId],
    ),
  ]);
  const people = new Map<string, KnownPerson>();
  for (const note of notes) people.set(note.personKey, { personKey: note.personKey, name: note.name, note: note.note, filing: "" });
  for (const rule of rules) {
    const filing = rule.kind === "chip_in" ? `their share of ${rule.category}` : `${rule.category}${rule.description ? ` · ${rule.description}` : ""}`;
    const known = people.get(rule.payee_key);
    if (known) known.filing = filing;
    else people.set(rule.payee_key, { personKey: rule.payee_key, name: titleCase(rule.payee_key), note: "", filing });
  }
  return [...people.values()].sort((left, right) => Number(Boolean(right.note)) - Number(Boolean(left.note)) || left.name.localeCompare(right.name));
}
