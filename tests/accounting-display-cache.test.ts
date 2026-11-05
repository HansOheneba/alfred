import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyAccountRuleState } from "@/lib/account-rules/types";
import { ALFRED_SUPABASE_HOST, ALFRED_SUPABASE_PROJECT_REF, ALFRED_SUPABASE_USER, type SupabaseSettings } from "@/lib/config";
import { createAccountingDisplayCache, DISPLAY_STAMP_SQL } from "@/lib/finance/accounting/display-cache";
import { loadAccountingReadModel, loadAccountingState, saveAccountingAction, type AccountingResult } from "@/lib/finance/accounting/persisted-store";
import { applyAccountingAction } from "@/lib/finance/accounting/reducer";
import { emptyAccountingState, type AccountingState } from "@/lib/finance/accounting/types";
import { buildAlfredExport } from "@/lib/portability/export";

const mocks = vi.hoisted(() => ({ query: vi.fn(), raw: vi.fn(), messages: vi.fn(), rules: vi.fn() }));
vi.mock("@/lib/supabase/connection", () => ({ query: mocks.query }));
vi.mock("@/lib/supabase/finance-store", () => ({ listRawTransactions: mocks.raw }));
vi.mock("@/lib/bank/store", () => ({ listAccountingBankMessages: (_settings: unknown, ownerId: string) => mocks.messages(ownerId) }));
vi.mock("@/lib/account-rules/store", () => ({ loadAccountRules: mocks.rules }));

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", THIRD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const settings: SupabaseSettings = { host: ALFRED_SUPABASE_HOST, projectRef: ALFRED_SUPABASE_PROJECT_REF, user: ALFRED_SUPABASE_USER, database: "postgres", password: "fictional-only" };
const AT = "2026-11-05T12:00:00.000Z";
const generous = { ttlMs: 60_000, maxEntries: 8, maxBytes: 1_000_000, maxEntryBytes: 100_000 };
function result(ownerId = OWNER, revision = 3, sourceVersion: string | null = "source:3", padding = 0): AccountingResult {
  const state = { ...emptyAccountingState(ownerId), revision, accounts: [{ id: "cash", label: "Fictional cash", provider: "Fictional provider", currency: "GHS", includeInCash: true, createdAt: AT }] };
  if (padding) Object.assign(state, { fixturePadding: "x".repeat(padding) });
  return { state, availability: "ready", sourceVersion, rawTransactions: [], bankMessages: [] };
}
const size = (value: AccountingResult) => Buffer.byteLength(JSON.stringify(value));
function stamp(revision = 3, sourceVersion = "source:3") { return [{ revision: String(revision), source_version: sourceVersion }]; }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  mocks.query.mockReset().mockResolvedValue(stamp());
  mocks.raw.mockReset().mockResolvedValue([]); mocks.messages.mockReset().mockResolvedValue([]);
  mocks.rules.mockReset().mockImplementation(async (_settings, ownerId: string) => ({ state: emptyAccountRuleState(ownerId), availability: "migration-required" }));
});
afterEach(() => { vi.useRealTimers(); });

describe("freshness-checked accounting display cache", () => {
  it("does not add a cold prequery, and validates both fresh tokens in one owner-scoped statement on every hit", async () => {
    const cache = createAccountingDisplayCache(generous), load = vi.fn(async () => result());
    await cache.read(settings, OWNER, load);
    expect(mocks.query).not.toHaveBeenCalled();
    await cache.read(settings, OWNER, load); await cache.read(settings, OWNER, load);
    expect(load).toHaveBeenCalledOnce(); expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.query).toHaveBeenNthCalledWith(1, settings, DISPLAY_STAMP_SQL, [OWNER]);
    expect(DISPLAY_STAMP_SQL).toContain("revision from public.accounting_states where owner_id=$1::uuid");
    expect(DISPLAY_STAMP_SQL).toContain("public.alfred_accounting_source_version($1::uuid)");
    expect(DISPLAY_STAMP_SQL).not.toContain(OWNER);
  });

  it.each(["host", "projectRef", "user", "database", "owner"])("isolates the %s cache key", async (field) => {
    const cache = createAccountingDisplayCache(generous);
    await cache.read(settings, OWNER, async () => result());
    const ownerId = field === "owner" ? OTHER : OWNER;
    const changed = field === "owner" ? settings : { ...settings, [field]: `fictional-other-${field}` } as SupabaseSettings;
    const load = vi.fn(async () => result(ownerId));
    await cache.read(changed, ownerId, load);
    expect(load).toHaveBeenCalledOnce(); expect(mocks.query).not.toHaveBeenCalled();
    await cache.read(changed, ownerId, load);
    expect(mocks.query).toHaveBeenCalledExactlyOnceWith(changed, DISPLAY_STAMP_SQL, [ownerId]);
  });

  it("uses current credentials for the fresh stamp after a password rotation", async () => {
    const cache = createAccountingDisplayCache(generous);
    await cache.read(settings, OWNER, async () => result());
    const rotated = { ...settings, password: "new-fictional-password" }, fallback = vi.fn(async () => result());
    await cache.read(rotated, OWNER, fallback);
    expect(mocks.query).toHaveBeenCalledExactlyOnceWith(rotated, DISPLAY_STAMP_SQL, [OWNER]);
    expect(fallback).not.toHaveBeenCalled();
  });

  it.each(["revision", "sourceVersion"])("reloads coherently when only %s changes", async (field) => {
    const cache = createAccountingDisplayCache(generous);
    await cache.read(settings, OWNER, async () => result());
    const fresh = result(OWNER, field === "revision" ? 4 : 3, field === "sourceVersion" ? "source:4" : "source:3");
    mocks.query.mockResolvedValue(stamp(fresh.state.revision, fresh.sourceVersion!));
    const reload = vi.fn(async () => fresh);
    expect(await cache.read(settings, OWNER, reload)).toEqual(fresh);
    expect(await cache.read(settings, OWNER, reload)).toEqual(fresh);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("evicts and throws on a failed fresh stamp without falling back to stale data or another load", async () => {
    const cache = createAccountingDisplayCache(generous);
    await cache.read(settings, OWNER, async () => result());
    const failure = new Error("fictional database unavailable"), reload = vi.fn(async () => result());
    mocks.query.mockRejectedValueOnce(failure);
    await expect(cache.read(settings, OWNER, reload)).rejects.toBe(failure);
    expect(reload).not.toHaveBeenCalled();
    await cache.read(settings, OWNER, reload);
    expect(reload).toHaveBeenCalledOnce(); expect(mocks.query).toHaveBeenCalledOnce();
  });

  it("keeps cached data separate from both the cold caller and every warm caller", async () => {
    const cache = createAccountingDisplayCache(generous), original = result();
    const cold = await cache.read(settings, OWNER, async () => original);
    cold.state.accounts[0].label = "Caller mutation";
    const warm = await cache.read(settings, OWNER, async () => result());
    expect(warm.state.accounts[0].label).toBe("Fictional cash");
    warm.state.accounts.length = 0; warm.rawTransactions.length = 0;
    expect((await cache.read(settings, OWNER, async () => result())).state.accounts).toHaveLength(1);
  });

  it("expires by insertion age rather than extending TTL when read", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const cache = createAccountingDisplayCache({ ...generous, ttlMs: 100 }), load = vi.fn(async () => result());
    await cache.read(settings, OWNER, load);
    vi.setSystemTime(99); await cache.read(settings, OWNER, load);
    vi.setSystemTime(100); await cache.read(settings, OWNER, load);
    expect(load).toHaveBeenCalledTimes(2); expect(mocks.query).toHaveBeenCalledOnce();
  });

  it("evicts the least recently used entry at the entry count limit", async () => {
    const cache = createAccountingDisplayCache({ ...generous, maxEntries: 2 });
    await cache.read(settings, OWNER, async () => result());
    await cache.read(settings, OTHER, async () => result(OTHER));
    await cache.read(settings, OWNER, async () => result());
    await cache.read(settings, THIRD, async () => result(THIRD));
    const ownerLoad = vi.fn(async () => result()), otherLoad = vi.fn(async () => result(OTHER));
    await cache.read(settings, OWNER, ownerLoad); await cache.read(settings, OTHER, otherLoad);
    expect(ownerLoad).not.toHaveBeenCalled(); expect(otherLoad).toHaveBeenCalledOnce();
  });

  it("enforces per-entry and total serialized-byte caps, including exact boundaries", async () => {
    const one = result(), bytes = size(one);
    const exact = createAccountingDisplayCache({ ...generous, maxEntryBytes: bytes, maxBytes: bytes });
    const load = vi.fn(async () => result());
    await exact.read(settings, OWNER, load); await exact.read(settings, OWNER, load);
    expect(load).toHaveBeenCalledOnce();
    const oversized = createAccountingDisplayCache({ ...generous, maxEntryBytes: bytes - 1 });
    const largeLoad = vi.fn(async () => result());
    await oversized.read(settings, OWNER, largeLoad); await oversized.read(settings, OWNER, largeLoad);
    expect(largeLoad).toHaveBeenCalledTimes(2);
    const total = createAccountingDisplayCache({ ...generous, maxEntries: 8, maxBytes: bytes * 2 });
    await total.read(settings, OWNER, async () => result()); await total.read(settings, OTHER, async () => result(OTHER));
    await total.read(settings, THIRD, async () => result(THIRD));
    const evicted = vi.fn(async () => result());
    await total.read(settings, OWNER, evicted);
    expect(evicted).toHaveBeenCalledOnce();
  });

  it("does not retain oversized results or any entry when caching is disabled", async () => {
    for (const limits of [{ ...generous, maxEntries: 0 }, { ...generous, maxBytes: 1 }, { ...generous, maxEntryBytes: 1 }]) {
      const cache = createAccountingDisplayCache(limits), load = vi.fn(async () => result(OWNER, 3, "source:3", 2000));
      await cache.read(settings, OWNER, load); await cache.read(settings, OWNER, load);
      expect(load).toHaveBeenCalledTimes(2);
    }
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("does not retain an in-flight load, and an older completion cannot replace a newer cached read", async () => {
    const cache = createAccountingDisplayCache(generous), old = deferred<AccountingResult>(), fresh = deferred<AccountingResult>();
    const oldLoad = vi.fn(() => old.promise), newLoad = vi.fn(() => fresh.promise);
    const first = cache.read(settings, OWNER, oldLoad), second = cache.read(settings, OWNER, newLoad);
    expect(oldLoad).toHaveBeenCalledOnce(); expect(newLoad).toHaveBeenCalledOnce();
    fresh.resolve(result(OWNER, 4, "source:4")); await second;
    old.resolve(result()); await first;
    mocks.query.mockResolvedValue(stamp(4, "source:4"));
    const reload = vi.fn(async () => result());
    expect((await cache.read(settings, OWNER, reload)).state.revision).toBe(4);
    expect(reload).not.toHaveBeenCalled();
  });

  it("does not let a failed overlapping old stamp evict its healthy replacement", async () => {
    const cache = createAccountingDisplayCache(generous);
    await cache.read(settings, OWNER, async () => result());
    const pending = deferred<ReturnType<typeof stamp>>();
    mocks.query.mockReturnValueOnce(pending.promise).mockResolvedValue(stamp(4, "source:4"));
    const first = cache.read(settings, OWNER, async () => result()).catch((error: unknown) => error);
    await vi.waitFor(() => expect(mocks.query).toHaveBeenCalledOnce());
    await cache.read(settings, OWNER, async () => result(OWNER, 4, "source:4"));
    const failure = new Error("old stamp failed"); pending.reject(failure);
    expect(await first).toBe(failure);
    const reload = vi.fn(async () => result());
    expect((await cache.read(settings, OWNER, reload)).state.revision).toBe(4);
    expect(reload).not.toHaveBeenCalled();
  });

  it.each(["migration-required", "missing-version"])("does not cache %s reads", async (kind) => {
    const cache = createAccountingDisplayCache(generous), load = vi.fn(async () => {
      const loaded = result();
      if (kind === "migration-required") loaded.availability = "migration-required";
      else loaded.sourceVersion = null;
      return loaded;
    });
    await cache.read(settings, OWNER, load); await cache.read(settings, OWNER, load);
    expect(load).toHaveBeenCalledTimes(2); expect(mocks.query).not.toHaveBeenCalled();
  });

  it("rejects a wrong-owner load and does not retain it", async () => {
    const cache = createAccountingDisplayCache(generous);
    await expect(cache.read(settings, OWNER, async () => result(OTHER))).rejects.toMatchObject({ code: "ownership" });
    const load = vi.fn(async () => result());
    await cache.read(settings, OWNER, load);
    expect(load).toHaveBeenCalledOnce(); expect(mocks.query).not.toHaveBeenCalled();
  });
});

describe("display-cache isolation from complete financial writes and exports", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec("create role anon;create role authenticated;create schema auth;create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}'::jsonb);");
    for (const file of readdirSync("supabase/migrations").filter(file => file.endsWith(".sql")).sort()) await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
    await db.query("insert into auth.users(id) values($1)", [OWNER]);
  }, 30_000);
  afterAll(async () => { await db?.close(); });

  it("warms the actual read loader, then full reads, Undo and native export preserve complete audit.before without querying the cache stamp", async () => {
    mocks.query.mockImplementation(async (_settings, sql: string, values: unknown[] = []) => (await db.query(sql, values)).rows);
    let stored: AccountingState = { ...emptyAccountingState(OWNER), accounts: result().state.accounts };
    for (let revision = 1; revision <= 2; revision += 1) stored = applyAccountingAction(stored, { type: "update_account", accountId: "cash", changes: { label: `Fictional cash ${revision}` }, expectedRevision: stored.revision, requestId: `cache-label:${revision}` }, AT);
    await db.query("insert into accounting_states(owner_id,revision,state) values($1,$2,$3::jsonb)", [OWNER, stored.revision, JSON.stringify(stored)]);
    expect((await loadAccountingReadModel(settings, OWNER)).state.audit[0].before.accounts).toEqual([]);
    mocks.query.mockClear();
    expect((await loadAccountingReadModel(settings, OWNER)).state.audit[0].before.accounts).toEqual([]);
    expect(mocks.query).toHaveBeenCalledExactlyOnceWith(settings, DISPLAY_STAMP_SQL, [OWNER]);
    const execute = mocks.query.getMockImplementation()!;
    mocks.query.mockClear().mockImplementation(async (...args) => {
      if (args[1] === DISPLAY_STAMP_SQL) throw new Error("Display-cache stamps must not run for authoritative reads");
      return execute(...args);
    });
    const full = await loadAccountingState(settings, OWNER);
    expect(full.state).toEqual(stored);
    const saved = await saveAccountingAction(settings, OWNER, { type: "undo", expectedRevision: 2, requestId: "cache-undo:complete-history" });
    expect(saved.state.accounts[0].label).toBe("Fictional cash 1");
    expect(saved.state.audit.at(-1)?.before.accounts).toEqual([]);
    expect(saved.state.audit[0].before.accounts).toEqual([]);
    const authoritativeSaved = await loadAccountingState(settings, OWNER);
    expect(authoritativeSaved.state.audit.at(-1)?.before.accounts[0].label).toBe("Fictional cash 2");
    expect(authoritativeSaved.state.audit[0].before.accounts).toHaveLength(1);
    const exported = await buildAlfredExport(settings, OWNER);
    const native = exported.datasets["alfred.native"];
    const exportedState = native.tables.accountingStates[0].state as AccountingState;
    const beforeEvent = native.tables.accountingEvents[0].before_state as AccountingState;
    const afterEvent = native.tables.accountingEvents[0].after_state as AccountingState;
    expect(exportedState.audit[0].before.accounts).toHaveLength(1);
    expect(beforeEvent.accounts[0].label).toBe("Fictional cash 2");
    expect(afterEvent.audit.at(-1)?.before.accounts[0].label).toBe("Fictional cash 2");
    expect(mocks.query.mock.calls.some(([, sql]) => sql === DISPLAY_STAMP_SQL)).toBe(false);
    expect(mocks.query.mock.calls.some(([, sql]) => sql === "select state from public.accounting_states where owner_id=$1::uuid")).toBe(true);
    expect(mocks.query.mock.calls.some(([, sql]) => sql.includes("as before from public.accounting_states"))).toBe(true);
  });
});
