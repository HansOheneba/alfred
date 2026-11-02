import { createArchive, readArchive, type Archive, type Datasets } from "@/portability/archive.mjs";

/** Fictional contract fixture. No source application, storage or external file is accessed. */
export const JOURNEY_ACCOUNT_LABELS = ["Harbor payroll • 2468", "Kaya’s travel wallet"];
export async function journeyArchive(day: string) {
  const at = `${day}T00:00:00.000Z`;
  const month = day.slice(0, 7);
  const accounts = ["bank", "wallet"].map((id, index) => ({ id, label: JOURNEY_ACCOUNT_LABELS[index], provider: "Synthetic", currency: "GHS", includeInCash: true, createdAt: at }));
  const movement = (id: string, accountId: string, direction: "in" | "out", amountMinor: number, feeMinor = 0, taxMinor = 0, status = "confirmed") => ({
    id, accountId, direction, amountMinor, feeMinor, taxMinor, status, sourceStatus: status, currency: "GHS", date: day, occurredAt: at,
    description: `Synthetic ${id}`, category: id === "purchase" ? "Food & groceries" : "Uncategorized", sourceCategory: "Uncategorized",
    sourceId: `synthetic-${id}`, sourceKind: "manual", sourceFingerprint: `fixture-${id}`, legacyTransactionId: null, feeTransactionId: null, legacyClassification: null,
    sourceText: "SYNTHETIC CONTRACT FIXTURE ONLY",
  });
  const movements = [movement("purchase", "bank", "out", 10000, 100, 20), movement("refund", "bank", "in", 3000), movement("loan", "bank", "out", 6000, 25), movement("repayment", "bank", "in", 2500), movement("transfer-out", "bank", "out", 3000, 10, 5, "transfer"), movement("transfer-in", "wallet", "in", 3000, 0, 0, "transfer")];
  const ref = (movementId: string) => ({ movementId, sourceFingerprint: `fixture-${movementId}` });
  const native = {
    snapshot: { accounts: accounts.map((account) => ({ account: account.id, label: account.label })), transactions: [] },
    planning: {
      plans: { [month]: { month, limit: 20000, categoryLimits: { "Food & groceries": 20000 }, repeat: false, focus: "Fictional planning intent" } },
      overrides: { "synthetic-purchase": { note: "Synthetic receipt note" } },
      rules: [], thirdPartyGroups: [{ id: "synthetic-shared-group", note: "Fictional unsupported allocation", sourceIds: ["synthetic-purchase"] }],
      preferences: { paymentPrompts: false },
    },
    bills: { bills: [], preferences: { reminders: false } },
  };
  return createArchive({ sourceApp: "money-tracker", namespace: "synthetic:journey-source", timezone: "Africa/Accra", currency: "GHS", exportedAt: at,
    datasets: { accounts, movements, snapshots: accounts.map((account) => ({ id: `balance-${account.id}`, accountId: account.id, balanceMinor: 50000, occurredAt: at, sourceId: `reported-${account.id}`, sourceMovementId: null })),
      transfers: [{ id: "synthetic-transfer", outgoing: ref("transfer-out"), incoming: ref("transfer-in"), createdAt: at }],
      settlements: [{ id: "partial-refund", kind: "refund", original: ref("purchase"), returns: [{ ...ref("refund"), principalMinor: 3000 }], createdAt: at }, { id: "partial-loan", kind: "loan", original: ref("loan"), returns: [{ ...ref("repayment"), principalMinor: 2000 }], createdAt: at }], "moneyTracker.native": native } as Datasets,
    coverage: [{ dataset: "moneyTracker.native.planning.thirdPartyGroups", status: "preserved", reason: "Fictional source allocation has no equivalent destination feature." }],
  });
}

/** Models the documented retained wrapper contract; it does not execute another app. */
export async function retainedReturnArchive(bytes: Uint8Array) {
  const source: Archive = await readArchive(bytes);
  return createArchive({ sourceApp: "money-tracker", namespace: "synthetic:journey-return", timezone: source.manifest.timezone, currency: source.manifest.currency, exportedAt: source.manifest.exportedAt,
    datasets: { accounts: source.datasets.accounts, movements: source.datasets.movements, snapshots: source.datasets.snapshots, transfers: source.datasets.transfers, settlements: source.datasets.settlements, preservedArchives: [{ manifest: source.manifest, datasets: source.datasets }] } as Datasets,
    coverage: [{ dataset: "preservedArchives", status: "preserved", reason: "The source app retained native features it could not activate." }],
  });
}
