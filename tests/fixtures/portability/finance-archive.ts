import { createArchive } from "@/portability/archive.mjs";
import type { BrowserPreferences } from "@/lib/portability/browser-preferences";

/** Every record here is fictional. This fixture never reads a finance service. */
export async function syntheticArchive(sourceApp: "money-tracker" | "alfred" = "money-tracker", browserPreferences?: BrowserPreferences) {
  const at = "2026-01-01T12:00:00.000Z";
  const accounts = ["bank", "wallet"].map((id) => ({ id, label: `Fictional ${id}`, provider: "Synthetic", currency: "GHS", includeInCash: true, createdAt: at }));
  const movement = (id: string, accountId: string, direction: string, amountMinor: number, status = "confirmed") => ({
    id, accountId, direction, amountMinor, feeMinor: 25, taxMinor: 10, currency: "GHS", date: "2026-01-01", occurredAt: at,
    status, description: `Fictional ${id}`, category: "Other", sourceId: `source-${id}`, sourceKind: "manual", sourceFingerprint: `fp-${id}`,
    legacyTransactionId: null, feeTransactionId: null, legacyClassification: null,
  });
  const ref = (id: string) => ({ movementId: id, sourceFingerprint: `fp-${id}` });
  const featureId = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
  const native = {
    schema: 1,
    tables: {
      budgets: [{ budget_id: "synthetic-food-budget", period: "2026-01", category: "Food", amount: "500.00", currency: "GHS", created_at: at, updated_at: at }],
      savingsGoals: [{ goal_id: "synthetic-goal", name: "Fictional emergency fund", target_amount: "1000.00", current_amount: "250.00", currency: "GHS", target_date: "2026-12-01", status: "active", created_at: at, updated_at: at }],
      bills: [{ id: featureId(1), name: "Fictional internet bill", next_date: "2026-12-01", amount: "250.00", currency: "GHS", cadence: "monthly", active: true, reminded_for: null, created_at: at, updated_at: at }],
      people: [{ person_key: "fictional friend", name: "Fictional Friend", note: "Synthetic people note.", updated_at: at }],
      payeeRules: [{ payee_key: "fictional merchant", category: "Food", description: "Fictional merchant", kind: "category", updated_at: at }],
      aboutMe: [{ id: featureId(2), note: "Synthetic notebook note.", account: null, created_at: at }, { id: featureId(3), note: "Synthetic excluded-account note.", account: "1234", created_at: at }],
      investments: [{ id: featureId(4), name: "Fictional T-bill", kind: "tbill", provider: "Synthetic", currency: "GHS", invested_before: "1000.00", principal: "1000.00", rate: "24.0000", started_on: "2026-01-01", matures_on: "2026-12-01", reminded_at: null, payee_key: null, status: "active", created_at: at, updated_at: at }],
      investmentHoldings: [{ id: featureId(5), investment_id: featureId(4), symbol: "SYNTH", quantity: "1.000000", cost: "1000.00", updated_at: at }],
      investmentValues: [{ id: featureId(6), investment_id: featureId(4), value: "1120.00", as_of: at, source: "reported", created_at: at }],
      investmentContributions: [{ id: featureId(7), investment_id: featureId(4), amount: "1000.00", currency: "GHS", occurred_on: "2026-01-01", bank_message_id: null, note: "Fictional contribution.", created_at: at }],
      loans: [{ id: featureId(8), person: "Fictional Friend", person_key: "fictional friend", kind: "lent", amount: "20.00", currency: "GHS", occurred_at: at, note: "Synthetic loan.", bank_message_id: null, created_at: at }],
      messages: [{ id: featureId(9), channel: "web", role: "user", body: "Fictional historical message.", created_at: at, client_id: null, intent: null, meta: null }],
    },
    settings: {
      profile: { preferred_name: "Fictional Alex", currency: "GHS", timezone: "Africa/Accra", communication_preference: "detailed", financial_goals: "A fictional emergency fund.", account_names: "Fictional Account Name", created_at: at, updated_at: at },
      reminderPreferences: { morning_enabled: true, morning_minute: 540, commute_enabled: false, commute_minute: 510, evening_enabled: false, evening_minute: 1200, updated_at: at },
    },
    retainedArchives: [],
  };
  const datasets = {
    accounts,
    movements: [movement("payment", "bank", "out", 10000), movement("refund", "bank", "in", 2500), movement("loan", "bank", "out", 5000), movement("repayment", "bank", "in", 2000), movement("transfer-out", "bank", "out", 3000, "transfer"), movement("transfer-in", "wallet", "in", 3000, "transfer")],
    snapshots: [{ id: "snapshot", accountId: "bank", balanceMinor: 70000, occurredAt: at, sourceId: "synthetic-bank", sourceMovementId: null }],
    transfers: [{ id: "transfer", outgoing: ref("transfer-out"), incoming: ref("transfer-in"), createdAt: at }],
    settlements: [
      { id: "partial-refund", kind: "refund", original: ref("payment"), returns: [{ ...ref("refund"), principalMinor: 2000 }], createdAt: at },
      { id: "partial-loan", kind: "loan", original: ref("loan"), returns: [{ ...ref("repayment"), principalMinor: 1500 }], createdAt: at },
    ],
    ...(sourceApp === "alfred" ? { "alfred.native": native } : { "moneyTracker.native": { planning: { thirdPartyGroups: [{ id: "synthetic-group" }] } } }),
    ...(browserPreferences ? { "alfred.browserPreferences": browserPreferences } : {}),
  };
  return createArchive({ sourceApp, namespace: "synthetic:ui-preview", timezone: "Africa/Accra", currency: "GHS", exportedAt: at, datasets, coverage: Object.keys(datasets).map((dataset) => ({ dataset, status: dataset.includes(".") ? "preserved" as const : "supported" as const, reason: "Synthetic interface fixture" })) });
}
