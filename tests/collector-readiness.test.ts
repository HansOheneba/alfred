import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, describe, expect, it } from "vitest";
import type { SupabaseSettings } from "@/lib/config";
import type { Execute } from "@/lib/notifications/store";
import { collectorSetupReady } from "@/lib/bank/collector-readiness";

const settings = {} as SupabaseSettings;
const db = new PGlite();
const execute: Execute = async <T extends Record<string, unknown>>(_settings: SupabaseSettings, sql: string, values: unknown[] = []) =>
  (await db.query<T>(sql, values)).rows;
afterAll(async () => { await db.close(); });

describe("native setup readiness with actual PostgreSQL catalog", () => {
  it("requires durable receipt and both-direction announcement storage without creating any missing schema", async () => {
    expect(await collectorSetupReady(settings, execute)).toBe(false);
    expect((await db.query("select to_regclass('public.bank_messages') as table_name")).rows).toEqual([{ table_name: null }]);
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;
      create table auth.users(id uuid primary key, raw_user_meta_data jsonb default '{}'::jsonb);`);
    const directory = new URL("../supabase/migrations/", import.meta.url);
    const files = (await readdir(directory)).filter(name => name.endsWith(".sql")).sort();
    for (const file of files.filter(name => name < "20261103233000")) {
      await db.exec(await readFile(new URL(file, directory), "utf8"));
    }
    // The already-merged incoming-only schema cannot start the new Mac flow.
    expect(await collectorSetupReady(settings, execute)).toBe(false);
    await db.exec(await readFile(new URL("20261103233000_payment_activity_notices.sql", directory), "utf8"));
    expect(await collectorSetupReady(settings, execute)).toBe(true);
    for (const table of ["bank_messages", "transactions", "messages", "notification_preferences", "bank_notice_receipts", "collector_event_receipts"]) {
      expect((await db.query<{ count: number }>(`select count(*)::int as count from public.${table}`)).rows[0].count).toBe(0);
    }
    await db.exec("drop function public.alfred_release_collector_event(uuid,text,text,uuid)");
    expect(await collectorSetupReady(settings, execute)).toBe(false);
  });

  it("fails closed for catalog failure or incomplete results, with no cached success", async () => {
    const failed = (async () => { throw new Error("synthetic private database detail"); }) as Execute;
    expect(await collectorSetupReady(settings, failed)).toBe(false);
    const empty = (async () => []) as Execute;
    expect(await collectorSetupReady(settings, empty)).toBe(false);
    const malformed = (async () => [{ ready: "true" }]) as unknown as Execute;
    expect(await collectorSetupReady(settings, malformed)).toBe(false);
  });
});
