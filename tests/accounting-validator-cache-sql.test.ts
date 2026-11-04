import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

// All records and PostgreSQL instances in this file are synthetic and in memory.
const originalMigration = readFileSync("supabase/migrations/20261102160000_financial_accounting.sql", "utf8");
const migration = readFileSync("supabase/migrations/20261104180000_accounting_validator_cache.sql", "utf8");
const functionStart = "create or replace function public.alfred_accounting_document_valid(";
function validator(sql: string): string {
  const start = sql.indexOf(functionStart), end = sql.indexOf("\nend $$;", start);
  if (start < 0 || end < start) throw new Error("Accounting validator definition was not found.");
  return sql.slice(start, end + "\nend $$;".length);
}
const original = validator(originalMigration), cached = validator(migration);
const OWNER = "11111111-1111-4111-8111-111111111111", OTHER = "22222222-2222-4222-8222-222222222222";
type JsonRecord = Record<string, unknown>;
const account = { id: "synthetic-account", currency: "GHS" };
const movement = { ownerId: OWNER, accountId: account.id, amountMinor: 1000, feeMinor: 0, currency: "GHS" };
const empty = (): JsonRecord => ({ ownerId: OWNER, revision: 0, accounts: [], movements: [], snapshots: [], transfers: [], settlements: [], audit: [] });
const valid = (): JsonRecord => ({ ...empty(), revision: 3, accounts: [{ ...account }], movements: [{ ...movement }], snapshots: [{ accountId: account.id }] });
const withMovement = (patch: JsonRecord): JsonRecord => ({ ...valid(), movements: [{ ...movement, ...patch }] });
const without = (row: JsonRecord, key: string): JsonRecord => { const copy = { ...row }; delete copy[key]; return copy; };
async function metadata(db: PGlite) {
  const result = await db.query<{ value: JsonRecord }>("select to_jsonb(p)-'prosrc' as value from pg_catalog.pg_proc p where oid='public.alfred_accounting_document_valid(jsonb,uuid)'::regprocedure");
  return result.rows[0].value;
}
async function body(db: PGlite, name = "alfred_accounting_document_valid") {
  const result = await db.query<{ prosrc: string }>("select prosrc from pg_catalog.pg_proc where oid=to_regprocedure($1)", [`public.${name}(jsonb,uuid)`]);
  return result.rows[0].prosrc;
}

describe("cached accounting validator forward migration", () => {
  it("changes only one local account-array cache and its three existing reads", () => {
    const restored = cached
      .replace("declare item jsonb; account_rows jsonb;", "declare item jsonb;")
      .replace("  account_rows := document->'accounts';\n", "")
      .replace("array[account_rows,", "array[document->'accounts',")
      .replaceAll("jsonb_array_elements(account_rows)", "jsonb_array_elements(document->'accounts')");
    expect(restored).toBe(original);
    expect(cached.match(/document->'accounts'/g)).toHaveLength(1);
    expect(cached.match(/jsonb_array_elements\(account_rows\)/g)).toHaveLength(2);
    expect(cached).toContain("returns boolean language plpgsql immutable set search_path = public");
    expect(cached).toContain("exception when others then return false;");
    expect(migration.replace(/^--.*$/gm, "")).not.toMatch(/\b(?:drop|grant|revoke)\b\s+(?:all|execute|function|on)\b/i);
  });

  it("matches the original on valid large documents and malformed owner, array, reference and numeric boundaries", async () => {
    const db = new PGlite();
    try {
      await db.exec(original);
      await db.exec(original.replace(functionStart, "create or replace function public.synthetic_original_accounting_document_valid("));
      await db.exec(migration);
      const cases: [string, unknown, boolean][] = [
        ["empty", empty(), true], ["ordinary", valid(), true], ["SQL null", undefined, false], ["JSON null", null, false],
        ["array document", [], false], ["string document", "invalid", false], ["numeric document", 5, false], ["boolean document", true, false],
        ["owner mismatch", { ...valid(), ownerId: OTHER }, false], ["movement owner mismatch", withMovement({ ownerId: OTHER }), false],
        ["orphan movement", withMovement({ accountId: "missing" }), false], ["unassigned movement", withMovement({ accountId: null }), true],
        ["missing movement account legacy behavior", { ...valid(), movements: [without(movement, "accountId")] }, true],
        ["account currency mismatch", { ...valid(), accounts: [{ ...account, currency: "USD" }] }, false],
        ["orphan snapshot", { ...valid(), snapshots: [{ accountId: "missing" }] }, false],
        ["null snapshot", { ...valid(), snapshots: [null] }, false], ["scalar snapshot", { ...valid(), snapshots: ["invalid"] }, false],
        ["null movement", { ...valid(), movements: [null] }, false], ["scalar movement", { ...valid(), movements: ["invalid"] }, false],
        ["null account", { ...valid(), accounts: [null] }, false], ["unknown fields", { ...valid(), extra: { synthetic: true } }, true],
        ["duplicate account legacy behavior", { ...valid(), accounts: [{ ...account }, { ...account }] }, true],
        ["audit 50", { ...valid(), audit: Array(50).fill(null) }, true], ["audit 51", { ...valid(), audit: Array(51).fill(null) }, false],
        ["maximum revision", { ...valid(), revision: Number.MAX_SAFE_INTEGER }, true],
        ["maximum principal", withMovement({ amountMinor: Number.MAX_SAFE_INTEGER }), true],
        ["maximum fee", withMovement({ feeMinor: Number.MAX_SAFE_INTEGER }), true],
      ];
      for (const value of [undefined, null, "3", -1, 0.5, Number.MAX_SAFE_INTEGER + 1, 1e100]) {
        cases.push([`invalid revision ${String(value)}`, value === undefined ? without(valid(), "revision") : { ...valid(), revision: value }, false]);
      }
      for (const value of [undefined, null, "100", -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1, 1e100]) {
        cases.push([`invalid principal ${String(value)}`, { ...valid(), movements: [value === undefined ? without(movement, "amountMinor") : { ...movement, amountMinor: value }] }, false]);
      }
      for (const value of [undefined, null, "0", -1, 0.5, Number.MAX_SAFE_INTEGER + 1, 1e100]) {
        cases.push([`invalid fee ${String(value)}`, { ...valid(), movements: [value === undefined ? without(movement, "feeMinor") : { ...movement, feeMinor: value }] }, false]);
      }
      for (const value of [undefined, null, "ghs", "GH", "GHS1", ""]) {
        cases.push([`invalid currency ${String(value)}`, { ...valid(), movements: [value === undefined ? without(movement, "currency") : { ...movement, currency: value }] }, false]);
      }
      for (const field of ["accounts", "movements", "snapshots", "transfers", "settlements", "audit"]) {
        for (const value of [undefined, null, {}, "invalid", 1, true]) cases.push([`invalid ${field} ${String(value)}`, value === undefined ? without(valid(), field) : { ...valid(), [field]: value }, false]);
        cases.push([`${field} at array cap`, { ...empty(), [field]: Array(50_000).fill(null) }, ["accounts", "transfers", "settlements"].includes(field)]);
        cases.push([`${field} above array cap`, { ...empty(), [field]: Array(50_001).fill(null) }, false]);
      }
      cases.push(["3,000 movements and snapshots", {
        ...empty(), revision: 7,
        accounts: Array.from({ length: 7 }, (_, i) => ({ id: `synthetic-${i}`, currency: "GHS" })),
        movements: Array.from({ length: 3000 }, (_, i) => ({ ...movement, id: `synthetic-movement-${i}`, accountId: `synthetic-${i % 7}`, sourceText: "Synthetic evidence only" })),
        snapshots: Array.from({ length: 3000 }, (_, i) => ({ id: `synthetic-snapshot-${i}`, accountId: `synthetic-${i % 7}` })),
      }, true]);
      for (const [label, document, expected] of cases) {
        const result = await db.query<{ original: boolean; cached: boolean }>("select public.synthetic_original_accounting_document_valid($1::jsonb,$2::uuid) as original,public.alfred_accounting_document_valid($1::jsonb,$2::uuid) as cached", [document === undefined ? null : JSON.stringify(document), OWNER]);
        expect(result.rows[0].cached, label).toBe(result.rows[0].original);
        expect(result.rows[0].cached, label).toBe(expected);
      }
      expect(cases.length).toBeGreaterThanOrEqual(100);
      const wrongOwner = await db.query<{ original: boolean; cached: boolean }>("select public.synthetic_original_accounting_document_valid($1::jsonb,$2::uuid) as original,public.alfred_accounting_document_valid($1::jsonb,$2::uuid) as cached", [JSON.stringify(valid()), OTHER]);
      expect(wrongOwner.rows[0]).toEqual({ original: false, cached: false });
    } finally { await db.close(); }
  });

  it("rejects missing definitions and drift, preserving OID, owner, ACLs and all other metadata on apply and retry", async () => {
    const db = new PGlite();
    try {
      await expect(db.exec(migration)).rejects.toThrow("validator is missing");
      await db.exec(original.replace("return true;", "return false;"));
      const drifted = await body(db);
      await expect(db.exec(migration)).rejects.toThrow("definition changed");
      expect(await body(db)).toBe(drifted);
      await db.exec(original);
      await db.exec("alter function public.alfred_accounting_document_valid(jsonb,uuid) stable");
      await expect(db.exec(migration)).rejects.toThrow("ABI changed");
      await db.exec(original);
      await db.exec("create role synthetic_validator_reader;revoke all on function public.alfred_accounting_document_valid(jsonb,uuid) from public;grant execute on function public.alfred_accounting_document_valid(jsonb,uuid) to synthetic_validator_reader");
      const before = await metadata(db);
      await db.exec(migration);
      expect(await metadata(db)).toEqual(before);
      expect(await body(db)).toContain("account_rows := document->'accounts'");
      await db.exec(migration);
      expect(await metadata(db)).toEqual(before);
    } finally { await db.close(); }
  });

  it("retains existing table CHECK and trigger rejection, and permits exact original-function rollback", async () => {
    const db = new PGlite();
    try {
      await db.exec(original);
      await db.exec("create table public.synthetic_checked_documents(owner_id uuid not null,state jsonb not null,check(public.alfred_accounting_document_valid(state,owner_id)));create table public.synthetic_triggered_documents(owner_id uuid not null,state jsonb not null);create function public.synthetic_validate_trigger() returns trigger language plpgsql as $$begin if not public.alfred_accounting_document_valid(new.state,new.owner_id) then raise exception using errcode='23514',message='Synthetic document rejected';end if;return new;end$$;create trigger synthetic_validate before insert or update on public.synthetic_triggered_documents for each row execute function public.synthetic_validate_trigger()");
      const before = await metadata(db), originalBody = await body(db);
      await db.exec(migration);
      for (const table of ["synthetic_checked_documents", "synthetic_triggered_documents"]) {
        await db.query(`insert into public.${table}(owner_id,state) values($1::uuid,$2::jsonb)`, [OWNER, JSON.stringify(valid())]);
        for (const document of [{ ...valid(), ownerId: OTHER }, withMovement({ amountMinor: 0 }), withMovement({ accountId: "orphan" }), { ...valid(), snapshots: [{ accountId: "orphan" }] }]) {
          await expect(db.query(`insert into public.${table}(owner_id,state) values($1::uuid,$2::jsonb)`, [OWNER, JSON.stringify(document)])).rejects.toMatchObject({ code: "23514" });
        }
        await expect(db.query(`update public.${table} set state=$1::jsonb`, [JSON.stringify(withMovement({ feeMinor: -1 }))])).rejects.toMatchObject({ code: "23514" });
        expect((await db.query<{ count: number }>(`select count(*)::int as count from public.${table}`)).rows[0].count).toBe(1);
      }
      await db.exec(original);
      expect(await body(db)).toBe(originalBody);
      expect(await metadata(db)).toEqual(before);
      await expect(db.query("insert into public.synthetic_checked_documents(owner_id,state) values($1::uuid,$2::jsonb)", [OWNER, JSON.stringify(withMovement({ ownerId: OTHER }))])).rejects.toMatchObject({ code: "23514" });
    } finally { await db.close(); }
  });
});
