import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SupabaseSettings } from "@/lib/config";
import { ALFRED_EXPORT_SNAPSHOT_SQL, buildAlfredExport, scrubNativeOwnership, type AlfredNativeExport } from "@/lib/portability/export";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/supabase/connection", () => ({ query: mocks.query }));

const OWNER = "00000000-0000-4000-8000-000000000001";
const TABLES = [
  "transactions", "bankMessages", "accountRuleStates", "accountRuleEvents", "accountingStates", "accountingEvents", "budgets", "savingsGoals", "loans", "labelUndo", "people", "payeeRules", "aboutMe", "bills",
  "investments", "investmentHoldings", "investmentValues", "investmentContributions", "messages", "importedSources", "importReceipts",
];

function snapshot(): AlfredNativeExport {
  return {
    schema: 1,
    tables: Object.fromEntries(TABLES.map((name) => [name, []])),
    settings: {
      profile: {
        preferred_name: "Synthetic owner", currency: "GHS", timezone: "Africa/Accra", communication_preference: "concise",
        financial_goals: "Synthetic savings goal", account_names: "Synthetic name", created_at: "2026-11-01T12:00:00Z", updated_at: "2026-11-02T12:00:00Z",
      },
      reminderPreferences: { morning_enabled: true, morning_minute: 480 },
    },
    retainedArchives: [],
  };
}

function database(native = snapshot(), missing?: string) {
  mocks.query.mockImplementation(async (_settings, sql: string, values: unknown[]) => {
    if (sql.startsWith("select table_name,")) {
      return (values[0] as string[]).map((table_name) => ({ table_name, ready: table_name !== missing }));
    }
    return [{ native }];
  });
}

describe("read-only Alfred native export", () => {
  beforeEach(() => { mocks.query.mockReset(); });

  it("retains exact raw source data, deleted/closed history, all finance domains and prior raw archives", async () => {
    const native = snapshot();
    native.tables.transactions.push({ transaction_id: "synthetic-deleted", amount: "-20.01", status: "deleted", source_update_id: "synthetic-source" });
    native.tables.investments.push({ id: "closed-synthetic", invested_before: "99999999999999.99", status: "closed" });
    native.tables.investmentHoldings.push({ id: "synthetic-holding", quantity: "12345678901234.000001", cost: null });
    native.tables.accountingEvents.push({ revision: 150, before_state: { movements: [] }, after_state: { movements: [{ id: "synthetic" }] } });
    native.retainedArchives.push({ archiveId: "synthetic-archive", archive: { manifest: { sourceApp: "money-tracker" }, datasets: { planning: { unsupported: "retained" } } } });
    const before = structuredClone(native);
    database(native);

    const result = await buildAlfredExport({} as SupabaseSettings, OWNER);

    expect(result.datasets["alfred.native"]).toEqual({
      ...before,
      identityFieldsExcluded: ["ownerId", "userId", "owner_id", "user_id"],
      retainedArchives: [{
        archiveId: "synthetic-archive", archive: {
          sourceManifest: before.retainedArchives[0].archive.manifest,
          datasets: before.retainedArchives[0].archive.datasets,
          ownershipRedacted: true,
        },
      }],
    });
    expect(native).toEqual(before);
    expect(result).toMatchObject({ currency: "GHS", timezone: "Africa/Accra" });
    expect(result.namespace).toMatch(/^alfred:[a-f0-9]{64}$/);
    expect(result.namespace).not.toContain(OWNER);
    expect(result.coverage.filter((item) => item.dataset.startsWith("alfred.native.")).map((item) => item.dataset)).toEqual([
      ...TABLES.map((name) => `alfred.native.${name}`), "alfred.native.aboutMe.accountExclusions", "alfred.native.settings", "alfred.native.settings.reminderPreferences", "alfred.native.settings.account_names", "alfred.native.retainedArchives",
    ]);
    expect(result.coverage.find((item) => item.dataset === "alfred.native.transactions")).toMatchObject({ status: "preserved", count: 1 });
    expect(result.coverage.find((item) => item.dataset === "authentication-and-connections")?.status).toBe("excluded");
  });

  it("runs one data snapshot and never initializes settings, runs an LLM, truncates records or executes a mutation", async () => {
    database();
    await buildAlfredExport({} as SupabaseSettings, OWNER);
    expect(mocks.query).toHaveBeenCalledTimes(2);
    const dataCall = mocks.query.mock.calls[1];
    expect(dataCall[1]).toBe(ALFRED_EXPORT_SNAPSHOT_SQL);
    expect(dataCall[2]).toEqual([OWNER]);
    for (const [, sql] of mocks.query.mock.calls) {
      expect(sql).not.toMatch(/\b(insert|update|delete|alter|create|truncate|limit)\b/i);
      expect(sql).not.toContain(OWNER);
    }
  });

  it("scopes every native table read to the authenticated owner, including retained import evidence", () => {
    const reads = [...ALFRED_EXPORT_SNAPSHOT_SQL.matchAll(/from public\.([a-z_]+)(?:\s+([a-z_]+))?\s+where\s+([^\n)]*)/g)];
    expect(reads).toHaveLength(TABLES.length + 3 + 12);
    for (const [, name, , predicate] of reads) {
      expect(predicate).toContain(name === "profiles" ? "id = $1::uuid" : "owner_id = $1::uuid");
    }
    expect(ALFRED_EXPORT_SNAPSHOT_SQL).not.toMatch(/\b(select\s+\*|to_jsonb\((?:t|p|b)\))\b/i);
    expect(ALFRED_EXPORT_SNAPSHOT_SQL).not.toMatch(/public\.(?:ingest_tokens|telegram_accounts|processed_updates|pending_actions|api_rate_limits|assistant_notes|market_prices)/);
    expect(ALFRED_EXPORT_SNAPSHOT_SQL).not.toMatch(/\b(?:token_hash|password|chat_id|telegram_user_id|spreadsheet_id|endpoint|p256dh|auth_key)\b/);
  });

  it("refuses a partial export when a finance migration is absent", async () => {
    database(snapshot(), "investment_values");
    await expect(buildAlfredExport({} as SupabaseSettings, OWNER)).rejects.toThrow("Missing tables: investment_values");
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it("refuses a missing authenticated profile instead of falling back to another profile or claiming defaults", async () => {
    const native = snapshot();
    native.settings.profile = null;
    database(native);
    await expect(buildAlfredExport({} as SupabaseSettings, OWNER)).rejects.toThrow("signed-in profile has no exportable finance settings");
  });

  it("uses deterministic owner namespaces while separating different signed-in accounts", async () => {
    database();
    const one = await buildAlfredExport({} as SupabaseSettings, OWNER);
    const again = await buildAlfredExport({} as SupabaseSettings, OWNER);
    const other = await buildAlfredExport({} as SupabaseSettings, "00000000-0000-4000-8000-000000000002");
    expect(again.namespace).toBe(one.namespace);
    expect(other.namespace).not.toBe(one.namespace);
  });

  it("scrubs foreign ownership recursively and retains finance values, stable IDs and original manifest provenance", async () => {
    const native = snapshot();
    native.tables.accountingStates = [{ state: { ownerId: OWNER, movements: [{ id: "source-movement", ownerId: "foreign-owner", amountMinor: 123, feeMinor: 4, taxMinor: 5 }] } }];
    native.tables.accountingEvents = [{ before_state: { audit: [{ before: { owner_id: OWNER, user_id: OWNER, id: "source-snapshot" } }] } }];
    native.retainedArchives = [{ archiveId: "original-checksum", archive: { manifest: { checksums: { payload: "original-checksum" } }, datasets: { raw: { userId: "foreign-owner", balanceMinor: -124 } } } }];
    const before = structuredClone(native);
    database(native);
    const result = await buildAlfredExport({} as SupabaseSettings, OWNER);
    const exported = result.datasets["alfred.native"];
    expect(JSON.stringify(exported)).not.toContain("foreign-owner");
    expect(exported.tables.accountingStates).toEqual([{ state: { movements: [{ id: "source-movement", amountMinor: 123, feeMinor: 4, taxMinor: 5 }] } }]);
    expect(exported.tables.accountingEvents).toEqual([{ before_state: { audit: [{ before: { id: "source-snapshot" } }] } }]);
    expect(exported.retainedArchives[0].archive).toEqual({ sourceManifest: { checksums: { payload: "original-checksum" } }, datasets: { raw: { balanceMinor: -124 } }, ownershipRedacted: true });
    expect(native).toEqual(before);
    expect(scrubNativeOwnership([null, -5, "source-id", { ownerId: "other", id: "kept" }])).toEqual([null, -5, "source-id", { id: "kept" }]);
  });

  it("preserves multihop native provenance without substituting destination IDs or granting ownership", async () => {
    const native = snapshot();
    native.tables.budgets.push({ budget_id: "destination-generated-id", amount: "1250.01", importProvenance: { namespace: "alfred:original", sourceId: "original-budget" } });
    native.tables.loans.push({ id: "destination-loan", kind: "borrowed", amount: "20.00", importProvenance: { namespace: "alfred:original", sourceId: "original-loan" } });
    database(native);
    const result = await buildAlfredExport({} as SupabaseSettings, OWNER);
    expect(result.datasets["alfred.native"].tables.budgets[0]).toMatchObject({ importProvenance: { namespace: "alfred:original", sourceId: "original-budget" } });
    expect(result.datasets["alfred.native"].tables.loans[0]).toMatchObject({ importProvenance: { namespace: "alfred:original", sourceId: "original-loan" } });
    const readinessNames = mocks.query.mock.calls[0][2][0] as string[];
    expect(readinessNames).toContain("finance_import_native_origins");
    for (const [table, key] of Object.entries({ budgets: "budget_id", savings_goals: "goal_id", bills: "id", investments: "id", investment_holdings: "id", investment_values: "id", investment_contributions: "id", loans: "id", people: "person_key", payee_rules: "payee_key", about_me: "id", messages: "id" })) {
      expect(ALFRED_EXPORT_SNAPSHOT_SQL).toContain(`origin.table_name = '${table}' and origin.record_key = export_row.${key}::text`);
    }
    expect(ALFRED_EXPORT_SNAPSHOT_SQL).toContain("'namespace',origin.namespace,'sourceId',origin.source_key");
    expect(ALFRED_EXPORT_SNAPSHOT_SQL).toContain("import_notifications_paused");
    expect(ALFRED_EXPORT_SNAPSHOT_SQL).toContain("import_cost_basis_unknown");
    expect(ALFRED_EXPORT_SNAPSHOT_SQL).toContain("notifications_resumed_at");
  });

  it("reports native restoration boundaries for paused reminders, raw source links and account exclusions", async () => {
    const native = snapshot();
    native.tables.aboutMe = [{ id: "note", account: null, note: "Synthetic preference" }, { id: "other-person", account: "1234", note: "Someone else's account" }];
    database(native);
    const result = await buildAlfredExport({} as SupabaseSettings, OWNER);
    const coverage = new Map(result.coverage.map((item) => [item.dataset, item]));
    for (const name of ["budgets", "savingsGoals", "bills", "investments", "investmentHoldings", "investmentValues", "investmentContributions", "loans", "people", "payeeRules", "aboutMe", "messages"]) {
      expect(coverage.get(`alfred.native.${name}`)?.status).toBe("supported");
    }
    expect(coverage.get("alfred.native.aboutMe")?.count).toBe(1);
    expect(coverage.get("alfred.native.aboutMe.accountExclusions")).toMatchObject({ count: 1, status: "preserved" });
    expect(coverage.get("alfred.native.bills")?.reason).toContain("reminders paused");
    expect(coverage.get("alfred.native.investments")?.reason).toContain("notifications paused");
    expect(coverage.get("alfred.native.loans")?.reason).toContain("bank-message links remain in the archive");
    expect(coverage.get("alfred.native.settings.reminderPreferences")?.status).toBe("preserved");
    expect(coverage.get("alfred.native.settings.account_names")?.status).toBe("preserved");
    expect(coverage.get("alfred.native.accountRuleStates")?.status).toBe("supported");
    for (const name of ["transactions", "bankMessages", "accountRuleEvents", "accountingStates", "accountingEvents", "labelUndo", "importedSources", "importReceipts"]) {
      expect(coverage.get(`alfred.native.${name}`)?.status).toBe("preserved");
    }
  });
});
