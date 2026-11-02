import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { reduceAccountRuleCommand } from "@/lib/account-rules/store";
import { emptyAccountRuleState, type AccountRuleState } from "@/lib/account-rules/types";
import { emptyAccountingState, type FinancialAccount } from "@/lib/finance/accounting/types";

// Optional local SQL engine. No application configuration or live database is loaded.
const modulePath = process.env.ALFRED_PGLITE_MODULE ?? resolve("node_modules/@electric-sql/pglite/dist/index.js");
if (process.env.ALFRED_PGLITE_MODULE && !existsSync(modulePath)) throw new Error("ALFRED_PGLITE_MODULE must point to the installed PGlite ES module.");
interface Database { exec(sql: string): Promise<unknown>; query<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<{ rows: T[] }>; close(): Promise<void> }
const OWNER = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const ID = "00000000-0000-4000-8000-000000000010";
const NOW = "2026-11-02T12:00:00.000Z";
const account: FinancialAccount = { id: "owned-account", label: "Synthetic account", provider: "GCB", currency: "GHS", includeInCash: true, createdAt: NOW };
const initial = () => reduceAccountRuleCommand(emptyAccountRuleState(OWNER), {
  type: "upsert_rule", expectedRevision: 0, requestId: "synthetic-create", rule: { id: ID, accountId: account.id, matchMode: "exact", merchantExact: "Synthetic Merchant", category: "Custom category" },
}, [account], NOW);

describe.skipIf(!existsSync(modulePath))("account rules on an ephemeral synthetic PostgreSQL", () => {
  let db: Database;
  beforeAll(async () => {
    const { PGlite } = await import(/* @vite-ignore */ pathToFileURL(modulePath).href) as { PGlite: new () => Database };
    db = new PGlite();
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;
      create table public.profiles(id uuid primary key);
      create table public.transactions(id text primary key,owner_id uuid references public.profiles(id));
      create table public.bank_messages(id text primary key,owner_id uuid references public.profiles(id));`);
    await db.exec(readFileSync(resolve("supabase/migrations/20261102160000_financial_accounting.sql"), "utf8"));
    await db.exec(readFileSync(resolve("supabase/migrations/20261102170000_account_rules.sql"), "utf8"));
  }, 30_000);
  beforeEach(async () => {
    await db.exec("reset role; truncate public.profiles cascade;");
    await db.query("insert into public.profiles(id) values($1),($2)", [OWNER, OTHER]);
    const accounting = { ...emptyAccountingState(OWNER), accounts: [account] };
    await db.query("insert into public.accounting_states(owner_id,revision,state) values($1,0,$2::jsonb)", [OWNER, JSON.stringify(accounting)]);
  });
  afterAll(async () => { await db?.close(); });
  const version = async (owner = OWNER) => (await db.query<{ version: string }>("select public.alfred_accounting_source_version($1) as version", [owner])).rows[0].version;
  const write = async (state = initial(), expected = state.revision - 1, request = "synthetic-create", fingerprint = "a".repeat(64), owner = OWNER) => (await db.query<{ result: { status: string; state?: AccountRuleState } }>("select public.alfred_write_account_rules($1,$2,$3,$4,$5::jsonb) as result", [owner, expected, request, fingerprint, JSON.stringify(state)])).rows[0].result;
  const counts = async () => (await db.query<{ states: number; events: number }>("select (select count(*)::int from public.account_rule_states) as states,(select count(*)::int from public.account_rule_events) as events")).rows[0];

  it("commits owner-scoped state and audit atomically, permanently deduplicates request IDs and rejects stale edits", async () => {
    expect((await write()).status).toBe("saved");
    expect((await write()).status).toBe("duplicate");
    expect((await write(initial(), 0, "synthetic-create", "b".repeat(64))).status).toBe("conflict");
    expect((await write(initial(), 0, "different-request")).status).toBe("stale");
    expect(await counts()).toEqual({ states: 1, events: 1 });
  });

  it("refuses foreign account IDs and currency-mismatched bindings without committing anything", async () => {
    const foreign = initial(); foreign.rules[0].accountId = "someone-else-account";
    expect((await write(foreign)).status).toBe("ownership");
    const wrongCurrency = { ...initial(), bindings: [{ id: ID, accountId: account.id, provider: "gcb", accountSuffix: "1234", currency: "USD", active: true, createdAt: NOW, revision: 1 }] };
    expect((await write(wrongCurrency)).status).toBe("ownership");
    expect(await counts()).toEqual({ states: 0, events: 0 });
  });

  it("rejects malformed state, missing mandatory fields, duplicate keys and forged document owners", async () => {
    for (const missing of ["accountId", "matchMode", "direction", "category", "priority", "active", "effectiveFrom", "createdAt", "revision"]) {
      const invalid = structuredClone(initial()); delete (invalid.rules[0] as unknown as Record<string, unknown>)[missing];
      expect((await db.query<{ valid: boolean }>("select public.alfred_account_rule_document_valid($1::jsonb,$2) as valid", [JSON.stringify(invalid), OWNER])).rows[0].valid).toBe(false);
    }
    const duplicate = initial(); duplicate.rules.push({ ...duplicate.rules[0], id: "00000000-0000-4000-8000-000000000011" });
    await expect(write(duplicate)).rejects.toThrow("Invalid account-rule state");
    await expect(write({ ...initial(), ownerId: OTHER })).rejects.toThrow("Invalid account-rule state");
    expect(await counts()).toEqual({ states: 0, events: 0 });
  });

  it("rolls back the entire mutation when audit persistence fails after the aggregate insert", async () => {
    const before = await version();
    await expect(write(initial(), 0, "synthetic-create", "invalid-fingerprint")).rejects.toThrow(/check constraint/);
    expect(await counts()).toEqual({ states: 0, events: 0 });
    expect(await version()).toBe(before);
  });

  it("changes only this owner's source version, so optimistic accounting/import writes detect rule races", async () => {
    const before = await version(); const other = await version(OTHER);
    await write();
    expect(await version()).not.toBe(before);
    expect(await version(OTHER)).toBe(other);
  });

  it("allows safe cleanup if an accounting undo removes a rule's account, without accepting new foreign references", async () => {
    await write();
    await db.query("update public.accounting_states set state=jsonb_set(state,'{accounts}','[]'::jsonb) where owner_id=$1", [OWNER]);
    const disabled = { ...initial(), revision: 2, rules: initial().rules.map((rule) => ({ ...rule, active: false, revision: 2 })) };
    expect((await write(disabled, 1, "disable-orphan")).status).toBe("saved");
    expect((await write({ ...disabled, revision: 3, rules: [] }, 2, "remove-orphan")).status).toBe("saved");
    const forged = { ...initial(), revision: 4 }; forged.rules[0].accountId = "foreign-account";
    expect((await write(forged, 3, "forge-new-reference")).status).toBe("ownership");
  });

  it("protects owner-only reads and denies direct state writes or function execution by authenticated clients", async () => {
    await write();
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [OTHER]);
    await db.exec("set role authenticated;");
    expect((await db.query("select * from public.account_rule_states")).rows).toEqual([]);
    await expect(db.query("delete from public.account_rule_states")).rejects.toThrow(/permission denied/i);
    await expect(write()).rejects.toThrow(/permission denied/i);
    await db.exec("reset role;");
  });
});
