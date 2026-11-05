import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseSettings, UserProfile } from "@/lib/config";
import { drawChart, planChart, chartFactsForPlan, formatChartFacts, type ChartQuery } from "@/lib/finance/charts";
import type { PinnedChart } from "@/lib/finance/pins";
import { addDays } from "@/lib/finance/dates";
import type { TransactionRecord } from "@/lib/finance/types";
import { buildAccountingDisplayModel } from "@/lib/finance/accounting/display-builder";
import { displayRowsForPublication } from "@/lib/finance/accounting/display-worker";
import { ACCOUNTING_DISPLAY_DEFINITION } from "@/lib/finance/accounting/display-model";
import { DurableDisplayUpdating } from "@/lib/finance/accounting/durable-read";
import { emptyAccountingState } from "@/lib/finance/accounting/types";
import { sourceMovements } from "@/lib/finance/accounting/sources";
import { projectAccountingTransactions } from "@/lib/finance/accounting/view";
import { readDurablePinnedCharts } from "@/lib/web/durable-pinned-charts";

const io = vi.hoisted(() => ({ query: vi.fn(), ensure: vi.fn() }));
vi.mock("@/lib/supabase/connection", () => ({ query: io.query }));
vi.mock("@/lib/finance/accounting/display-worker", async original => ({ ...await original<typeof import("@/lib/finance/accounting/display-worker")>(), ensureFreshDisplay: io.ensure }));
const OWNER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", OTHER = "ffffffff-ffff-4fff-8fff-ffffffffffff", AT = "2026-11-20T12:00:00.000Z", TODAY = "2026-11-20";
const profile = { profileId: OWNER, currency: "GHS", timezone: "Africa/Accra" } as UserProfile, settings = {} as SupabaseSettings;
const row = (id: string, patch: Partial<TransactionRecord> = {}): TransactionRecord => ({ transactionId: id, createdAt: AT, transactionDate: "2026-11-02", userId: OWNER, type: "expense", amount: "10.00", currency: "GHS", category: "Food", description: `Fictional ${id}`, paymentMethod: "Fictional cash", notes: "", status: "active", updatedAt: AT, sourceUpdateId: id, rowNumber: 0, ...patch });
function fixture(seed = 0) {
  return [
    ...Array.from({ length: 26 }, (_, index) => row(`merchant:${index}`, { description: [" Éclair ", "éclair", "éclair", "  Shared   SHOP ", "shared shop"][index % 5] + (index > 4 ? ` ${index}` : ""), amount: (10 + index % 3).toFixed(2), transactionDate: addDays("2026-11-01", (index + seed) % 19), category: index % 5 === 0 ? "Transport" : "Food" })),
    ...Array.from({ length: 20 }, (_, index) => row(`prior:${index}`, { description: index % 2 ? `Fictional merchant ${index}` : "Previous only merchant", amount: (8 + index % 4).toFixed(2), transactionDate: addDays("2026-10-01", (index + seed) % 28), category: index % 4 ? "Food" : "Utilities" })),
    row("income", { type: "income", amount: "1000.00", category: "Salary", description: "Fictional salary" }),
    row("signed", { amount: "-7.50", description: "Fictional share" }), row("zero", { amount: "0.00" }),
    row("future-month", { transactionDate: "2026-11-28", amount: "60.00" }),
    row("old", { transactionDate: "2025-03-01", amount: "100.00" }),
    row("deleted", { amount: "999.00", status: "deleted" }), row("usd", { amount: "999.00", currency: "USD" }), row("eur", { amount: "999.00", currency: "EUR" }),
  ];
}
const queries: ChartQuery[] = [
  { measure: "spending", by: "category", period: "this_month", compare: true },
  { measure: "spending", by: "merchant", period: "this_month", compare: true },
  { measure: "income", by: "merchant", period: "last_month", compare: true },
  { measure: "net", by: "category", period: "this_year", compare: true },
  { measure: "spending", by: "day", startDate: "2026-07-01", endDate: "2026-11-30", compare: true },
  { measure: "spending", by: "week", startDate: "2026-10-28", endDate: "2026-11-30", compare: true },
  { measure: "spending", by: "month", startDate: "2025-01-01", endDate: "2026-11-30", compare: true },
  { measure: "spending", by: "merchant", period: "this_month", category: "Food", style: "donut" },
];
const pins = (selected = queries): PinnedChart[] => selected.map((query, index) => ({ id: `fictional-pin:${index}`, ownerId: OWNER, title: "Fictional pinned chart", query, createdAt: AT }));
let db: PGlite;
async function publish(raw = fixture(), ownerId = OWNER) {
  const state = { ...emptyAccountingState(ownerId), movements: sourceMovements(ownerId, raw, []) };
  const source = { state, rawTransactions: raw, availability: "ready" as const, sourceVersion: "fictional-pin-source" };
  const token = randomUUID();
  await db.query("select alfred_display.enqueue($1::uuid,$2)", [ownerId, ACCOUNTING_DISPLAY_DEFINITION]);
  const job = (await db.query<{ result: { ownerId: string } }>("select alfred_display.claim($1,$2::uuid,120) as result", [ACCOUNTING_DISPLAY_DEFINITION, token])).rows[0].result;
  expect(job.ownerId).toBe(ownerId);
  const captured = (await db.query<{ result: unknown }>("select alfred_display.capture($1::uuid,$2,$3::uuid) as result", [ownerId, ACCOUNTING_DISPLAY_DEFINITION, token])).rows[0].result;
  const model = buildAccountingDisplayModel(source);
  const saved = (await db.query<{ result: { status: string } }>("select alfred_display.publish($1::uuid,$2,$3::uuid,$4::jsonb,$5::jsonb,$6::jsonb) as result", [ownerId, ACCOUNTING_DISPLAY_DEFINITION, token, JSON.stringify(captured), JSON.stringify(model.manifest), JSON.stringify(displayRowsForPublication(model.rows))])).rows[0].result;
  expect(saved.status).toBe("saved"); return projectAccountingTransactions(raw, state);
}
beforeAll(async () => {
  db = new PGlite();
  await db.exec("create role anon;create role authenticated;create schema auth;create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}'::jsonb);");
  for (const file of readdirSync("supabase/migrations").filter(file => file.endsWith(".sql")).sort()) await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
  await db.query("insert into auth.users(id) values($1::uuid),($2::uuid)", [OWNER, OTHER]);
  io.query.mockImplementation(async (_settings: SupabaseSettings, sql: string, values: unknown[] = []) => {
    if (/\b(?:transactions|bank_messages|accounting_states|account_rule_states|imported_finance_sources)\b|alfred_accounting_source_version/i.test(sql)) throw new Error("Pinned chart read attempted source reconstruction.");
    return (await db.query(sql, values)).rows;
  });
}, 30_000);
beforeEach(async () => { vi.stubEnv("ALFRED_DURABLE_DISPLAY", "true"); await db.exec("begin"); io.query.mockClear(); io.ensure.mockReset().mockResolvedValue(false); });
afterEach(async () => { await db.exec("rollback"); vi.unstubAllEnvs(); });
afterAll(async () => { await db?.close(); });

describe("pure bounded chart formatter", () => {
  it("matches drawChart across 512 seeded descriptions, styles, measures and calendar ranges", () => {
    for (let seed = 0; seed < 512; seed++) {
      const records = fixture(seed), base = queries[seed % queries.length];
      const query: ChartQuery = { ...base, measure: (["spending", "income", "net"] as const)[seed % 3], style: ([undefined, "bar", "line", "table", "donut"] as const)[seed % 5], category: seed % 7 === 0 ? "Transport" : base.category, compare: seed % 4 !== 0 };
      const today = seed % 11 === 0 ? "2026-03-31" : TODAY, resolved = planChart(query, today), expected = drawChart({ query, transactions: records, userId: OWNER, currency: "GHS", today });
      expect(resolved.ok).toBe(expected.ok);
      if (resolved.ok && expected.ok) expect(formatChartFacts(resolved.plan, chartFactsForPlan(resolved.plan, records, OWNER, "GHS", today), "GHS", today)).toEqual(expected.chart);
    }
  });
});

describe("source-free durable pinned chart SQL", () => {
  it("matches all eight chart descriptions in one fresh publication query", async () => {
    const transactions = await publish(), selected = pins();
    const result = await readDurablePinnedCharts(settings, profile, TODAY, selected);
    expect(result?.data).toEqual(selected.flatMap(pin => { const chart = drawChart({ query: pin.query, transactions, userId: OWNER, currency: "GHS", today: TODAY }); return chart.ok ? [{ id: pin.id, chart: chart.chart }] : []; }));
    expect(io.query).toHaveBeenCalledOnce();
    expect(result?.data[1].chart.rows.length).toBeLessThanOrEqual(8);
    expect(JSON.stringify(result?.data)).not.toMatch(/transactionOrdinal|merchantLabelRank|sourceText|sourceFingerprint/);
  });
  it("preserves Unicode collation ties, first merchant labels, and previous-only merchant remainder totals", async () => {
    const transactions = await publish();
    for (const compare of [true, false]) {
      const selected = pins([{ measure: "spending", by: "merchant", period: "this_month", compare }]);
      const actual = await readDurablePinnedCharts(settings, profile, TODAY, selected), expected = drawChart({ query: selected[0].query, transactions, userId: OWNER, currency: "GHS", today: TODAY });
      expect(actual?.data[0].chart).toEqual(expected.ok ? expected.chart : null);
      const rest = actual?.data[0].chart.rows.find(row => /^\d+ more$/.test(row.label)); expect(rest).toBeDefined(); expect(rest).not.toHaveProperty("previous");
    }
  });
  it("matches 64 additional seeded SQL histories without transferring historical transaction details", async () => {
    for (let seed = 0; seed < 64; seed++) {
      const transactions = await publish(fixture(seed));
      const selected = pins(queries.map((query, index) => ({ ...query, measure: (["spending", "income", "net"] as const)[(index + seed) % 3], compare: (index + seed) % 4 !== 0 })));
      const actual = await readDurablePinnedCharts(settings, profile, TODAY, selected);
      expect(actual?.data).toEqual(selected.map(pin => { const result = drawChart({ query: pin.query, transactions, userId: OWNER, currency: "GHS", today: TODAY }); if (!result.ok) throw new Error(result.message); return { id: pin.id, chart: result.chart }; }));
    }
  }, 30_000);
  it("skips invalid resolved date descriptions, preserves empty pins, and rejects ownership/count mismatches", async () => {
    await publish();
    const selected = pins([{ measure: "spending", by: "day", startDate: "2026-02-30", endDate: "2026-03-01" }]);
    expect((await readDurablePinnedCharts(settings, profile, TODAY, selected))?.data).toEqual([]);
    expect((await readDurablePinnedCharts(settings, profile, TODAY, []))?.data).toEqual([]);
    io.query.mockClear();
    await expect(readDurablePinnedCharts(settings, profile, TODAY, [{ ...pins()[0], ownerId: OTHER }])).rejects.toThrow(/verified/);
    await expect(readDurablePinnedCharts(settings, profile, TODAY, [...pins(), { ...pins()[0], id: "ninth" }])).rejects.toThrow(/verified/);
    expect(io.query).not.toHaveBeenCalled();
  });
  it("does not expose another owner or a missing generation, and skips SQL when disabled", async () => {
    await publish();
    await expect(readDurablePinnedCharts(settings, { ...profile, profileId: OTHER }, TODAY, pins().map(pin => ({ ...pin, ownerId: OTHER })))).rejects.toBeInstanceOf(DurableDisplayUpdating);
    vi.stubEnv("ALFRED_DURABLE_DISPLAY", "false"); io.query.mockClear();
    expect(await readDurablePinnedCharts(settings, profile, TODAY, pins())).toBeNull(); expect(io.query).not.toHaveBeenCalled();
  });
  it("rejects a pre-metadata merchant generation rather than grouping missing keys into a false total", async () => {
    await publish();
    await db.query("update alfred_display.rows set payload=payload-array['merchantKey','merchantLabelRank'] where owner_id=$1::uuid and kind='ledger'", [OWNER]);
    await expect(readDurablePinnedCharts(settings, profile, TODAY, pins([queries[1]]))).rejects.toThrow("could not be verified");
  });
});
