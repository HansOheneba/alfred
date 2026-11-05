import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyActivityFilters, type ActivityFilters } from "@/app/accounts/activity-tools";
import type { SupabaseSettings } from "@/lib/config";
import { buildAccountsModel } from "@/lib/finance/accounting/accounts-model";
import { tryLoadDurableAccountsView } from "@/lib/finance/accounting/durable-accounts";
import { ACCOUNTING_DISPLAY_DEFINITION, type DurableModelRow } from "@/lib/finance/accounting/display-model";
import { projectAccountsReadView, type AccountsReadQuery } from "@/lib/finance/accounting/read-view";
import { emptyAccountingState, type AccountingState, type CashMovement } from "@/lib/finance/accounting/types";

const backend = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/supabase/connection", () => ({ query: backend.query }));
const OWNER = "10000000-0000-4000-8000-000000000001", OTHER = "10000000-0000-4000-8000-000000000002";
const AT = "2026-11-05T12:00:00.000Z", SOURCE = "fictional-source-version";
const settings = {} as SupabaseSettings;
let db: PGlite;
function fixture(ownerId = OWNER): AccountingState {
  const state = emptyAccountingState(ownerId);
  state.revision = 7;
  state.accounts = ["cash", "reserve", "usd", "missing"].map(id => ({ id, label: `Fictional ${id}`, provider: "Fictional", currency: id === "usd" ? "USD" : "GHS", includeInCash: id !== "reserve", createdAt: AT }));
  state.movements = Array.from({ length: 91 }, (_, index): CashMovement => {
    const occurredAt = new Date(Date.parse(AT) + Math.floor(index / 6) * 3_600_000).toISOString();
    const currency = index % 8 === 0 ? "USD" : "GHS";
    const description = ["Fictional shop", "Café 100%_İstanbul", "Line\nbreak vendor", "(Literal)[shop]"][index % 4];
    const feeMinor = index % 3 === 0 ? 25 : 0;
    return { id: `fictional-movement:${index}`, ownerId, accountId: index % 5 === 0 ? null : currency === "USD" ? "usd" : index % 2 ? "reserve" : "cash",
      direction: index % 2 ? "in" : "out", status: index % 5 === 0 ? "review" : index % 11 === 0 ? "hold" : "confirmed", amountMinor: 1000 + index % 5 * 100, feeMinor,
      taxMinor: index % 4 === 0 ? 10 : 0, currency, date: occurredAt.slice(0, 10), occurredAt: index % 17 === 0 ? null : occurredAt, description,
      category: index % 3 ? "Food" : "Transport", sourceCategory: index % 3 ? "Food" : "Transport", sourceId: `fictional-source:${index}`, sourceKind: "bank", sourceFingerprint: `fictional-fingerprint:${index}`,
      feeTransactionId: feeMinor ? `fictional-fee:${index}` : null, confirmedFeeMinor: feeMinor ? 20 : 0,
      legacyTransactionId: null, legacyClassification: null, sourceText: `Fictional original alert ${index}.` };
  });
  function confirmed(index: number, direction: "in" | "out", amountMinor: number, accountId = "cash") {
    Object.assign(state.movements[index], { direction, amountMinor, accountId, currency: "GHS", status: "confirmed", sourceStatus: "confirmed", date: "2026-11-05", occurredAt: AT });
  }
  confirmed(0, "out", 5000); confirmed(1, "in", 5000, "reserve");
  confirmed(2, "out", 10000); confirmed(3, "in", 3000); confirmed(5, "in", 3000);
  confirmed(4, "out", 6000); confirmed(7, "in", 2000);
  confirmed(12, "out", 1000); confirmed(13, "in", 1000);
  Object.assign(state.movements[12], { feeMinor: 0, taxMinor: 0, confirmedFeeMinor: 0, feeTransactionId: null, category: "Fully refunded" });
  Object.assign(state.movements[13], { feeMinor: 0, taxMinor: 0, confirmedFeeMinor: 0, feeTransactionId: null });
  Object.assign(state.movements[10], { legacyClassification: "loan", status: "confirmed" });
  Object.assign(state.movements[11], { legacyClassification: "refund", status: "confirmed", direction: "in", category: "Legacy refund" });
  const ref = (index: number) => ({ movementId: state.movements[index].id, sourceFingerprint: state.movements[index].sourceFingerprint });
  state.transfers = [{ id: "fictional-transfer", outgoing: ref(0), incoming: ref(1), createdAt: AT }];
  state.settlements = [{ id: "fictional-refund", kind: "refund", original: ref(2), returns: [{ ...ref(3), principalMinor: 1000 }, { ...ref(5), principalMinor: 500 }], createdAt: AT },
    { id: "fictional-loan", kind: "loan", original: ref(4), returns: [{ ...ref(7), principalMinor: 1000 }], createdAt: AT },
    { id: "fictional-full-refund", kind: "refund", original: ref(12), returns: [{ ...ref(13), principalMinor: 1000 }], createdAt: AT }];
  state.snapshots = Array.from({ length: 61 }, (_, index) => ({ id: `fictional-snapshot:${index}`, accountId: "cash", balanceMinor: 100000 + index,
    occurredAt: new Date(Date.parse(AT) + Math.floor(index / 3) * 60_000).toISOString(), sourceId: `fictional-statement:${index}`, sourceMovementId: null }));
  state.snapshots.push({ id: "fictional-usd-opening", accountId: "usd", balanceMinor: 5000, occurredAt: AT, sourceId: "manual-usd", sourceMovementId: null });
  state.snapshots.push({ id: "fictional-stale", accountId: "cash", balanceMinor: 999999, occurredAt: "2026-12-01T00:00:00.000Z", sourceId: state.movements[0].sourceId, sourceMovementId: state.movements[0].id, sourceFingerprint: "fictional-old" });
  state.audit = [{ id: "fictional-audit", requestId: "fictional-request", action: "update_account", actionFingerprint: "fictional-action", at: AT, revision: 7,
    before: { accounts: state.accounts, movements: state.movements, snapshots: state.snapshots, transfers: state.transfers, settlements: state.settlements } }];
  return state;
}
const query = (changes: Partial<AccountsReadQuery> = {}): AccountsReadQuery => ({ currency: "GHS", section: "activity", page: 0, ...changes });
const canonical = (state: AccountingState, value: AccountsReadQuery, sourceVersion = SOURCE) => projectAccountsReadView({ state, availability: "ready", sourceVersion, rawTransactions: [] }, value);
const fresh = (value: AccountsReadQuery, ownerId = OWNER) => tryLoadDurableAccountsView(settings, ownerId, value);
async function seed(state = fixture(), definition = ACCOUNTING_DISPLAY_DEFINITION, token = "11", sourceVersion = SOURCE) {
  const { manifest, rows } = buildAccountsModel({ state, availability: "ready", sourceVersion, rawTransactions: [] });
  const publication = { token, epoch: "3", manifest: { kind: "accounting-display", projectorVersion: 1, ownerId: state.ownerId, revision: state.revision, sourceVersion,
    accounts: manifest, ledger: { count: 0, earliestDate: null, currencies: [] } } };
  await db.query("insert into alfred_display.test_publications(owner_id,definition,publication) values($1::uuid,$2,$3::jsonb) on conflict(owner_id,definition) do update set publication=excluded.publication,dirty=false", [state.ownerId, definition, JSON.stringify(publication)]);
  await db.query("delete from alfred_display.rows where owner_id=$1::uuid and definition=$2", [state.ownerId, definition]);
  await insertRows(state.ownerId, definition, token, rows);
}
async function insertRows(ownerId: string, definition: string, token: string, rows: DurableModelRow[]) {
  const records = rows.map(row => ({ id: row.id, kind: row.kind, ordinal: row.ordinal, account_id: row.accountId ?? null, date: row.date ?? null, currency: row.currency ?? null,
    category: row.category ?? null, direction: row.direction ?? null, status: row.status ?? null, amount_minor: row.amountMinor ?? null, search_text: row.searchText,
    rank_date_asc: row.rankDateAsc ?? null, rank_date_desc: row.rankDateDesc ?? null, rank_amount_asc: row.rankAmountAsc ?? null, rank_amount_desc: row.rankAmountDesc ?? null,
    needs_attention: row.needsAttention ?? false, group_key: row.groupKey ?? null, relation_id: row.relationId ?? null, payload: row.payload }));
  await db.query(`insert into alfred_display.rows(owner_id,definition,token,epoch,id,kind,ordinal,account_id,date,currency,category,direction,status,amount_minor,search_text,
    rank_date_asc,rank_date_desc,rank_amount_asc,rank_amount_desc,needs_attention,group_key,relation_id,payload)
    select $1::uuid,$2::text,$3::bigint,3,r.* from jsonb_to_recordset($4::jsonb) as r(id text,kind text,ordinal bigint,account_id text,date text,currency text,category text,direction text,status text,
      amount_minor bigint,search_text text,rank_date_asc integer,rank_date_desc integer,rank_amount_asc integer,rank_amount_desc integer,needs_attention boolean,group_key text,relation_id text,payload jsonb)`,
    [ownerId, definition, token, JSON.stringify(records)]);
}

beforeAll(async () => {
  db = new PGlite();
  // Query-consumption fixture only. The real migration's dirty/cohort protocol is tested elsewhere.
  await db.exec(`create schema alfred_display;
    create table alfred_display.rows(owner_id uuid not null,definition text not null,token bigint not null,epoch bigint not null,id text not null,kind text not null,ordinal bigint not null,
      account_id text,date text,currency text,category text,direction text,status text,amount_minor bigint,search_text text not null default '',
      rank_date_asc integer,rank_date_desc integer,rank_amount_asc integer,rank_amount_desc integer,needs_attention boolean not null default false,group_key text,relation_id text,payload jsonb not null,
      primary key(owner_id,definition,kind,ordinal));
    create table alfred_display.test_publications(owner_id uuid,definition text,publication jsonb,dirty boolean not null default false,primary key(owner_id,definition));
    create table alfred_display.test_enqueues(owner_id uuid,definition text);
    create function alfred_display.manifest(owner uuid,wanted text) returns jsonb language sql stable as $$ select publication from alfred_display.test_publications where owner_id=owner and definition=wanted and not dirty $$;
    create function alfred_display.enqueue(owner uuid,wanted text) returns void language sql volatile as $$ insert into alfred_display.test_enqueues values(owner,wanted) $$;
  `);
  backend.query.mockImplementation(async (_settings, sql: string, values: unknown[] = []) => {
    if (/\b(?:public\.)?(?:transactions|bank_messages|imported_finance_sources|accounting_states|account_rule_states)\b|alfred_accounting_source_version/i.test(sql)) throw new Error("Durable Accounts unexpectedly attempted a financial source read.");
    return (await db.query(sql, values)).rows;
  });
}, 30_000);
beforeEach(async () => {
  vi.stubEnv("ALFRED_DURABLE_DISPLAY", "true");
  await db.exec("truncate alfred_display.rows,alfred_display.test_publications,alfred_display.test_enqueues");
  await seed(); backend.query.mockClear();
});
afterEach(() => { vi.unstubAllEnvs(); });
afterAll(async () => { await db?.close(); });

describe("actual Accounts SQL over canonical durable rows", () => {
  it.each([
    query(), query({ page: 1 }), query({ page: Number.MAX_SAFE_INTEGER }), query({ section: "attention" }), query({ section: "movement", movementId: "fictional-movement:90" }),
    query({ section: "movement", movementId: "fictional-missing" }), query({ section: "snapshots" }), query({ section: "snapshots", accountId: "cash", page: 1 }),
    query({ section: "snapshots", accountId: "usd" }), query({ section: "snapshots", accountId: "missing", page: 5 }), query({ section: "transfers" }),
    query({ section: "settlements" }), query({ section: "returns", settlementId: "fictional-refund" }), query({ section: "returns", settlementId: "fictional-loan" }),
    query({ section: "returns", settlementId: "fictional-missing" }), query({ section: "targets", direction: "out" }), query({ section: "targets", direction: "in", accountId: "reserve" }),
    query({ section: "targets", search: "100%_" }), query({ section: "targets", search: "break" }), query({ section: "evidence", movementId: "fictional-movement:2", fingerprint: "fictional-fingerprint:2" }),
    query({ section: "settlement-plan", movementId: "fictional-movement:2", kind: "refund" }), query({ section: "settlement-plan", movementId: "fictional-movement:4", kind: "loan" }),
    query({ section: "settlement-plan", movementId: "fictional-missing", kind: "loan" }), query({ currency: "USD" }), query({ currency: "EUR" }),
  ])("matches the canonical %j result using one source-free SQL statement", async selected => {
    await expect(fresh(selected)).resolves.toEqual(canonical(fixture(), selected));
    expect(backend.query).toHaveBeenCalledOnce();
    expect(backend.query.mock.calls[0][1]).toContain("alfred_display.manifest");
    expect((await db.query("select * from alfred_display.test_enqueues")).rows).toEqual([]);
  });

  const cases: Partial<ActivityFilters>[] = [
    { search: "100%_" }, { search: "CAFÉ" }, { search: "İstanbul" }, { search: "break" }, { search: "(Literal)[shop]" },
    { category: "Fees", type: "expense" }, { category: "Taxes", search: "tax" }, { category: "Legacy refund", type: "expense" }, { category: "Fully refunded", type: "expense" },
    { type: "income" }, { account: "unassigned", status: "review" }, { account: "reserve", currency: "GHS", type: "income" },
    { start: "2026-11-05", end: "2026-11-05", sort: "amount-desc" }, { currency: "USD", sort: "amount-asc" }, { search: "does not exist", sort: "date-asc" },
  ];
  it.each(cases)("preserves activity filters, literal text and report matching %j", async filters => {
    for (const section of ["activity", "attention"] as const) {
      const selected = query({ section, filters: { ...emptyActivityFilters, ...filters } });
      await expect(fresh(selected)).resolves.toEqual(canonical(fixture(), selected));
    }
    expect(backend.query).toHaveBeenCalledTimes(2);
  });

  it.each(["date-asc", "date-desc", "amount-asc", "amount-desc"] as const)("retains stable tied order on every page for %s", async sort => {
    const expected: unknown[] = [], actual: unknown[] = [];
    for (let page = 0; page < 4; page += 1) {
      const selected = query({ page, filters: { ...emptyActivityFilters, sort } }), current = await fresh(selected);
      expect(current).toEqual(canonical(fixture(), selected));
      actual.push(...current!.page.rows); expected.push(...canonical(fixture(), selected).page.rows);
    }
    expect(actual).toEqual(expected); expect(backend.query).toHaveBeenCalledTimes(4);
  });

  it("preserves similar-group selection and ignores unrelated activity filters", async () => {
    const state = fixture();
    for (const index of [20, 25, 30]) Object.assign(state.movements[index], { accountId: null, status: "review", direction: "out", currency: "GHS", description: "Fictional matching group" });
    await seed(state); backend.query.mockClear();
    const groupKey = JSON.stringify(["Fictional matching group", null, "GHS", "out"]);
    const selected = query({ section: "similar", groupKey, filters: { ...emptyActivityFilters, search: "will not match", status: "excluded" } });
    await expect(fresh(selected)).resolves.toEqual(canonical(state, selected)); expect(backend.query).toHaveBeenCalledOnce();
  });

  it("keeps multiple links' globally distinct return ordinals scoped to their own settlement", async () => {
    const state = fixture();
    for (const link of state.settlements) {
      const selected = query({ section: "returns", settlementId: link.id });
      const returned = await fresh(selected);
      expect(returned).toEqual(canonical(state, selected)); expect(returned!.page.total).toBe(link.returns.length);
    }
  });
});

describe("owner, generation and evidence isolation", () => {
  it("cannot join rows from another owner, definition or stale cohort", async () => {
    const other = fixture(OTHER); other.movements[2].description = "Foreign owner secret";
    await seed(other, ACCOUNTING_DISPLAY_DEFINITION, "99");
    const foreignDefinition = fixture(); foreignDefinition.movements[2].description = "Foreign definition secret";
    await seed(foreignDefinition, "fictional-other-definition", "99");
    const stale = buildAccountsModel({ state: fixture(), availability: "ready", sourceVersion: SOURCE, rawTransactions: [] }).rows
      .filter(row => row.kind === "movement").slice(0, 1).map(row => ({ ...row, ordinal: 999999, payload: { movement: { ...(row.payload as { movement: object }).movement, description: "Stale cohort secret" }, reportMatches: [] } }));
    await insertRows(OWNER, ACCOUNTING_DISPLAY_DEFINITION, "999", stale);
    backend.query.mockClear();
    const current = await fresh(query({ section: "settlements" }));
    expect(current).toEqual(canonical(fixture(), query({ section: "settlements" })));
    expect(JSON.stringify(current)).not.toContain("secret");
    await expect(fresh(query(), OTHER)).resolves.toEqual(canonical(other, query()));
    expect(backend.query).toHaveBeenCalledTimes(2);
  });

  it.each([
    query({ expectedRevision: 6, expectedSourceVersion: SOURCE }), query({ expectedRevision: 7, expectedSourceVersion: "fictional-old" }),
    query({ section: "evidence", movementId: "fictional-movement:2", fingerprint: "fictional-old" }),
  ])("fails closed on changed cursor or evidence %j", async selected => {
    await expect(fresh(selected)).rejects.toMatchObject({ status: 409 }); expect(backend.query).toHaveBeenCalledOnce();
  });

  it("accepts matching cursors and rejects missing evidence without exposing another row", async () => {
    const selected = query({ expectedRevision: 7, expectedSourceVersion: SOURCE });
    await expect(fresh(selected)).resolves.toEqual(canonical(fixture(), selected));
    await expect(fresh(query({ section: "evidence", movementId: "fictional-unknown", fingerprint: "fictional-any" }))).rejects.toThrow(/unavailable in your account/);
  });

  it("keeps exact prior settlement fingerprints in append plans after current evidence changes", async () => {
    const state = fixture(); state.movements[3].sourceFingerprint = "fictional-current-changed";
    await seed(state); backend.query.mockClear();
    const selected = query({ section: "settlement-plan", movementId: state.movements[2].id, kind: "refund" });
    const plan = await fresh(selected);
    expect(plan).toEqual(canonical(state, selected));
    expect(JSON.stringify(plan?.page.rows)).toContain("fictional-fingerprint:3");
    expect(JSON.stringify(plan?.page.rows)).not.toContain("fictional-current-changed");
    expect(backend.query).toHaveBeenCalledOnce();
  });

  it.each(["ambiguous", "oversized"])("rejects an %s settlement plan while keeping its bounded history readable", async kind => {
    const state = fixture();
    if (kind === "ambiguous") state.settlements.push({ ...structuredClone(state.settlements[0]), id: "fictional-conflicting-refund" });
    else state.settlements[0].returns = Array.from({ length: 101 }, () => ({ ...state.settlements[0].returns[0], principalMinor: 1 }));
    await seed(state); backend.query.mockClear();
    await expect(fresh(query({ section: "settlement-plan", movementId: state.movements[2].id, kind: "refund" }))).rejects.toMatchObject({ status: 409 });
    const selected = query({ section: "returns", settlementId: state.settlements[0].id, page: 1 });
    await expect(fresh(selected)).resolves.toEqual(canonical(state, selected));
  });

  it("performs no database operation when the durable feature is off", async () => {
    vi.stubEnv("ALFRED_DURABLE_DISPLAY", "false");
    await expect(fresh(query())).resolves.toBeNull(); expect(backend.query).not.toHaveBeenCalled();
  });
});
