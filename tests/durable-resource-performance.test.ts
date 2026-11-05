import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SupabaseSettings, UserProfile } from "@/lib/config";
import { accountBalances } from "@/lib/finance/accounting/accounts";
import { balanceForCurrency } from "@/lib/finance/accounting/accounts-model";
import { tryLoadDurableAccountsView } from "@/lib/finance/accounting/durable-accounts";
import { browserAccountingState } from "@/lib/finance/accounting/browser-state";
import { includedAccountCash } from "@/lib/finance/accounting/cash-summary";
import { buildAccountingDisplayModel } from "@/lib/finance/accounting/display-builder";
import { ACCOUNTING_DISPLAY_DEFINITION } from "@/lib/finance/accounting/display-model";
import { displayRowsForPublication } from "@/lib/finance/accounting/display-worker";
import type { AccountingResult } from "@/lib/finance/accounting/persisted-store";
import { withLedgerReceipts } from "@/lib/finance/accounting/receipts";
import { projectAccountingTransactions } from "@/lib/finance/accounting/view";
import { toLedgerRows } from "@/lib/finance/analytics";
import { buildInsights } from "@/lib/finance/insights";
import { formatDisplayInsights } from "@/lib/finance/display-insight-facts";
import { readDurableOverview } from "@/lib/web/durable-overview";
import { readDurableInsightFacts } from "@/lib/web/durable-insight-query";
import { readDurableAccountFacts } from "@/lib/web/durable-secondary";
import type { OverviewTransactionQuery } from "@/lib/web/overview-transactions";
import { populatedPerformanceFixture } from "./populated-performance-fixture";

const io = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/supabase/connection", () => ({ query: io.query }));
const fixture = populatedPerformanceFixture(), OWNER = fixture.state.ownerId, TODAY = "2026-11-05";
const settings = {} as SupabaseSettings;
const profile = { profileId: OWNER, currency: "GHS", timezone: "Africa/Accra" } as UserProfile;
const source: AccountingResult = { state: fixture.state, rawTransactions: fixture.raw, bankMessages: fixture.messages, availability: "ready", sourceVersion: "fictional-model-publication-version" };
const query: OverviewTransactionQuery = { preset: "this_month", category: null, filters: { search: "", type: "all", category: "all", sort: "date-desc" } };
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const precision = (value: number) => Number(value.toFixed(3));
const summary = (samples: number[]) => { const sorted = [...samples].sort((a, b) => a - b); return { samplesMs: samples.map(precision), medianMs: precision(sorted[Math.floor(sorted.length / 2)]), minMs: precision(sorted[0]), maxMs: precision(sorted[sorted.length - 1]) }; };
type SqlRead = { sqlMs: number; responseBytes: number };
let db: PGlite;
const sqlReads: SqlRead[] = [];
const report: Record<string, unknown> = {
  scope: "Local PGlite resource SQL and actual private publication protocol; fictional model-publication fixture independent of SQL source ingestion. Not browser, HTTP, deployment startup or production timing.",
  fixture: { movements: 2315, snapshots: 2277, transferLinks: 200, rawInMemory: 2, bankInMemory: 6, importedInMemory: 2309, auditBeforeCopies: 4, sqlFinancialSourceRows: 0 },
  limitations: "Fictional source identifiers are retained in the canonical model and are not rewritten into SQL transaction UUIDs. This benchmark exercises canonical builder -> actual lease/capture/publish -> actual manifest/resource queries. Matching source ingestion and the source-coherent loader journey are tested in durable-insight-query.test.ts. Stateless wrappers are new objects within one Node/PGlite process, not fresh OS processes. Timings include local PGlite execution/JSON decoding; they exclude network, authentication, SQL server contention, browser rendering and production cold-start behavior. Source tables are inaccessible during reads and the old full-history hash function throws.",
};
function newStatelessReader() {
  return {
    overview: () => readDurableOverview(settings, profile, TODAY, query),
    insights: () => readDurableInsightFacts(settings, profile, TODAY, []),
    cash: () => readDurableAccountFacts(settings, OWNER),
    accounts: () => tryLoadDurableAccountsView(settings, OWNER, { currency: "GHS", section: "activity", page: 0 }),
  };
}
type Reader = ReturnType<typeof newStatelessReader>;

beforeAll(async () => {
  db = new PGlite();
  await db.exec("create role anon;create role authenticated;create schema auth;create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}'::jsonb);");
  const migrations = readdirSync("supabase/migrations").filter(file => file.endsWith(".sql")).sort();
  for (const file of migrations) await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
  await db.query("insert into auth.users(id) values($1::uuid)", [OWNER]);
  const token = randomUUID();
  await db.query("select alfred_display.enqueue($1::uuid,$2::text)", [OWNER, ACCOUNTING_DISPLAY_DEFINITION]);
  const job = (await db.query<{ result: { ownerId: string } }>("select alfred_display.claim($1::text,$2::uuid,120) as result", [ACCOUNTING_DISPLAY_DEFINITION, token])).rows[0].result;
  expect(job.ownerId).toBe(OWNER);
  const baseline = (await db.query<{ result: unknown }>("select alfred_display.capture($1::uuid,$2::text,$3::uuid) as result", [OWNER, ACCOUNTING_DISPLAY_DEFINITION, token])).rows[0].result;
  const start = performance.now(), model = buildAccountingDisplayModel(source), buildMs = performance.now() - start;
  const wireRows = displayRowsForPublication(model.rows);
  const publishing = performance.now();
  const result = (await db.query<{ result: { status: string } }>("select alfred_display.publish($1::uuid,$2::text,$3::uuid,$4::jsonb,$5::jsonb,$6::jsonb) as result", [OWNER, ACCOUNTING_DISPLAY_DEFINITION, token, JSON.stringify(baseline), JSON.stringify(model.manifest), JSON.stringify(wireRows)])).rows[0].result;
  const publishMs = performance.now() - publishing;
  expect(result.status).toBe("saved"); expect(model.manifest.accounts.counts).toMatchObject({ movements: 2315, snapshots: 2277, transfers: 200 });
  const transactions = projectAccountingTransactions(source.rawTransactions, source.state);
  const oldReportDetails = withLedgerReceipts(toLedgerRows(transactions), source.state, OWNER);
  report.publication = { migrations: migrations.length, buildMs: precision(buildMs), publishMs: precision(publishMs), normalizedRows: model.rows.length, reportRows: oldReportDetails.length, manifestBytes: bytes(model.manifest), normalizedModelBytes: bytes(model), normalizedWireRowsBytes: bytes(wireRows) };
  report.baselineBytes = { fullSavedAccountingState: bytes(source.state), oldCanonicalDisplayResult: bytes({ ...source, state: browserAccountingState(source.state) }), completeCanonicalReportDetails: bytes(oldReportDetails) };
  await db.exec(`create or replace function public.alfred_accounting_source_version(owner uuid) returns text language plpgsql stable set search_path=public as $$begin raise exception 'Full source hashing is forbidden in this durable-hit benchmark';end$$;
    create role durable_resource_reader bypassrls;
    grant usage on schema alfred_display to durable_resource_reader;
    grant select on all tables in schema alfred_display to durable_resource_reader;
    grant execute on function alfred_display.manifest(uuid,text),alfred_display.readiness() to durable_resource_reader;`);
  await expect(db.query("select public.alfred_accounting_source_version($1::uuid)", [OWNER])).rejects.toThrow("Full source hashing is forbidden");
  await db.exec("set role durable_resource_reader");
  for (const table of ["transactions", "bank_messages", "imported_finance_sources", "accounting_states", "account_rule_states"]) await expect(db.query(`select 1 from public.${table} limit 0`)).rejects.toThrow(/permission denied/);
  io.query.mockImplementation(async (_settings: SupabaseSettings, sql: string, values: unknown[] = []) => {
    if (/\b(?:transactions|bank_messages|imported_finance_sources|accounting_states|account_rule_states)\b|alfred_accounting_source_version/i.test(sql)) throw new Error("Durable resource attempted a source-history/hash read.");
    expect(sql).toMatch(/^with fresh as materialized/i);
    const started = performance.now(), rows = (await db.query(sql, values)).rows;
    sqlReads.push({ sqlMs: performance.now() - started, responseBytes: bytes(rows) }); return rows;
  });
  vi.stubEnv("ALFRED_DURABLE_DISPLAY", "true");
}, 30_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await db?.exec("reset role"); await db?.close();
  const output = process.env.ALFRED_DURABLE_RESOURCE_PERFORMANCE_OUTPUT;
  if (output) await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
});

describe("persisted populated durable resource reads", () => {
  it("serves three new stateless readers with complete totals and no source access, then records seven local SQL repeats", async () => {
    const cold: unknown[] = [];
    const expectedCash = includedAccountCash({ availability: "ready", balances: accountBalances(source.state, "GHS") }, "GHS");
    const expectedInsight = buildInsights({ userId: OWNER, currency: "GHS", today: TODAY, range: { start: "2026-11-01", end: "2026-11-30" }, transactions: projectAccountingTransactions(source.rawTransactions, source.state), budgets: [] });
    for (let index = 0; index < 3; index++) {
      const reader = newStatelessReader(), prior = io.query.mock.calls.length;
      const overview = await reader.overview(), insights = await reader.insights(), cash = await reader.cash(), accounts = await reader.accounts();
      expect(io.query.mock.calls.length - prior).toBe(4);
      expect(overview?.data.page).toMatchObject({ total: 1915 }); expect(overview?.data.page.rows).toHaveLength(15);
      expect(overview?.manifest.accounts.counts).toMatchObject({ movements: 2315, snapshots: 2277 });
      expect(accounts?.counts).toMatchObject({ movements: 2315, snapshots: 2277 }); expect(accounts?.page.rows).toHaveLength(25);
      expect(formatDisplayInsights(insights!.data.insights, [])).toEqual(expectedInsight);
      const actualCash = includedAccountCash({ availability: cash!.manifest.accounts.availability, balances: balanceForCurrency(cash!.manifest.accounts.accountFacts, "GHS") }, "GHS");
      expect(actualCash).toEqual(expectedCash); expect(insights?.data.days.length).toBeLessThanOrEqual(31);
      expect(JSON.stringify([overview, insights, cash, accounts])).not.toMatch(/sourceText|"before"/);
      cold.push({ wrapper: index + 1, overviewBytes: bytes(overview), insightsBytes: bytes(insights), cashBundleBytes: bytes(cash), accountsBytes: bytes(accounts), includedCashBytes: bytes(actualCash), detailRows: overview!.data.page.rows.length, accountRows: accounts!.page.rows.length, totalReportRows: overview!.data.page.total, sql: sqlReads.slice(-4).map(read => ({ sqlMs: precision(read.sqlMs), responseBytes: read.responseBytes })) });
    }
    report.statelessWrappers = cold;
    async function measure() {
      const repeats: Record<string, unknown> = {};
      for (const name of ["overview", "insights", "cash", "accounts"] as const) {
        const sqlMs: number[] = [], totalMs: number[] = [], responseBytes: number[] = [], bundleBytes: number[] = [];
        for (let run = 0; run < 7; run++) {
          const reader: Reader = newStatelessReader(), prior = io.query.mock.calls.length, started = performance.now();
          const value = await reader[name](); totalMs.push(performance.now() - started);
          expect(value).not.toBeNull(); expect(io.query.mock.calls.length - prior).toBe(1);
          sqlMs.push(sqlReads.at(-1)!.sqlMs); responseBytes.push(sqlReads.at(-1)!.responseBytes); bundleBytes.push(bytes(value));
        }
        expect(new Set(responseBytes).size).toBe(1); expect(new Set(bundleBytes).size).toBe(1);
        repeats[name] = { iterations: 7, localSql: summary(sqlMs), localReadIncludingValidation: summary(totalMs), sqlResponseCompactJsonBytes: responseBytes[0], bundleCompactJsonBytes: bundleBytes[0], queriesPerRead: 1 };
      }
      return repeats;
    }
    report.repeatedReads = await measure();
    const accountCall = io.query.mock.calls[3] as [SupabaseSettings, string, unknown[]];
    report.accountsPlanBeforeAnalyze = (await db.query(`explain (analyze,buffers,format json) ${accountCall[1]}`, accountCall[2])).rows;
    // A fresh large publication can have different planner statistics from a
    // maintained database. Report both conditions instead of hiding the first.
    await db.exec("reset role;analyze alfred_display.rows;set role durable_resource_reader");
    report.afterExplicitAnalyze = await measure();
    report.accountsPlanAfterAnalyze = (await db.query(`explain (analyze,buffers,format json) ${accountCall[1]}`, accountCall[2])).rows;
    const manifestMs: number[] = [];
    for (let sample = 0; sample < 7; sample++) {
      const start = performance.now();
      await db.query("select alfred_display.manifest($1::uuid,$2::text)", [OWNER, ACCOUNTING_DISPLAY_DEFINITION]);
      manifestMs.push(performance.now() - start);
    }
    report.manifestOnlyLocalSql = summary(manifestMs);
    report.proof = { newStatelessWrappers: 3, wrapperQueries: 12, repeatQueries: 28, analyzedRepeatQueries: 28, totalSourceFreeQueries: io.query.mock.calls.length, sourceSelectDenied: true, fullSourceHashThrows: true, inMemoryAccountingCacheUsed: false };
    expect(io.query).toHaveBeenCalledTimes(68);
  }, 30_000);
});
