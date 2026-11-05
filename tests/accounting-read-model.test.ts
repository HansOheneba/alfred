import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyAccountRuleState } from "@/lib/account-rules/types";
import type { SupabaseSettings } from "@/lib/config";
import { browserAccountingState } from "@/lib/finance/accounting/browser-state";
import { loadAccountingReadModel, loadAccountingState, saveAccountingAction } from "@/lib/finance/accounting/persisted-store";
import { applyAccountingAction } from "@/lib/finance/accounting/reducer";
import { sourceMovements } from "@/lib/finance/accounting/sources";
import { emptyAccountingState, type AccountingState } from "@/lib/finance/accounting/types";
import type { TransactionRecord } from "@/lib/finance/types";

const mocks = vi.hoisted(() => ({ query: vi.fn(), raw: vi.fn(), messages: vi.fn(), rules: vi.fn() }));
vi.mock("@/lib/supabase/connection", () => ({ query: mocks.query }));
vi.mock("@/lib/supabase/finance-store", () => ({ listRawTransactions: mocks.raw }));
vi.mock("@/lib/bank/store", () => ({ listAccountingBankMessages: (_settings: unknown, ownerId: string) => mocks.messages(ownerId) }));
vi.mock("@/lib/account-rules/store", () => ({ loadAccountRules: mocks.rules }));

const OWNER = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const AT = "2026-11-05T12:00:00.000Z";
// No application configuration or real connection is loaded. Every SQL call goes to PGlite.
const settings = {} as SupabaseSettings;
const raw: TransactionRecord[] = Array.from({ length: 120 }, (_, index) => ({
  transactionId: `synthetic:${index}`, createdAt: AT, transactionDate: "2026-11-05", userId: OWNER,
  type: index % 2 ? "income" : "expense", amount: "10.00", currency: "GHS", category: "Other",
  description: `Synthetic payment ${index}`, paymentMethod: "Synthetic wallet", notes: "", status: "active",
  updatedAt: AT, sourceUpdateId: `synthetic-source:${index}`, rowNumber: index + 2,
}));

function fixture(): AccountingState {
  let state: AccountingState = {
    ...emptyAccountingState(OWNER),
    accounts: ["cash", "reserve"].map((id) => ({ id, label: id, provider: "Synthetic wallet", currency: "GHS", includeInCash: true, createdAt: AT })),
    movements: sourceMovements(OWNER, raw, []).map((movement, index) => ({ ...movement, accountId: index % 2 ? "reserve" : "cash", categoryOrigin: "source" })),
    snapshots: Array.from({ length: 120 }, (_, index) => ({ id: `snapshot:${index}`, accountId: "cash", balanceMinor: 100000 + index, occurredAt: AT, sourceId: `statement:${index}`, sourceMovementId: null })),
    transferRejections: ["rejected:synthetic"],
  };
  const reference = (index: number) => ({ movementId: state.movements[index].id, sourceFingerprint: state.movements[index].sourceFingerprint });
  state.transfers = [{ id: "transfer:synthetic", outgoing: reference(0), incoming: reference(1), createdAt: AT }];
  state.settlements = [{ id: "settlement:synthetic", kind: "refund", original: reference(2), returns: [{ ...reference(3), principalMinor: 1000 }], createdAt: AT }];
  Object.assign(state, { fixtureExtension: { preserved: true } });
  for (let revision = 1; revision <= 8; revision += 1) {
    state = applyAccountingAction(state, { type: "update_account", accountId: "cash", changes: { label: `Synthetic cash ${revision}` }, expectedRevision: state.revision, requestId: `label:${revision}` }, AT);
  }
  Object.assign(state.audit[0], { fixtureMetadata: "preserved" });
  return state;
}

describe("read-only accounting projection on isolated Postgres", () => {
  let db: PGlite;
  let stored: AccountingState;
  const transferredPayloadBytes: number[] = [];
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      create role anon;
      create role authenticated;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
      create table public.profiles(id uuid primary key);
      create table public.transactions(id text primary key, owner_id uuid references public.profiles(id));
      create table public.bank_messages(id text primary key, owner_id uuid references public.profiles(id));
    `);
    await db.exec(readFileSync("supabase/migrations/20261102160000_financial_accounting.sql", "utf8"));
  }, 30_000);
  beforeEach(async () => {
    await db.exec("truncate public.profiles cascade");
    await db.query("insert into public.profiles(id) values($1),($2)", [OWNER, OTHER]);
    stored = fixture();
    await db.query("insert into public.accounting_states(owner_id,revision,state) values($1,$2,$3::jsonb)", [OWNER, stored.revision, JSON.stringify(stored)]);
    transferredPayloadBytes.length = 0;
    mocks.raw.mockReset().mockResolvedValue(raw);
    mocks.messages.mockReset().mockResolvedValue([]);
    mocks.rules.mockReset().mockImplementation(async (_settings, ownerId: string) => ({ state: emptyAccountRuleState(ownerId), availability: "migration-required" }));
    mocks.query.mockReset().mockImplementation(async (_settings, sql: string, values: unknown[] = []) => {
      const { rows } = await db.query(sql, values);
      if (sql.includes("as state from public.accounting_states") || sql.startsWith("select state from public.accounting_states")) {
        transferredPayloadBytes.push(Buffer.byteLength(JSON.stringify(rows)));
      }
      return rows;
    });
  });
  afterAll(async () => { await db?.close(); });

  it("transfers only audit metadata while preserving every current field, audit order and stored document", async () => {
    const full = await loadAccountingState(settings, OWNER);
    const read = await loadAccountingReadModel(settings, OWNER);
    expect(full.state).toEqual(stored);
    expect(read).toEqual({ ...full, state: browserAccountingState(full.state) });
    expect(read.state.audit.map((entry) => entry.requestId)).toEqual(stored.audit.map((entry) => entry.requestId));
    expect(read.state).toHaveProperty("fixtureExtension", { preserved: true });
    expect(read.state.audit[0]).toHaveProperty("fixtureMetadata", "preserved");
    expect(read.state.transferRejections).toEqual(stored.transferRejections);
    expect(transferredPayloadBytes[1]).toBeLessThan(transferredPayloadBytes[0] / 7);
    expect((await db.query<{ state: AccountingState }>("select state from public.accounting_states where owner_id=$1", [OWNER])).rows[0].state).toEqual(stored);
    expect(mocks.query.mock.calls.every(([, sql]) => sql.trimStart().startsWith("select "))).toBe(true);
  });

  it("uses the full history after a display read so Undo restores the prior data and persists complete audit bodies", async () => {
    await loadAccountingReadModel(settings, OWNER);
    mocks.query.mockClear();
    const result = await saveAccountingAction(settings, OWNER, { type: "undo", requestId: "undo:after-read", expectedRevision: stored.revision });
    expect(result.state.accounts[0].label).toBe("Synthetic cash 7");
    expect(result.state.movements).toEqual(stored.movements);
    expect(result.state.audit.slice(0, 8)).toEqual(stored.audit);
    expect(result.state.audit.at(-1)?.before.accounts).toEqual(stored.accounts);
    expect(result.state.audit.at(-1)?.before.movements).toEqual(stored.movements);
    const persisted = (await db.query<{ state: AccountingState }>("select state from public.accounting_states where owner_id=$1", [OWNER])).rows[0].state;
    expect(persisted).toEqual(result.state);
    expect(persisted.audit.every((entry) => entry.before.movements.length === raw.length)).toBe(true);
    expect(mocks.query.mock.calls.some(([, sql]) => sql === "select state from public.accounting_states where owner_id=$1::uuid")).toBe(true);
    expect(mocks.query.mock.calls.some(([, sql]) => sql.includes("jsonb_set"))).toBe(false);
    const event = (await db.query<{ before_state: AccountingState; after_state: AccountingState }>("select before_state,after_state from public.accounting_events where owner_id=$1", [OWNER])).rows[0];
    expect(event.before_state).toEqual(stored);
    expect(event.after_state).toEqual(persisted);
  });

  it("keeps empty history empty and scopes the projection to the requested owner", async () => {
    const state = emptyAccountingState(OTHER);
    await db.query("insert into public.accounting_states(owner_id,revision,state) values($1,0,$2::jsonb)", [OTHER, JSON.stringify(state)]);
    mocks.raw.mockResolvedValue([]);
    expect((await loadAccountingReadModel(settings, OTHER)).state).toEqual(state);
    await db.query("delete from public.accounting_states where owner_id=$1", [OTHER]);
    expect((await loadAccountingReadModel(settings, OTHER)).state).toEqual(state);
  });

  it("still fails closed if source evidence changes during a projected read", async () => {
    const original = mocks.query.getMockImplementation()!;
    let versions = 0;
    mocks.query.mockImplementation(async (...args) => {
      if ((args[1] as string).startsWith("select public.alfred_accounting_source_version")) return [{ version: ++versions === 1 ? "before" : "after" }];
      return original(...args);
    });
    await expect(loadAccountingReadModel(settings, OWNER)).rejects.toMatchObject({ code: "stale" });
  });
});
