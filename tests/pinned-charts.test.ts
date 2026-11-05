import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { SupabaseSettings } from "@/lib/config";
import type { ChartQuery } from "@/lib/finance/charts";
import { chartQuerySchema, MAX_PINS, MemoryPinStore } from "@/lib/finance/pins";

const transport = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/supabase/connection", () => ({ query: transport.query }));
import { createSupabasePinStore } from "@/lib/finance/pins";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const food: ChartQuery = { measure: "spending", by: "week", category: "Food", period: "this_month" };

describe("what a kept chart may contain", () => {
  it("accepts a chart description and refuses figures or anything extra", () => {
    expect(chartQuerySchema.safeParse(food).success).toBe(true);
    expect(chartQuerySchema.safeParse({ ...food, rows: [{ label: "Food", minor: 1 }] }).success).toBe(false);
    expect(chartQuerySchema.safeParse({ ...food, by: "person" }).success).toBe(false);
    expect(chartQuerySchema.safeParse({ ...food, startDate: "next week" }).success).toBe(false);
  });

  it("keeps the same chart once, per owner, up to the limit", async () => {
    const store = new MemoryPinStore();
    const first = await store.add(OWNER, "Food spending by week", food);
    expect(await store.add(OWNER, "Food spending by week", food)).toEqual(first);
    for (let index = 1; index < MAX_PINS; index++) await store.add(OWNER, "Chart", { ...food, month: index });
    expect(await store.add(OWNER, "One too many", { ...food, by: "day" })).toBeNull();
    expect(await store.remove(OTHER, first!.id)).toBe(false);
    expect(await store.remove(OWNER, first!.id)).toBe(true);
  });
});

describe("kept charts in an ephemeral SQL database", () => {
  let db: PGlite;
  const migration = readFileSync("supabase/migrations/20261105200000_pinned_charts.sql", "utf8");
  const store = createSupabasePinStore({} as SupabaseSettings);
  beforeAll(async () => {
    db = new PGlite();
    await db.exec("create role anon; create role authenticated; create table public.profiles(id uuid primary key);");
    await db.exec(migration);
    transport.query.mockImplementation(async (_settings: unknown, sql: string, values: unknown[] = []) => (await db.query(sql, values)).rows);
  }, 30_000);
  beforeEach(async () => {
    await db.exec("reset role; truncate profiles cascade");
    await db.query("insert into profiles values ($1), ($2)", [OWNER, OTHER]);
  });
  afterAll(async () => { await db.close(); });

  it("keeps a chart once, lists only the owner's, and stops at the limit", async () => {
    const first = await store.add(OWNER, "Food spending by week", food);
    expect(first).toMatchObject({ ownerId: OWNER, title: "Food spending by week", query: food });
    expect((await store.add(OWNER, "Again", food))?.id).toBe(first!.id);
    await store.add(OTHER, "Theirs", food);
    expect((await store.list(OWNER)).map((pin) => pin.id)).toEqual([first!.id]);
    for (let index = 1; index < MAX_PINS; index++) expect(await store.add(OWNER, "Chart", { ...food, month: index })).not.toBeNull();
    expect(await store.add(OWNER, "One too many", { ...food, by: "day" })).toBeNull();
    expect(await store.list(OWNER)).toHaveLength(MAX_PINS);
  });

  it("removes only the owner's own chart", async () => {
    const pin = await store.add(OWNER, "Food spending by week", food);
    expect(await store.remove(OTHER, pin!.id)).toBe(false);
    expect(await store.remove(OWNER, pin!.id)).toBe(true);
    expect(await store.list(OWNER)).toEqual([]);
  });

  it("gives browsers no direct access, and lists nothing before the table exists", async () => {
    await db.exec("set role authenticated");
    await expect(db.exec("select * from pinned_charts")).rejects.toThrow(/permission denied/);
    await db.exec("reset role; drop table pinned_charts");
    try {
      expect(await store.list(OWNER)).toEqual([]);
      await expect(store.add(OWNER, "Food", food)).rejects.toThrow(/aren't available/);
    } finally { await db.exec(migration); }
  });
});
