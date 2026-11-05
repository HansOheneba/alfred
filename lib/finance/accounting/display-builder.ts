import type { AccountingResult } from "./persisted-store";
import { buildAccountsModel } from "./accounts-model";
import { buildDurableLedgerRows } from "@/lib/web/durable-ledger";
import { ACCOUNTING_DISPLAY_DEFINITION, ACCOUNTING_DISPLAY_LIMITS, ACCOUNTING_DISPLAY_VERSION, type AccountingDisplayModel } from "./display-model";

/** Build once from the complete canonical source result, never from a prior derived projection. */
export function buildAccountingDisplayModel(result: AccountingResult): AccountingDisplayModel {
  const accounts = buildAccountsModel(result), ledger = { rows: buildDurableLedgerRows(result) };
  const rows = [...accounts.rows, ...ledger.rows];
  const rowCounts = { movement: 0, snapshot: 0, transfer: 0, settlement: 0, return: 0, evidence: 0, ledger: 0 };
  for (const row of rows) rowCounts[row.kind]++;
  const model: AccountingDisplayModel = { definition: ACCOUNTING_DISPLAY_DEFINITION, manifest: { kind: "accounting-display", projectorVersion: ACCOUNTING_DISPLAY_VERSION,
    ownerId: result.state.ownerId, revision: result.state.revision, sourceVersion: result.sourceVersion, accounts: accounts.manifest, rowCounts, ledger: { count: ledger.rows.length, earliestDate: ledger.rows.reduce<string | null>((date, row) => row.date && (date === null || row.date < date) ? row.date : date, null), currencies: [...new Set(ledger.rows.flatMap(row => row.currency ? [row.currency] : []))].sort() } }, rows };
  if (model.rows.length > ACCOUNTING_DISPLAY_LIMITS.maxRows) throw new Error("The complete display model exceeds its publication row limit.");
  if (Buffer.byteLength(JSON.stringify(model.manifest)) > ACCOUNTING_DISPLAY_LIMITS.maxManifestBytes) throw new Error("The complete display manifest exceeds its publication size limit.");
  const ids = new Set<string>();
  for (const row of model.rows) {
    const id = JSON.stringify([row.kind, row.id]);
    if (ids.has(id)) throw new Error("The complete display model contains duplicate row identities.");
    ids.add(id);
    if (Buffer.byteLength(JSON.stringify(row)) > ACCOUNTING_DISPLAY_LIMITS.maxRowBytes) throw new Error("A display fact exceeds its publication size limit.");
  }
  if (Buffer.byteLength(JSON.stringify(model)) > ACCOUNTING_DISPLAY_LIMITS.maxBytes) throw new Error("The complete display model exceeds its publication size limit.");
  return model;
}
