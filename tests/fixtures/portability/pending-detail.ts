import type { PendingImportDetail } from "@/app/settings/pending-import-types";

/** Fictional, deliberately unsupported source meanings; no feature is activated. */
export function syntheticPendingDetail(): PendingImportDetail {
  const at = "2026-11-02T10:00:00.000Z";
  const movement = (id: string, accountId: string, direction: "in" | "out", amountMinor: number, date: string, description: string, sourceFingerprint: string) => ({
    id, accountId, direction, amountMinor, feeMinor: 0, taxMinor: 0, currency: "GHS", date, occurredAt: `${date}T12:00:00.000Z`,
    status: "confirmed", description, category: "Other", sourceId: id, sourceKind: "manual", sourceFingerprint, legacyTransactionId: null, feeTransactionId: null, legacyClassification: null,
  });
  return {
    item: {
      receiptId: "synthetic-pending-receipt", archiveId: "synthetic-pending-archive", sourceApp: "money-tracker", namespace: "synthetic:pending-review", exportedAt: at, importedAt: "2026-11-02T10:15:00.000Z", undone: false,
      activeCounts: { accounting: { accounts: 2, movements: 3, snapshots: 1 }, native: { budgets: 1, about_me: 3 } },
      pendingDomains: [
        { dataset: "moneyTracker.native.planning.thirdPartyGroups", path: ["moneyTracker.native", "planning", "thirdPartyGroups"], status: "awaiting_support", reason: "Alfred has no third-party allocation feature. Group membership and allocated principal remain saved without changing personal spending.", count: 1 },
        { dataset: "moneyTracker.native.planning.plans", path: ["moneyTracker.native", "planning", "plans"], status: "awaiting_support", reason: "Category limits can populate budgets, but expected income, saving targets and repeat intentions have no identical active feature. These intentions remain recoverable source records.", count: 1 },
        { dataset: "moneyTracker.native.planning.rules", path: ["moneyTracker.native", "planning", "rules"], status: "review_required", reason: "This rule matches one account and exact merchant text. Alfred must support those same conditions before the rule can be enabled.", count: 1 },
      ],
      savedDatasetCounts: { accounts: 2, movements: 3, snapshots: 1, transfers: 0, settlements: 0, "moneyTracker.native": 1 }, activationAvailable: true,
    },
    manifest: { format: "finance-portability", version: 1, sourceApp: "money-tracker", namespace: "synthetic:pending-review", exportedAt: at, timezone: "Africa/Accra", currency: "GHS" },
    datasets: {
      accounts: ["synthetic-wallet", "synthetic-bank"].map((id) => ({ id, label: id === "synthetic-wallet" ? "Fictional wallet" : "Fictional bank", provider: "Synthetic", currency: "GHS", includeInCash: true, createdAt: at })),
      movements: [
        movement("synthetic-funds-in", "synthetic-wallet", "in", 20000, "2026-10-29", "Fictional shared purchase money", "synthetic-in-fingerprint"),
        movement("synthetic-funds-out", "synthetic-bank", "out", 20000, "2026-10-30", "Fictional shared purchase", "synthetic-out-fingerprint"),
        movement("synthetic-personal-out", "synthetic-bank", "out", 10000, "2026-10-31", "Fictional personal purchase", "synthetic-personal-fingerprint"),
      ],
      snapshots: [{ id: "synthetic-balance", accountId: "synthetic-bank", balanceMinor: 70000, occurredAt: at, sourceId: "synthetic-reported-balance", sourceMovementId: null }],
      transfers: [], settlements: [],
      "moneyTracker.native": {
        planning: {
          thirdPartyGroups: [{ id: "synthetic-shared-group", label: "Fictional shared purchase", createdAt: at, entries: [
            { identity: "synthetic-funds-in", id: "synthetic-funds-in", sourceFingerprint: "synthetic-in-fingerprint", direction: "in", date: "2026-10-29", description: "Fictional shared purchase money", accountLabel: "Fictional wallet", principal: 12500 },
            { identity: "synthetic-funds-out", id: "synthetic-funds-out", sourceFingerprint: "synthetic-out-fingerprint", direction: "out", date: "2026-10-30", description: "Fictional shared purchase", accountLabel: "Fictional bank", principal: 12500 },
          ] }],
          plans: { "2026-11": { month: "2026-11", mode: "income-plan", expectedIncome: 500000, keepAside: 100000, investmentTarget: 50000, focus: "Fictional emergency fund plan", repeat: true, categoryLimits: { Food: 30000 } } },
          rules: [{ id: "synthetic-exact-rule", account: "fictional wallet", description: "fictional market merchant", direction: "out", category: "Food", active: true, createdAt: at }],
        },
      },
    },
    redactions: [],
  };
}
