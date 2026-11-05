import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAccountsModel } from "@/lib/finance/accounting/accounts-model";
import { tryLoadDurableSubscriptions } from "@/lib/finance/accounting/durable-subscriptions";
import { ACCOUNTING_DISPLAY_DEFINITION } from "@/lib/finance/accounting/display-model";
import { subscriptionsData } from "@/app/accounts/subscriptions-data";
import { loadAccountSubscriptionsView } from "@/app/accounts/subscriptions-actions";
import { emptyAccountingState, type AccountingState, type CashMovement } from "@/lib/finance/accounting/types";
import type { BillRecord } from "@/lib/finance/bills";
import type { SupabaseSettings } from "@/lib/config";

const backend = vi.hoisted(() => ({ query: vi.fn(), full: vi.fn(), owner: vi.fn(), bills: vi.fn() }));
vi.mock("@/lib/supabase/connection", () => ({ query: backend.query }));
vi.mock("@/lib/finance/accounting/persisted-store", () => ({ loadAccountingReadModel: backend.full }));
vi.mock("@/lib/web/api", () => ({ requireOwner: backend.owner }));
vi.mock("@/lib/finance/bills", async original => ({ ...await original<typeof import("@/lib/finance/bills")>(), createSupabaseBillStore: () => ({ list: backend.bills }) }));
const OWNER = "10000000-0000-4000-8000-000000000001", OTHER = "10000000-0000-4000-8000-000000000002", TODAY = "2026-11-06", AT = "2026-01-01T12:00:00.000Z";
const settings = {} as SupabaseSettings;
let db: PGlite;
function fixture(): AccountingState {
  const state = emptyAccountingState(OWNER);
  state.accounts = [{ id: "fictional-cash", label: "Fictional cash", provider: "Fictional", currency: "GHS", includeInCash: true, createdAt: AT }];
  function add(description: string, date: string, patch: Partial<CashMovement> = {}) {
    const id = `fictional-payment:${String(state.movements.length).padStart(3,"0")}`;
    const row: CashMovement = { id, ownerId: OWNER, accountId: "fictional-cash", direction: "out", status: "confirmed", amountMinor: 1000, feeMinor: 30, taxMinor: 10,
      currency: "GHS", date, occurredAt: `${date}T12:00:00.000Z`, description, category: "Subscriptions", sourceId: id, sourceKind: "manual", sourceFingerprint: id,
      sourceText: "Fictional raw evidence must not leave SQL", legacyTransactionId: null, feeTransactionId: null, legacyClassification: null, ...patch };
    state.movements.push(row); return row;
  }
  for (const month of ["08","09","10","11"]) {
    add("Netflix fictional subscription", `2026-${month}-05`);
    add("Water", `2026-${month}-03`, { category: "Utilities", amountMinor: 800 });
    add("Ghana water fictional service", `2026-${month}-03`, { category: "Utilities", amountMinor: 900 });
  }
  add("Netflix fictional same day", "2026-11-05", { amountMinor: 1250 });
  add("Netflix fictional future", "2026-12-05");
  add("Netflix fictional incoming", "2026-11-05", { direction: "in" });
  add("Netflix fictional refund", "2026-11-05", { direction: "in", legacyClassification: "refund" });
  add("Netflix fictional review fees", "2026-11-05", { sourceKind: "bank", status: "review", confirmedFeeMinor: 30, feeTransactionId: "fictional-fee" });
  const one = add("Spotify fully refunded", "2026-10-05", { amountMinor: 500 });
  const back = add("Fictional return", "2026-10-06", { direction: "in", amountMinor: 500, feeMinor: 0, taxMinor: 0 });
  const loan = add("Figma fictional loan", "2026-11-05");
  state.settlements = [{ id: "fictional-refund", kind: "refund", original: { movementId: one.id, sourceFingerprint: one.sourceFingerprint }, returns: [{ movementId: back.id, sourceFingerprint: back.sourceFingerprint, principalMinor: 500 }], createdAt: AT },
    { id: "fictional-loan", kind: "loan", original: { movementId: loan.id, sourceFingerprint: loan.sourceFingerprint }, returns: [], createdAt: AT }];
  state.accounts.push({ ...state.accounts[0], id: "fictional-usd", currency: "USD" });
  add("Netflix fictional USD", "2026-10-05", { accountId: "fictional-usd", currency: "USD" });
  add("Netflix fictional USD", "2026-11-05", { accountId: "fictional-usd", currency: "USD" });
  return state;
}
const bill = (name: string): BillRecord => ({ id: `fictional-bill:${name}`, ownerId: OWNER, name, nextDate: "2026-12-01", amount: "10.00", currency: "GHS", cadence: "monthly", active: true, createdAt: AT, updatedAt: AT });
async function seed(state = fixture()) {
  const { manifest, rows } = buildAccountsModel({ state, availability: "ready", sourceVersion: "fictional-version", rawTransactions: [] });
  await db.query("insert into alfred_display.test_publications(owner_id,publication) values($1::uuid,$2::jsonb) on conflict(owner_id) do update set publication=excluded.publication", [state.ownerId, JSON.stringify({ token: "1", epoch: "1", manifest: { kind: "accounting-display", projectorVersion: 1, ownerId: state.ownerId, revision: 0, sourceVersion: "fictional-version", accounts: manifest } })]);
  await db.query("delete from alfred_display.rows where owner_id=$1::uuid", [state.ownerId]);
  await db.query(`insert into alfred_display.rows select $1::uuid,$2::text,1,1,r.* from jsonb_to_recordset($3::jsonb) r(kind text,id text,ordinal bigint,payload jsonb)`, [state.ownerId, ACCOUNTING_DISPLAY_DEFINITION, JSON.stringify(rows.map(({ kind,id,ordinal,payload }) => ({ kind,id,ordinal,payload })))]);
}
beforeAll(async () => {
  db = new PGlite();
  // Consumption fixture only: the actual migration/cohort publication protocol has independent real-Postgres tests.
  await db.exec(`create schema alfred_display;
    create table alfred_display.rows(owner_id uuid,definition text,token bigint,epoch bigint,kind text,id text,ordinal bigint,payload jsonb);
    create table alfred_display.test_publications(owner_id uuid primary key,publication jsonb);
    create function alfred_display.manifest(owner uuid,definition text) returns jsonb language sql stable as $$ select publication from alfred_display.test_publications where owner_id=owner $$;`);
  backend.query.mockImplementation(async (_settings, sql: string, values: unknown[] = []) => {
    if (/public\.(transactions|bank_messages|accounting_states|account_rule_states|imported_finance_sources)|alfred_accounting_source_version/.test(sql)) throw new Error("Complete source reads are forbidden on a durable subscription hit.");
    return (await db.query(sql, values)).rows;
  });
}, 30_000);
beforeEach(async () => {
  vi.stubEnv("ALFRED_DURABLE_DISPLAY", "true"); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(`${TODAY}T12:00:00.000Z`));
  await seed(); backend.query.mockClear(); backend.full.mockReset().mockRejectedValue(new Error("Full source read forbidden")); backend.bills.mockReset().mockResolvedValue([]);
  backend.owner.mockReset().mockResolvedValue({ profile: { profileId: OWNER, currency: "GHS", timezone: "Africa/Accra" }, settings: { supabase: settings } });
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
afterAll(async () => { await db?.close(); });

describe("source-free Accounts primary-payment renewal facts", () => {
  it.each([[], [bill("Netflix")], [bill("water")], [bill("Water bill")], [bill("Netflix"),bill("Water bill")]])("matches the exact Accounts oracle with fresh saved bills %j", async bills => {
    const actual = await tryLoadDurableSubscriptions(settings, OWNER, "GHS", TODAY, bills);
    expect(actual).toEqual(subscriptionsData({ bills, today: TODAY, currency: "GHS" }, fixture()));
    expect(backend.query).toHaveBeenCalledOnce(); expect(JSON.stringify(actual)).not.toContain("Fictional raw evidence");
  });
  it("preserves currency and request-local calendar changes without rebuilding the model", async () => {
    for (const [currency,today] of [["USD",TODAY],["GHS","2026-11-30"],["GHS","2026-12-06"],["EUR",TODAY]]) {
      expect(await tryLoadDurableSubscriptions(settings, OWNER, currency, today, [])).toEqual(subscriptionsData({ bills: [], today, currency }, fixture()));
    }
    expect(backend.query).toHaveBeenCalledTimes(4);
  });
  it("keeps primary-only values and never treats separate fees, taxes, loans or fully refunded payments as renewals", async () => {
    const result = await tryLoadDurableSubscriptions(settings, OWNER, "GHS", TODAY, []);
    expect(result!.suggestions.map(row => row.name)).not.toContain("Spotify"); expect(result!.suggestions.map(row => row.name)).not.toContain("Figma");
    const netflix = result!.suggestions.find(row => row.id === "netflix")!;
    expect(netflix.paymentCount).toBe(5); expect(netflix.lastAmount).toBe("12.50"); expect(netflix.variableAmount).toBe(true);
    expect(result!.suggestions.every(row => row.lastAmount !== "0.30" && row.lastAmount !== "0.10")).toBe(true);
  });
  it("the authenticated deferred action reads fresh bill definitions but no complete accounting sources", async () => {
    const bills = [bill("Netflix")]; backend.bills.mockResolvedValue(bills);
    expect(await loadAccountSubscriptionsView()).toEqual({ ok: true, ownerId: OWNER, data: subscriptionsData({ bills, today: TODAY, currency: "GHS" }, fixture()) });
    expect(backend.bills).toHaveBeenCalledExactlyOnceWith(OWNER); expect(backend.full).not.toHaveBeenCalled(); expect(backend.query).toHaveBeenCalledOnce();
  });
  it("rejects an older incomplete projection instead of returning false empty suggestions", async () => {
    await db.query("update alfred_display.test_publications set publication=publication#-'{manifest,accounts,subscriptionFactsVersion}' where owner_id=$1", [OWNER]);
    await expect(tryLoadDurableSubscriptions(settings, OWNER, "GHS", TODAY, [])).rejects.toThrow("could not be verified");
  });
  it("keeps owner data isolated and performs no query when disabled", async () => {
    const other = fixture(); other.ownerId = OTHER; other.movements = other.movements.map(row => ({ ...row, ownerId: OTHER, description: "Foreign private service" })); await seed(other);
    const actual = await tryLoadDurableSubscriptions(settings, OWNER, "GHS", TODAY, []);
    expect(actual).toEqual(subscriptionsData({ bills: [], today: TODAY, currency: "GHS" }, fixture()));
    vi.stubEnv("ALFRED_DURABLE_DISPLAY", "false"); backend.query.mockClear();
    expect(await tryLoadDurableSubscriptions(settings, OWNER, "GHS", TODAY, [])).toBeNull(); expect(backend.query).not.toHaveBeenCalled();
  });
});
