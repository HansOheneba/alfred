import type { ImportPreview, ImportReceipt, PortabilityTransport } from "@/app/settings/portability-section";
import type { NativeImportSummary } from "@/app/settings/native-import-summary";
import { createArchive, readArchive, type Datasets } from "@/portability/archive.mjs";
import { DEFAULT_BROWSER_PREFERENCES, planBrowserPreferences, type BrowserPreferences } from "@/lib/portability/browser-preferences";
import { syntheticArchive } from "./finance-archive";
import { syntheticPendingDetail } from "./pending-detail";

/** In-memory UI responses only. Database transaction behavior is covered by the SQL tests. */
type Scenario = "success" | "conflict" | "stale" | "edited" | "malformed" | "native" | "nativeConflict" | "nativeSettingsConflict" | "browser" | "browserConflict" | "browserPartial" | "browserPreserved" | "pendingReady" | "pendingBlocked";
const incomingPreferences: BrowserPreferences = { schema: 1, appearance: "dark", privacy: "masked", home: "overview" };

const nativeCounts = { budgets: 1, savings_goals: 1, bills: 1, people: 1, payee_rules: 1, about_me: 2, investments: 1, investment_holdings: 1, investment_values: 1, investment_contributions: 1, loans: 1, messages: 1 };
const nativeFixture: NativeImportSummary = {
  counts: nativeCounts,
  additions: { ...nativeCounts, budgets: 0, about_me: 1 },
  duplicates: 1,
  duplicateCounts: Object.fromEntries(Object.keys(nativeCounts).map((key) => [key, key === "budgets" ? 1 : 0])),
  conflicts: [],
  coverage: [
    { dataset: "alfred.native.budgets", status: "supported", count: 1, reason: "A matching budget is already present and is skipped." },
    { dataset: "alfred.native.savingsGoals", status: "supported", count: 1, reason: "A savings goal can populate the existing Savings goals feature." },
    { dataset: "alfred.native.bills", status: "supported", count: 1, reason: "Bills are restored paused. Resume them in Bills when you want scheduling and reminders." },
    { dataset: "alfred.native.investments", status: "supported", count: 1, reason: "Investment records and their links are restored with investment notices paused." },
    { dataset: "alfred.native.aboutMe.account-exclusions", status: "preserved", count: 1, reason: "Account exclusions affect future SMS filtering and remain source evidence." },
  ],
  settings: {
    applied: ["profile.preferred_name", "profile.communication_preference", "profile.financial_goals", "reminders.morning_minute"],
    preserved: ["profile.account_names: preserved without changing future SMS classification.", "Reminder enable flags are preserved; import never enables notifications."],
    conflicts: [],
  },
};

const previewFixture: ImportPreview = {
  id: "synthetic-preview",
  archiveId: "synthetic-archive",
  sourceApp: "money-tracker",
  exportedAt: "2026-11-02T10:00:00.000Z",
  expiresAt: "2026-11-02T10:30:00.000Z",
  counts: { accounts: 2, movements: 6, snapshots: 1, transfers: 1, settlements: 2 },
  additions: { accounts: 1, movements: 5, snapshots: 1, transfers: 1, settlements: 2 },
  duplicates: 2,
  conflicts: [],
  unsupported: ["Third-party group allocations are preserved for re-export. They do not affect Alfred's reports."],
  warnings: ["Tax and fees remain separate components of each movement.", "SMS forwarding and account connections are not configured by this import."],
  canConfirm: true,
  coverage: [
    { dataset: "core.accounts", status: "supported", reason: "Accounts and balance snapshots can be added.", count: 2 },
    { dataset: "core.movements", status: "supported", reason: "Historical source evidence and provenance are retained.", count: 6 },
    { dataset: "native.money-tracker.planning.thirdPartyGroups", status: "preserved", reason: "Stored unchanged for re-export; third-party allocation features are not active in Alfred.", count: 1 },
    { dataset: "connections", status: "excluded", reason: "Credentials, sessions and device connections are never included." },
  ],
};

export function createSyntheticPortabilityTransport(scenario: Scenario): PortabilityTransport {
  const pending = syntheticPendingDetail();
  let activated = false;
  let sourceUndone = false;
  let receipts: ImportReceipt[] = [{ id: pending.item.receiptId, archiveId: pending.item.archiveId, importedAt: pending.item.importedAt, counts: pending.item.activeCounts.accounting, unsupported: pending.item.pendingDomains.map((domain) => domain.reason), undoAvailable: true }];
  const activationNative: NativeImportSummary = { counts: { about_me: 1 }, additions: { about_me: 1 }, duplicates: 0, duplicateCounts: { about_me: 0 }, conflicts: [], coverage: [{ dataset: "alfred.native.aboutMe", status: "supported", reason: "This simulated adapter can add one source explanation to the existing Notebook. Third-party allocations and income intentions remain pending.", count: 1 }], settings: { applied: [], preserved: [], conflicts: [] } };
  const browserMode = scenario.startsWith("browser");
  const nativeMode = scenario.startsWith("native") || browserMode;
  const sourceApp = nativeMode ? "alfred" : "money-tracker";
  const incoming = scenario === "browserConflict" ? DEFAULT_BROWSER_PREFERENCES : incomingPreferences;
  const preferencePlan = { ...planBrowserPreferences(scenario === "browserConflict" ? incomingPreferences : DEFAULT_BROWSER_PREFERENCES, incoming), ...(scenario === "browserPreserved" ? { status: "preserved" as const, changes: [], conflicts: [], warnings: ["This browser cannot coordinate preference changes across tabs, so device preferences remain in the archive and are not applied."] } : {}) };
  return {
    async exportArchive() { return new Blob([new Uint8Array(await syntheticArchive(sourceApp, browserMode ? incoming : undefined))], { type: "application/zip" }); },
    async preview(file) {
      if (scenario === "malformed") throw new Error("The archive checksum does not match. Nothing was imported.");
      const archive = await readArchive(await file.arrayBuffer());
      return {
        ...previewFixture,
        sourceApp: archive.manifest.sourceApp,
        archiveId: archive.archiveId,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        ...(scenario === "conflict" ? { conflicts: ["Movement source:synthetic-payment already exists with different amounts. Existing records will not be overwritten."], canConfirm: false } : {}),
        ...(nativeMode ? {
          native: { ...nativeFixture, ...(scenario === "nativeConflict" ? { conflicts: ["Bills: a different destination record already uses this name. Nothing will be overwritten."] } : {}), ...(scenario === "nativeSettingsConflict" ? { settings: { ...nativeFixture.settings, conflicts: ["profile.timezone: destination has a different non-default value; it will not be overwritten."] } } : {}) },
          unsupported: ["Account exclusion notes and account-name matching are retained as evidence without changing SMS collection."],
          warnings: ["Imported bills start paused; resume them in Bills when you want reminders.", "Investment financial records populate the portfolio with notices paused.", "This is a native Alfred archive. Cross-app feature coverage is determined separately by each adapter."],
          coverage: [...previewFixture.coverage.filter((item) => !item.dataset.startsWith("native.money-tracker")), ...nativeFixture.coverage],
        } : {}),
        ...(browserMode ? { browserPreferences: preferencePlan } : {}),
      };
    },
    async confirm(previewId) {
      if (scenario === "stale") throw new Error("Your records changed after this preview. Preview the archive again before importing.");
      if (previewId === "synthetic-activation-preview") {
        const prior = receipts.find((receipt) => receipt.id === "synthetic-activation-receipt");
        if (prior && !prior.undoneAt) return prior;
        activated = true;
        const receipt: ImportReceipt = { id: "synthetic-activation-receipt", activationOf: pending.item.receiptId, archiveId: pending.item.archiveId, importedAt: new Date().toISOString(), counts: { accounts: 0, movements: 0, snapshots: 0, transfers: 0, settlements: 0 }, native: activationNative, unsupported: pending.item.pendingDomains.map((domain) => domain.reason), undoAvailable: true };
        receipts = [receipt, ...receipts.filter((item) => item.id !== receipt.id)];
        return receipt;
      }
      const receipt: ImportReceipt = {
        id: "synthetic-import-receipt",
        archiveId: previewFixture.archiveId,
        importedAt: new Date().toISOString(),
        counts: { accounts: 1, movements: 5, snapshots: 1, transfers: 1, settlements: 2 },
        unsupported: previewFixture.unsupported,
        undoAvailable: true,
        ...(nativeMode ? { native: nativeFixture, investmentNotificationsPaused: true, unsupported: ["Account exclusion notes are preserved without changing future SMS filtering."] } : {}),
        ...(browserMode ? { browserPreferences: { status: scenario === "browserPreserved" ? "preserved" as const : scenario === "browserPartial" ? "partial" as const : "applied" as const, changes: preferencePlan.changes, warnings: scenario === "browserPartial" ? ["The finance import completed, but this simulated device could not save every preference. No financial rollback was attempted."] : [], undoBlocked: scenario === "browserPartial" }, undoAvailable: scenario !== "browserPartial" } : {}),
      };
      receipts = [receipt, ...receipts.filter((item) => item.id !== receipt.id)];
      return receipt;
    },
    async undo(id) {
      if (scenario === "edited") throw new Error("This import has later edits or new links. Undo is blocked; no records were removed.");
      const result = { id, undoneAt: new Date().toISOString(), undoAvailable: false as const, ...(browserMode ? { browserPreferences: { status: "undone" as const, changes: preferencePlan.changes, warnings: [], undoBlocked: false } } : {}) };
      if (id === "synthetic-activation-receipt") activated = false;
      if (id === pending.item.receiptId) { sourceUndone = true; activated = false; }
      receipts = receipts.map((receipt) => receipt.id === id ? { ...receipt, ...result } : receipt);
      return result;
    },
    async receipts() { return receipts; },
    async resumeNotifications(id) {
      receipts = receipts.map((receipt) => receipt.id === id ? { ...receipt, investmentNotificationsPaused: false, undoAvailable: false } : receipt);
      return { resumed: 1, receipt: receipts.find((receipt) => receipt.id === id) };
    },
    async pending() { return [{ ...pending.item, undone: sourceUndone, activationAvailable: !sourceUndone, activeCounts: sourceUndone ? { accounting: {}, native: {} } : { ...pending.item.activeCounts, native: { ...pending.item.activeCounts.native, about_me: (pending.item.activeCounts.native.about_me ?? 0) + (activated ? 1 : 0) } } }]; },
    async pendingDetail() { return { ...pending, item: (await this.pending())[0] }; },
    async downloadPending() {
      const bytes = await createArchive({ sourceApp: "money-tracker", namespace: pending.item.namespace, timezone: "Africa/Accra", currency: "GHS", exportedAt: pending.item.exportedAt, datasets: pending.datasets as Datasets, coverage: Object.keys(pending.datasets).map((dataset) => ({ dataset, status: dataset === "moneyTracker.native" ? "preserved" as const : "supported" as const, reason: "Complete fictional saved source records." })) });
      return new Blob([new Uint8Array(bytes)], { type: "application/zip" });
    },
    async previewActivation() {
      if (sourceUndone) return { status: "blocked", text: "This source import was undone. Its saved data remains downloadable, but activation is unavailable.", conflicts: ["The source receipt is undone."], pendingDomains: pending.item.pendingDomains };
      if (scenario === "pendingBlocked") return { status: "blocked", text: "The saved source needs a fresh review. No records were activated.", conflicts: ["A destination note changed after the earlier import. Existing records will not be overwritten."], pendingDomains: pending.item.pendingDomains };
      if (scenario !== "pendingReady" || activated) return { status: "nothing_new", text: "Still awaiting support. No additional records can become active with the current adapters, and no finance records changed.", pendingDomains: pending.item.pendingDomains };
      return { status: "ready", preview: { ...previewFixture, id: "synthetic-activation-preview", archiveId: pending.item.archiveId, activationOf: pending.item.receiptId, sourceApp: "money-tracker", exportedAt: pending.item.exportedAt, expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), counts: { accounts: 0, movements: 0, snapshots: 0, transfers: 0, settlements: 0 }, additions: { accounts: 0, movements: 0, snapshots: 0, transfers: 0, settlements: 0 }, duplicates: 0, native: activationNative, coverage: activationNative.coverage, unsupported: pending.item.pendingDomains.map((domain) => domain.reason), warnings: ["This is a simulated activation review for an existing Notebook feature. No third-party allocation or income-planning feature is activated."] } };
    },
  };
}
