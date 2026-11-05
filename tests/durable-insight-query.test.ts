import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseSettings, UserProfile } from "@/lib/config";
import { DatabaseError } from "@/lib/errors";
import { buildAccountingDisplayModel } from "@/lib/finance/accounting/display-builder";
import { displayRowsForPublication } from "@/lib/finance/accounting/display-worker";
import { ACCOUNTING_DISPLAY_DEFINITION } from "@/lib/finance/accounting/display-model";
import { DurableDisplayUpdating } from "@/lib/finance/accounting/durable-read";
import { loadAccountingProjectionSource, type AccountingResult } from "@/lib/finance/accounting/persisted-store";
import { sourceMovements } from "@/lib/finance/accounting/sources";
import { emptyAccountingState, type CashMovement } from "@/lib/finance/accounting/types";
import { projectAccountingTransactions } from "@/lib/finance/accounting/view";
import { buildInsights } from "@/lib/finance/insights";
import { detectRenewalCandidates } from "@/lib/finance/bill-renewals";
import { buildDisplayInsightFacts, buildDisplayRenewalFacts, formatDisplayInsights, formatDisplayRenewals } from "@/lib/finance/display-insight-facts";
import { addDays, endOfMonth } from "@/lib/finance/dates";
import { toMinor } from "@/lib/finance/money";
import type { BillRecord } from "@/lib/finance/bills";
import type { BudgetRecord, TransactionRecord } from "@/lib/finance/types";
import { readDurableInsightFacts } from "@/lib/web/durable-insight-query";

const backend = vi.hoisted(() => ({ query: vi.fn(), ensureFresh: vi.fn() }));
vi.mock("@/lib/supabase/connection", () => ({ query: backend.query }));
vi.mock("@/lib/finance/accounting/display-worker", async original => ({ ...await original<typeof import("@/lib/finance/accounting/display-worker")>(), ensureFreshDisplay: backend.ensureFresh }));
const OWNER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", OTHER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd", AT = "2026-11-05T12:00:00.000Z";
const profile = { profileId: OWNER, currency: "GHS", timezone: "Africa/Accra" } as UserProfile;
const settings = {} as SupabaseSettings;
let db: PGlite, forbidSources = false;
const row = (id: string, patch: Partial<TransactionRecord> = {}): TransactionRecord => ({ transactionId: id, createdAt: AT, transactionDate: "2026-11-01", userId: OWNER, type: "expense", amount: "10.00", currency: "GHS", category: "Food", description: `Fictional ${id}`, paymentMethod: "Fictional cash", notes: "", status: "active", updatedAt: AT, sourceUpdateId: id, rowNumber: 0, ...patch });
const bill = (name: string): BillRecord => ({ id: `fictional:${name}`, ownerId: OWNER, name, nextDate: "2026-12-01", amount: "10.00", currency: "GHS", cadence: "monthly", active: true, createdAt: AT, updatedAt: AT });
const budgets = (month = "2026-11"): BudgetRecord[] => ["Food", "Transport", "Fees", "Savings", "Utilities", "Shopping"].map(category => ({ budgetId: `fictional:${category}`, userId: OWNER, period: month, category, amount: "100.00", currency: "GHS", createdAt: AT, updatedAt: AT, rowNumber: 0 }));
const imported = (id: string, patch: Partial<CashMovement> = {}): CashMovement => ({ id, ownerId: OWNER, accountId: "cash", direction: "out", status: "confirmed", sourceStatus: "confirmed", amountMinor: 10000, feeMinor: 0, currency: "GHS", date: "2026-11-01", occurredAt: AT, category: "Shopping", description: `Fictional ${id}`, sourceId: `source:${id}`, sourceKind: "bank", sourceFingerprint: `fingerprint:${id}`, legacyTransactionId: null, feeTransactionId: null, legacyClassification: null, importProvenance: { namespace: "fictional", sourceId: id }, ...patch });
function canonical(raw: TransactionRecord[], ownerId = OWNER): AccountingResult {
  return { state: { ...emptyAccountingState(ownerId), accounts: [{ id: "cash", label: "Fictional cash", provider: "Fictional", currency: "GHS", includeInCash: true, createdAt: AT }], movements: sourceMovements(ownerId, raw, []) }, rawTransactions: raw, availability: "ready", sourceVersion: "fictional-stable-source" };
}
function richFixture(): AccountingResult {
  const raw = [
    row("first-repeat:0", { description: " First Label ", amount: "5.00" }), row("first-repeat:1", { description: "FIRST LABEL", amount: "5.00" }), row("first-repeat:2", { description: "first label", amount: "5.00" }),
    row("second-repeat:0", { description: "Second Label", amount: "5.00" }), row("second-repeat:1", { description: "SECOND LABEL", amount: "5.00" }), row("second-repeat:2", { description: " second label ", amount: "5.00" }),
    row("unicode:0", { description: "İSTANBUL café", amount: "2.00" }), row("unicode:1", { description: "i̇stanbul CAFÉ", amount: "2.00" }), row("unicode:2", { description: " i̇stanbul café ", amount: "2.00" }),
    row("old-usd", { transactionDate: "2025-01-02", currency: "USD", amount: "8.00" }), row("prior", { transactionDate: "2026-10-03", amount: "17.00" }),
    ...["2026-08-31", "2026-09-30", "2026-10-31"].map((transactionDate, i) => row(`netflix:${i}`, { transactionDate, description: "Netflix", amount: "12.00" })),
    ...["2026-09-01", "2026-10-01", "2026-10-01", "2026-10-01", "2026-11-01"].map((transactionDate, i) => row(`spotify:${i}`, { transactionDate, description: "Spotify", amount: i === 0 ? "9.00" : i === 3 ? "10" : "10.00" })),
    row("water-custom:0", { transactionDate: "2026-09-01", description: "water", category: "Utilities" }), row("water-known:0", { transactionDate: "2026-10-01", description: "Ghana Water", category: "Utilities" }),
    row("water-custom:1", { transactionDate: "2026-10-01", description: "water", category: "Utilities" }), row("water-known:1", { transactionDate: "2026-11-01", description: "Ghana Water", category: "Utilities" }),
    row("future-month-expense", { transactionDate: "2026-11-25", description: "Future Netflix", amount: "15.00" }), row("deleted", { status: "deleted", amount: "999.00" }),
    row("signed", { transactionDate: "2026-11-02", amount: "-7.00" }), row("income", { type: "income", category: "Salary", amount: "500.00" }), row("fee:1", { category: "Fees", amount: "0.50" }), row("fee:2", { category: "Fees", amount: "1.00" }),
  ];
  const result = canonical(raw);
  result.state.accounts.push({ id: "reserve", label: "Fictional reserve", provider: "Fictional", currency: "GHS", includeInCash: true, createdAt: AT });
  result.state.movements.push(imported("original", { feeMinor: 200, taxMinor: 50 }), imported("refund", { direction: "in", date: "2026-11-02", amountMinor: 4000 }),
    imported("loan", { amountMinor: 7000, feeMinor: 75 }), imported("repayment", { direction: "in", date: "2026-11-02", amountMinor: 2000 }),
    imported("transfer-out", { status: "transfer", amountMinor: 20000, feeMinor: 50 }), imported("transfer-in", { status: "transfer", accountId: "reserve", direction: "in", amountMinor: 20000 }),
    imported("review:first", { status: "review", accountId: null }), imported("review:second", { status: "review", accountId: null }), imported("not-review", { status: "hold", accountId: null }));
  const ref = (id: string) => ({ movementId: id, sourceFingerprint: `fingerprint:${id}` });
  result.state.settlements = [{ id: "fictional-refund", kind: "refund", original: ref("original"), returns: [{ ...ref("refund"), principalMinor: 4000 }], createdAt: AT }, { id: "fictional-loan", kind: "loan", original: ref("loan"), returns: [{ ...ref("repayment"), principalMinor: 2000 }], createdAt: AT }];
  result.state.transfers = [{ id: "fictional-transfer", outgoing: ref("transfer-out"), incoming: ref("transfer-in"), createdAt: AT }];
  return result;
}
async function publish(source: AccountingResult | (() => Promise<AccountingResult>)) {
  const ownerId = typeof source === "function" ? OWNER : source.state.ownerId, token = randomUUID();
  await db.query("select alfred_display.enqueue($1::uuid,$2::text)", [ownerId, ACCOUNTING_DISPLAY_DEFINITION]);
  const job = (await db.query<{ result: { ownerId: string } }>("select alfred_display.claim($1::text,$2::uuid,120) as result", [ACCOUNTING_DISPLAY_DEFINITION, token])).rows[0].result;
  expect(job.ownerId).toBe(ownerId);
  const baseline = (await db.query<{ result: unknown }>("select alfred_display.capture($1::uuid,$2::text,$3::uuid) as result", [ownerId, ACCOUNTING_DISPLAY_DEFINITION, token])).rows[0].result;
  const result = typeof source === "function" ? await source() : source;
  const model = buildAccountingDisplayModel(result);
  const saved = (await db.query<{ result: { status: string } }>("select alfred_display.publish($1::uuid,$2::text,$3::uuid,$4::jsonb,$5::jsonb,$6::jsonb) as result", [ownerId, ACCOUNTING_DISPLAY_DEFINITION, token, JSON.stringify(baseline), JSON.stringify(model.manifest), JSON.stringify(displayRowsForPublication(model.rows))])).rows[0].result;
  expect(saved.status).toBe("saved"); return result;
}
async function assertParity(result: AccountingResult, today = "2026-11-05", savedBills: BillRecord[] = []) {
  const transactions = projectAccountingTransactions(result.rawTransactions, result.state), input = { userId: result.state.ownerId, currency: "GHS", range: { start: `${today.slice(0, 7)}-01`, end: endOfMonth(today) }, today, transactions, budgets: budgets(today.slice(0, 7)) };
  const bundle = await readDurableInsightFacts(settings, { ...profile, profileId: result.state.ownerId }, today, savedBills, ["review:first", "not-review", "not-found"]);
  expect(bundle).not.toBeNull();
  expect(formatDisplayInsights(bundle!.data.insights, input.budgets)).toEqual(buildInsights(input));
  expect(bundle!.data.renewals).toEqual(buildDisplayRenewalFacts(transactions, savedBills, today, "GHS"));
  expect(formatDisplayRenewals(bundle!.data.renewals, today, "GHS")).toEqual(detectRenewalCandidates(transactions, savedBills, today, "GHS"));
  const oracle = buildDisplayInsightFacts(input);
  expect(bundle!.data.insights).toMatchObject({ ownerId: oracle.ownerId, currency: oracle.currency, range: oracle.range, today: oracle.today, expenseCount: oracle.expenseCount, spentMinor: oracle.spentMinor, incomeMinor: oracle.incomeMinor, repeats: oracle.repeats, fees: oracle.fees, biggest: oracle.biggest, weekend: oracle.weekend });
  const expected = new Map<string, number>();
  for (const tx of transactions.filter(tx => tx.status === "active" && tx.type === "expense")) {
    const key = JSON.stringify([tx.transactionDate.slice(0, 7), tx.currency, tx.category]); expected.set(key, (expected.get(key) ?? 0) + toMinor(tx.amount));
  }
  expect(new Map(bundle!.data.budgetSpending.map(fact => [JSON.stringify([fact.period, fact.currency, fact.category]), fact.spentMinor]))).toEqual(expected);
  const expectedDays = new Map<string, number>();
  for (const tx of transactions.filter(tx => tx.status === "active" && tx.type === "expense" && tx.currency === "GHS" && tx.transactionDate >= input.range.start && tx.transactionDate <= today)) expectedDays.set(tx.transactionDate, (expectedDays.get(tx.transactionDate) ?? 0) + toMinor(tx.amount));
  expect(new Map(bundle!.data.days.map(fact => [fact.date, fact.minor]))).toEqual(expectedDays);
  return bundle!;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec("create role anon;create role authenticated;create schema auth;create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}'::jsonb);");
  for (const file of readdirSync("supabase/migrations").filter(file => file.endsWith(".sql")).sort()) await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
  await db.query("insert into auth.users(id) values($1::uuid),($2::uuid)", [OWNER, OTHER]);
  backend.query.mockImplementation(async (_settings: SupabaseSettings, sql: string, values: unknown[] = []) => {
    if (forbidSources && /\b(?:transactions|bank_messages|imported_finance_sources|accounting_states|account_rule_states)\b|alfred_accounting_source_version/i.test(sql)) throw new Error("Durable fact read unexpectedly loaded source history.");
    return (await db.query(sql, values)).rows;
  });
}, 30_000);
beforeEach(async () => { vi.stubEnv("ALFRED_DURABLE_DISPLAY", "true"); forbidSources = false; await db.exec("begin"); backend.query.mockClear(); backend.ensureFresh.mockReset().mockResolvedValue(false); });
afterEach(async () => { await db.exec("rollback"); vi.unstubAllEnvs(); });
afterAll(async () => { await db?.close(); });

describe("actual normalized insight/renewal SQL and publication", () => {
  it("publishes actual canonical model rows and preserves aggregate facts, linked adjustments and bounded review/day data", async () => {
    const result = richFixture(); await publish(result); forbidSources = true; backend.query.mockClear();
    const bundle = await assertParity(result);
    expect(bundle.data.reviewIds).toEqual(["review:first"]); expect(bundle.data.days.length).toBeLessThanOrEqual(31);
    expect(bundle.data.renewals.every(group => group.recentDates.length <= 4 && group.recentPayments.length <= 4)).toBe(true);
    expect(bundle.data.insights.repeats).toHaveLength(2);
    expect(JSON.stringify(bundle.data)).not.toMatch(/sourceFingerprint|sourceText|sourceUpdateId|recentPayments.*fictional-refund/);
    expect(backend.query).toHaveBeenCalledOnce();
  });

  it("uses the complete real source-coherent loader before building and publishing", async () => {
    await db.query(`insert into transactions(owner_id,transaction_id,created_at,transaction_date,user_id,type,amount,currency,category,description,status,updated_at,source_update_id)
      select $1::uuid,('10000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,$2::timestamptz,'2026-11-01',$1::text,'expense',n,'GHS','Food','Fictional loaded source '||n,'active',$2::timestamptz,'fixture:'||n from generate_series(1,3) n`, [OWNER, AT]);
    // Capture finishes before the complete uncached canonical loader starts, as in the worker.
    const result = await publish(() => loadAccountingProjectionSource(settings, OWNER));
    expect(result.state.movements).toHaveLength(3); forbidSources = true; backend.query.mockClear();
    const bundle = await assertParity(result);
    expect(bundle.data.insights).toMatchObject({ expenseCount: 3, spentMinor: 600 }); expect(backend.query).toHaveBeenCalledOnce();
  });

  it.each([[], ["water"], [" WATER BILL "], ["water", "Water bill"]].map(names => [names]))("excludes fresh saved bill names per row before colliding service groups (%j)", async names => {
    const result = richFixture(); await publish(result); const bundle = await assertParity(result, "2026-11-05", names.map(bill));
    expect(bundle.data.renewals.every(group => group.recentDates.length <= 4 && group.recentPayments.length <= 4)).toBe(true);
  });

  it("never joins foreign owner, wrong definition or stale token/epoch rows", async () => {
    const result = richFixture(); await publish(result);
    const other = canonical([row("foreign", { userId: OTHER, amount: "999.00", category: "Foreign secret" })], OTHER); await publish(other);
    await db.query(`insert into alfred_display.rows(owner_id,definition,token,epoch,kind,id,ordinal,date,currency,category,direction,amount_minor,payload)
      select owner_id,case when n=1 then 'wrong-definition' else definition end,case when n=2 then token+1 else token end,case when n=3 then epoch+1 else epoch end,
        kind,id||':shadow:'||n,ordinal+100000*n,date,currency,'Stale secret','out',999999,payload||'{"category":"Stale secret"}'::jsonb
      from alfred_display.rows cross join generate_series(1,3) n where owner_id=$1::uuid and kind='ledger' and ordinal=(select min(ordinal) from alfred_display.rows where owner_id=$1::uuid and kind='ledger')`, [OWNER]);
    const bundle = await assertParity(result); expect(JSON.stringify(bundle.data)).not.toContain("secret");
  });

  it("keeps a missing generation unavailable and enqueues it rather than inventing empty facts", async () => {
    await expect(readDurableInsightFacts(settings, profile, "2026-11-05", [])).rejects.toBeInstanceOf(DurableDisplayUpdating);
    expect((await db.query("select owner_id::text from alfred_display.jobs where owner_id=$1::uuid", [OWNER])).rows).toEqual([{ owner_id: OWNER }]);
    expect(backend.ensureFresh).toHaveBeenCalledOnce();
  });

  it("skips all SQL when disabled and rejects excessive review selections before reading", async () => {
    vi.stubEnv("ALFRED_DURABLE_DISPLAY", "false");
    await expect(readDurableInsightFacts(settings, profile, "2026-11-05", [])).resolves.toBeNull(); expect(backend.query).not.toHaveBeenCalled();
    await expect(readDurableInsightFacts(settings, profile, "2026-11-05", [], Array.from({ length: 21 }, (_, n) => `review:${n}`))).rejects.toThrow();
    expect(backend.query).not.toHaveBeenCalled();
  });

  it("falls back only for an absent additive schema and propagates ready-schema failures", async () => {
    backend.query.mockRejectedValueOnce(new DatabaseError("Schema absent", "3F000")).mockResolvedValueOnce([{ ready: false }]);
    await expect(readDurableInsightFacts(settings, profile, "2026-11-05", [])).resolves.toBeNull();
    backend.query.mockRejectedValueOnce(new DatabaseError("Reader unavailable", "08006"));
    await expect(readDurableInsightFacts(settings, profile, "2026-11-05", [])).rejects.toThrow("Reader unavailable");
  });

  it("matches 512 seeded SQL histories against the unchanged insight and renewal oracles", async () => {
    const categories = ["Food", "Transport", "Fees", "Taxes", "Savings", "Utilities", "Subscriptions", "Rent & home"];
    const descriptions = [" First ", "FIRST", "Second", "Netflix", "Spotify", "water", "Ghana water", "Fictional rent", "İSTANBUL", "i̇stanbul"];
    const months = ["2026-11-01", "2024-02-01", "2026-01-01", "2026-10-01"];
    for (let seed = 0; seed < 512; seed++) {
      let state = seed + 1; const random = (max: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % max; };
      const month = months[seed % months.length], today = addDays(month, seed % 28);
      const raw = Array.from({ length: 48 }, (_, n) => row(`seed:${seed}:${n}`, { transactionDate: addDays(month, random(130) - 60), amount: ((random(4500) - 500) / 100).toFixed(2), category: categories[random(categories.length)], description: descriptions[random(descriptions.length)], currency: random(9) ? "GHS" : "USD", type: random(5) ? "expense" : "income", status: random(17) ? "active" : "deleted" }));
      const result = canonical(raw); await publish(result); await assertParity(result, today, seed % 3 === 0 ? [bill("water")] : seed % 3 === 1 ? [bill("Water bill")] : []);
    }
  }, 120_000);
});
