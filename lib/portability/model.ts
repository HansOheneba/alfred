import { createHash } from "node:crypto";
import { canonicalStringify } from "../../portability/archive.mjs";
import { validateAccountData } from "@/lib/finance/accounting/accounts";
import { accountingData } from "@/lib/finance/accounting/reducer";
import { validateSettlements } from "@/lib/finance/accounting/settlements";
import { AccountingError, type AccountingData, type AccountingState, type CashMovement } from "@/lib/finance/accounting/types";

export const CORE_DOMAINS = ["accounts", "movements", "snapshots", "transfers", "settlements"] as const;
export type Domain = typeof CORE_DOMAINS[number];
export type ImportArchive = { archiveId: string; manifest: { namespace: string; sourceApp: string; exportedAt: string; coverage: unknown[] }; datasets: Record<string, unknown> };
export type ImportCounts = Record<Domain, number>;
type Origin = { namespace: string; sourceId: string; sourceFingerprint?: string };
type PortableRow = Record<string, unknown> & { id: string; importProvenance?: Origin };
const stable = (value: unknown) => canonicalStringify(JSON.parse(JSON.stringify(value)));
const comparableMovement=(row:PortableRow)=>{const {appliedRuleId:_rule,ruleConflict:_conflict,categoryOrigin:_origin,...semantic}=row;void _rule;void _conflict;return _origin==="manual"?{...semantic,categoryOrigin:_origin}:semantic;};
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const identity = (domain: Domain, namespace: string, row: PortableRow, destinationNamespace?: string): { id: string; origin: Origin } => {
  const origin = row.importProvenance ?? { namespace, sourceId: row.id };
  if (typeof origin.namespace !== "string" || !origin.namespace || origin.namespace.length > 300 || typeof origin.sourceId !== "string" || !origin.sourceId || origin.sourceId.length > 512) throw new AccountingError("Import provenance is invalid.");
  return { id: origin.namespace === destinationNamespace ? origin.sourceId : `import:${domain}:${digest(`${origin.namespace}\u0000${origin.sourceId}`).slice(0, 40)}`, origin };
};

/** Pure, deterministic append plan. Existing records are compared, never overwritten. */
export function planImport(current: AccountingState, archive: ImportArchive, previewId: string, now: string, destinationNamespace?: string) {
  const namespace = archive.manifest.namespace;
  const input = Object.fromEntries(CORE_DOMAINS.map((domain) => [domain, (archive.datasets[domain] ?? []) as PortableRow[]])) as Record<Domain, PortableRow[]>;
  const maps = Object.fromEntries(CORE_DOMAINS.map((domain) => [domain, new Map(input[domain].map((row) => [row.id, identity(domain, namespace, row, destinationNamespace)]))])) as Record<Domain, Map<string, { id: string; origin: Origin }>>;
  const remap = (domain: Domain, id: string) => {
    const mapped = maps[domain].get(id); if (!mapped) throw new AccountingError(`Imported ${domain} reference was not found.`); return mapped.id;
  };
  const reference = (value: unknown) => {
    const ref = value as { movementId: string; sourceFingerprint: string };
    return { ...ref, movementId: remap("movements", ref.movementId) };
  };
  const incoming: Record<Domain, PortableRow[]> = { accounts: [], movements: [], snapshots: [], transfers: [], settlements: [] };
  for (const domain of CORE_DOMAINS) for (const row of input[domain]) {
    const { id, origin } = maps[domain].get(row.id)!;
    const common = { ...row, id, importProvenance: origin };
    if (domain === "accounts") incoming[domain].push(common);
    if (domain === "movements") incoming[domain].push({ ...common, ownerId: current.ownerId, accountId: row.accountId === null ? null : remap("accounts", String(row.accountId)), sourceKind: "manual", sourceId: id, legacyTransactionId: null, feeTransactionId: null, sourceMissing: false, taxMinor: row.taxMinor ?? 0 });
    if (domain === "snapshots") incoming[domain].push({ ...common, accountId: remap("accounts", String(row.accountId)), sourceId: row.sourceMovementId === null ? String(row.sourceId) : remap("movements", String(row.sourceMovementId)), sourceMovementId: row.sourceMovementId === null ? null : remap("movements", String(row.sourceMovementId)) });
    if (domain === "transfers") incoming[domain].push({ ...common, outgoing: reference(row.outgoing), incoming: reference(row.incoming) });
    if (domain === "settlements") incoming[domain].push({ ...common, original: reference(row.original), returns: (row.returns as Record<string, unknown>[]).map((item) => ({ ...item, ...reference(item) })) });
  }
  const counts = Object.fromEntries(CORE_DOMAINS.map((domain) => [domain, input[domain].length])) as ImportCounts;
  const additions = Object.fromEntries(CORE_DOMAINS.map((domain) => [domain, []])) as unknown as Record<Domain, PortableRow[]>;
  const conflicts: string[] = []; let duplicates = 0;
  for (const domain of CORE_DOMAINS) {
    const existing = new Map((current[domain] as unknown as PortableRow[]).map((row) => [row.id, row]));
    for (const row of incoming[domain]) {
      const found = existing.get(row.id);
      if (!found) additions[domain].push(row);
      else if (stable(domain==="movements"?comparableMovement(found):found) === stable(domain==="movements"?comparableMovement(row):row)) duplicates++;
      else conflicts.push(`${domain}: ${row.importProvenance?.sourceId ?? row.id} differs from an existing record. No record will be overwritten.`);
    }
  }
  const next: AccountingState = { ...current, ...Object.fromEntries(CORE_DOMAINS.map((domain) => [domain, [...current[domain], ...additions[domain]]])) };
  if (!conflicts.length) {
    validateAccountData(next);
    const addedSettlements = new Set(additions.settlements.map((row) => row.id));
    const issues = validateSettlements(next).issues.filter((issue) => addedSettlements.has(issue.link.id));
    if (issues.length) throw new AccountingError(`Imported settlement is inconsistent: ${issues[0].reason}`);
    for (const link of additions.transfers as unknown as AccountingData["transfers"]) {
      const outgoing = next.movements.find((row) => row.id === link.outgoing.movementId)!;
      const incoming = next.movements.find((row) => row.id === link.incoming.movementId)!;
      if (outgoing.direction !== "out" || incoming.direction !== "in" || !outgoing.accountId || !incoming.accountId || outgoing.accountId === incoming.accountId || outgoing.currency !== incoming.currency || outgoing.amountMinor !== incoming.amountMinor || outgoing.sourceFingerprint !== link.outgoing.sourceFingerprint || incoming.sourceFingerprint !== link.incoming.sourceFingerprint) throw new AccountingError("Imported transfer evidence is inconsistent.");
    }
  }
  const preserved = Object.keys(archive.datasets).filter((key) => !CORE_DOMAINS.includes(key as Domain));
  const unsupported = preserved.map((key) => `${key}: preserved in the import receipt and future exports; no native destination records or settings are created.`);
  const additionCounts = Object.fromEntries(CORE_DOMAINS.map((domain) => [domain, additions[domain].length])) as ImportCounts;
  const canConfirm = conflicts.length === 0;
  const summary = { counts: additionCounts, incomingCounts: counts, duplicates, conflicts, unsupported, canConfirm };
  const revision = current.revision + 1;
  if (!Number.isSafeInteger(revision)) throw new AccountingError("Accounting revision capacity exceeded.");
  next.revision = revision;
  next.audit = [...current.audit, { id: `revision:${revision}`, requestId: `import:${previewId}`, action: "import", actionFingerprint: archive.archiveId, at: now, revision, before: accountingData(current) }].slice(-50);
  return { next, sources: additions.movements as unknown as CashMovement[], summary, counts, additions: additionCounts, duplicates, conflicts, unsupported, canConfirm };
}

export function importedAccountIdMap(datasets:Record<string,unknown>,namespace:string,destinationNamespace:string):Map<string,string> {
 return new Map(((datasets.accounts??[]) as PortableRow[]).map(row=>[row.id,identity("accounts",namespace,row,destinationNamespace).id]));
}

export function importedAccountProvenanceMap(datasets:Record<string,unknown>,namespace:string,destinationNamespace:string):Map<string,string> {
 return new Map(((datasets.accounts??[]) as PortableRow[]).map(row=>{const mapped=identity("accounts",namespace,row,destinationNamespace);return[`${mapped.origin.namespace}\0${mapped.origin.sourceId}`,mapped.id];}));
}
