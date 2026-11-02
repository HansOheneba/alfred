import type { LedgerRow } from "@/lib/finance/analytics";

import { previewLedger } from "./fixture";

/** Artificial occurrence metadata for UI review only. These values are not
 * createdAt values and must never be copied into a real account or database. */
export const PREVIEW_TIME_ZONE = "Africa/Accra";

function syntheticTime(row: LedgerRow) {
  let seed = 0;
  for (const character of row.id) seed = (seed * 31 + character.charCodeAt(0)) % 100000;
  const hour = row.category === "Salary" ? 8 : 7 + (seed % 15);
  const minute = row.category === "Salary" ? 30 : Math.floor(seed / 15) % 60;
  return `${row.date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;
}

export const previewTransactionTimes: Readonly<Record<string, string>> = Object.fromEntries(
  previewLedger.rows.map((row) => [row.id, syntheticTime(row)]),
);

/** Unknown real/date-only rows do not acquire a fabricated occurrence time. */
export function previewOccurrenceFor(row: LedgerRow & { occurredAt?: string | null }): string | null {
  const occurrence = row.occurredAt ?? previewTransactionTimes[row.id.replace(/^accounting(?:-fee)?:/, "")];
  return occurrence?.slice(0, 10) === row.date ? occurrence : null;
}

const clock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: PREVIEW_TIME_ZONE, hourCycle: "h23" });

export function previewTimeLabel(row: LedgerRow): string {
  const occurrence = previewOccurrenceFor(row);
  return occurrence ? `${clock.format(new Date(occurrence))} GMT` : "Time not recorded";
}
