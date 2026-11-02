import type { ImportArchive } from "./model";
import type { NativeRestoreSource } from "./native-restoration";

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Exact source claims only: amounts, dates and people names never deduplicate separate loans. */
export function nativeLoanOverlapConflicts(archive: ImportArchive, nativeSources?: NativeRestoreSource[]): string[] {
  const native = archive.datasets["alfred.native"];
  const sources = nativeSources ?? (object(native) && object(native.tables) ? [{ namespace: archive.manifest.namespace, native: { schema: 1 as const, tables: native.tables as Record<string, Record<string, unknown>[]> } }] : []);
  const movements = new Map((Array.isArray(archive.datasets.movements) ? archive.datasets.movements : []).filter(object).map((row) => [row.id, row]));
  const reservedSources = new Set<string>();
  for (const link of Array.isArray(archive.datasets.settlements) ? archive.datasets.settlements : []) {
    if (!object(link)) continue;
    for (const reference of [link.original, ...(Array.isArray(link.returns) ? link.returns : [])]) {
      if (!object(reference)) continue;
      const movement = movements.get(reference.movementId);
      if (!movement) continue;
      const origin = object(movement.importProvenance) ? movement.importProvenance : {};
      const namespace = typeof origin.namespace === "string" ? origin.namespace : archive.manifest.namespace;
      if (movement.sourceKind === "bank" && typeof movement.sourceId === "string") reservedSources.add(JSON.stringify([namespace, movement.sourceId]));
      if (typeof origin.namespace === "string" && typeof origin.sourceId === "string" && origin.sourceId.startsWith("bank:")) reservedSources.add(JSON.stringify([origin.namespace, origin.sourceId.slice(5)]));
    }
  }
  const overlaps = new Set<string>();
  for (const source of sources) for (const row of source.native.tables.loans ?? []) {
    if (!object(row) || typeof row.bank_message_id !== "string") continue;
    const origin = object(row.importProvenance) ? row.importProvenance : {};
    const namespace = typeof origin.namespace === "string" ? origin.namespace : source.namespace;
    if (reservedSources.has(JSON.stringify([namespace, row.bank_message_id]))) overlaps.add(JSON.stringify([namespace, row.id]));
  }
  return overlaps.size ? [`${overlaps.size} native loan record(s) and explicit settlement links claim the same bank source. Review those source relationships before importing; they cannot both populate owed/owe balances.`] : [];
}
