import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseSettings } from "@/lib/config";
import { categoryList, normalizeCategory, readCategories, resolveCategory, validateCategoryName } from "@/lib/finance/categories";
import { MemoryFinanceStore } from "@/lib/finance/memory-store";
import type { FinanceStore, NewBudget, NewCategory } from "@/lib/finance/store";

const transport = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/supabase/connection", () => ({ query: transport.query }));
import { createSupabaseFinanceStore } from "@/lib/supabase/finance-store";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW = "2026-11-05T15:00:00.000Z";
const category = (patch: Partial<NewCategory> = {}): NewCategory => ({ categoryId: "synthetic-shopping", userId: OWNER, name: "Shopping", type: "expense", createdAt: NOW, ...patch });
const budget = (patch: Partial<NewBudget> = {}): NewBudget => ({ budgetId: "synthetic-budget", userId: OWNER, category: "Shopping", period: "2026-11", amount: "2000.00", currency: "GHS", createdAt: NOW, updatedAt: NOW, ...patch });

describe("custom category validation and memory persistence", () => {
  it("keeps built-in aliases stable and accepts only explicitly saved custom names", async () => {
    const store = new MemoryFinanceStore();
    expect(normalizeCategory("Shopping", "expense")).toBeNull();
    for (const name of ["Food", "lunch", "CLOTHES", " ", "A\nB", "a".repeat(41), "<script>"]) expect(validateCategoryName(name, "expense").ok, name).toBe(false);
    expect(validateCategoryName(" Gift ", "income").ok).toBe(false);
    expect(validateCategoryName("Travel & gear", "expense")).toEqual({ ok: true, name: "Travel & gear" });
    const saved = await store.createCategory(category({ name: "  Shopping   supplies  " }));
    expect(saved.name).toBe("Shopping supplies");
    expect(await resolveCategory(store, OWNER, "SHOPPING SUPPLIES", "expense")).toBe("Shopping supplies");
    expect(await resolveCategory(store, OTHER, "Shopping supplies", "expense")).toBeNull();
    expect(await resolveCategory(store, OWNER, "Shopping supplies", "income")).toBeNull();
    expect(categoryList("expense", await readCategories(store, OWNER))).toContain("Shopping supplies");
    expect(normalizeCategory("clothes", "expense", await readCategories(store, OWNER))).toBe("Personal");
  });

  it("deduplicates case-insensitively without sharing names across owners or transaction types", async () => {
    const store = new MemoryFinanceStore();
    const first = await store.createCategory(category());
    expect(await store.createCategory(category({ categoryId: "retry", name: "shopping" }))).toEqual(first);
    await store.createCategory(category({ categoryId: "other", userId: OTHER }));
    await store.createCategory(category({ categoryId: "income", type: "income" }));
    expect((await store.listCategories(OWNER)).map((row) => row.type)).toEqual(["expense", "income"]);
    expect(await store.listCategories(OTHER)).toHaveLength(1);
    const untrusted = { listCategories: async () => [{ ...first, userId: OTHER }] } as unknown as FinanceStore;
    expect(await readCategories(untrusted, OWNER)).toEqual([]);
    expect(await readCategories({} as FinanceStore, OWNER)).toEqual([]);
  });

  it("commits a category and first budget together and rejects invalid or foreign budgets before writing", async () => {
    const store = new MemoryFinanceStore();
    for (const patch of [{ userId: OTHER }, { category: "Food" }, { amount: "0.00" }, { amount: "bad" }, { currency: "bad" }, { period: "2026-13" }]) {
      await expect(store.createCategory(category(), budget(patch))).rejects.toThrow();
      expect(await store.listCategories(OWNER)).toHaveLength(0);
      expect(await store.listBudgets(OWNER)).toHaveLength(0);
    }
    await store.createCategory(category(), budget());
    expect(await store.listCategories(OWNER)).toHaveLength(1);
    expect(await store.listBudgets(OWNER)).toMatchObject([{ category: "Shopping", amount: "2000.00" }]);
    await expect(store.createCategory(category(), budget({ amount: "3000.00" }))).rejects.toThrow("already exists");
    expect((await store.listBudgets(OWNER))[0].amount).toBe("2000.00");
  });

  it("does not overwrite a budget that appeared after a category proposal, even on overlapping requests", async () => {
    const store = new MemoryFinanceStore();
    await store.saveBudget(budget({ amount: "900.00" }));
    await expect(store.createCategory(category(), budget())).rejects.toThrow("already exists");
    expect(await store.listCategories(OWNER)).toEqual([]);
    expect((await store.listBudgets(OWNER))[0].amount).toBe("900.00");
    const clean = new MemoryFinanceStore();
    const results = await Promise.allSettled([clean.createCategory(category(), budget()), clean.createCategory(category({ name: "shopping" }), budget({ amount: "3000.00" }))]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await clean.listCategories(OWNER)).toHaveLength(1);
    expect((await clean.listBudgets(OWNER))[0].amount).toBe("2000.00");
  });

  it("deletes only an owned budget matching the full confirmation snapshot", async () => {
    const store = new MemoryFinanceStore();
    const first = await store.saveBudget(budget());
    expect(await store.deleteBudget(OTHER, first.budgetId, first)).toBe(false);
    await store.saveBudget(budget({ amount: "2500.00", updatedAt: "2026-11-05T15:01:00.000Z" }));
    expect(await store.deleteBudget(OWNER, first.budgetId, first)).toBe(false);
    const current = (await store.listBudgets(OWNER))[0];
    expect(await store.deleteBudget(OWNER, first.budgetId, current)).toBe(true);
    expect(await store.listBudgets(OWNER)).toEqual([]);
  });
});

describe("custom categories in an ephemeral SQL database", () => {
  let db: PGlite;
  const migration = readFileSync("supabase/migrations/20261105144649_custom_categories.sql", "utf8");
  const store = createSupabaseFinanceStore({} as SupabaseSettings);
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`create role anon;create role authenticated;create schema auth;
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;
      create table public.profiles(id uuid primary key);
      create table public.budgets(id bigint generated always as identity primary key,budget_id text unique not null,user_id text not null,
        owner_id uuid not null references profiles(id),period text not null,category text not null,amount numeric(12,2) not null check(amount>0),currency text not null,
        created_at timestamptz not null,updated_at timestamptz not null,unique(owner_id,period,category,currency));`);
    await db.exec(migration);
    transport.query.mockImplementation(async (_settings: unknown, sql: string, values: unknown[] = []) => (await db.query(sql, values)).rows);
  }, 30_000);
  beforeEach(async () => {
    await db.exec("reset role;truncate profiles cascade");
    await db.query("insert into profiles values($1),($2)", [OWNER, OTHER]);
  });
  afterAll(async () => { await db.close(); });

  it("uses the same owner-scoped category identity on retries and canonical spelling for the budget", async () => {
    const first = await store.createCategory!(category());
    expect(await store.createCategory!(category({ categoryId: "retry", name: "shopping" }), budget())).toEqual(first);
    expect(await store.listCategories!(OTHER)).toEqual([]);
    expect(await store.listBudgets(OWNER)).toMatchObject([{ category: "Shopping", amount: "2000.00" }]);
    await store.createCategory!(category({ categoryId: "other", userId: OTHER }));
    expect(await store.listCategories!(OTHER)).toHaveLength(1);
  });

  it("rolls back category creation if the first budget conflicts or its insertion fails", async () => {
    await store.saveBudget(budget({ amount: "900.00" }));
    await expect(store.createCategory!(category(), budget())).rejects.toThrow(/unique constraint/);
    expect(await store.listCategories!(OWNER)).toEqual([]);
    expect((await store.listBudgets(OWNER))[0].amount).toBe("900.00");
    await db.exec("create function synthetic_budget_failure() returns trigger language plpgsql as $$begin raise exception 'Synthetic budget failure';end$$;create trigger synthetic_budget_failure before insert on budgets for each row execute function synthetic_budget_failure()");
    try {
      await expect(store.createCategory!(category({ name: "Travel gear" }), budget({ category: "Travel gear" }))).rejects.toThrow("Synthetic budget failure");
      expect(await store.listCategories!(OWNER)).toEqual([]);
    } finally { await db.exec("drop trigger synthetic_budget_failure on budgets;drop function synthetic_budget_failure()"); }
  });

  it("rejects another owner's combined budget and stale deletion snapshots", async () => {
    await expect(store.createCategory!(category(), budget({ userId: OTHER }))).rejects.toThrow("invalid");
    expect(await store.listCategories!(OWNER)).toEqual([]);
    const first = await store.saveBudget(budget());
    expect(await store.deleteBudget(OTHER, first.budgetId, first)).toBe(false);
    await store.saveBudget(budget({ amount: "2500.00", updatedAt: "2026-11-05T15:01:00.000Z" }));
    expect(await store.deleteBudget(OWNER, first.budgetId, first)).toBe(false);
    expect(await store.deleteBudget(OWNER, first.budgetId, (await store.listBudgets(OWNER))[0])).toBe(true);
  });

  it("preserves imported microsecond versions and rejects changes within the same millisecond", async () => {
    await store.saveBudget(budget({ updatedAt: "2026-11-05T15:00:00.123456Z" }));
    const first = (await store.listBudgets(OWNER))[0];
    expect(first.updatedAt).toBe("2026-11-05T15:00:00.123456Z");
    await db.query("update budgets set updated_at='2026-11-05T15:00:00.123457Z' where owner_id=$1", [OWNER]);
    expect(await store.deleteBudget(OWNER, first.budgetId, first)).toBe(false);
    const current = (await store.listBudgets(OWNER))[0];
    expect(current.updatedAt).toBe("2026-11-05T15:00:00.123457Z");
    expect(await store.deleteBudget(OWNER, first.budgetId, current)).toBe(true);
    await store.saveBudget(budget({ updatedAt: NOW }));
    expect((await store.listBudgets(OWNER))[0].updatedAt).toBe(NOW);
  });

  it("permits owner-only authenticated reads and denies direct client mutations and anonymous reads", async () => {
    await store.createCategory!(category());
    await store.createCategory!(category({ categoryId: "other", userId: OTHER }));
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [OWNER]);
    await db.exec("set role authenticated");
    expect((await db.query("select owner_id::text from custom_categories")).rows).toEqual([{ owner_id: OWNER }]);
    await expect(db.exec("delete from custom_categories")).rejects.toThrow(/permission denied/);
    await expect(db.query("insert into custom_categories(category_id,owner_id,name,type) values('forged',$1,'Forged','expense')", [OWNER])).rejects.toThrow(/permission denied/);
    await db.exec("reset role;set role anon");
    await expect(db.exec("select * from custom_categories")).rejects.toThrow(/permission denied/);
    await db.exec("reset role");
  });

  it("keeps fixed-category reads available but rejects custom writes when the additive schema is absent", async () => {
    await db.exec("drop table custom_categories");
    try {
      expect(await store.listCategories!(OWNER)).toEqual([]);
      await expect(store.createCategory!(category(), budget())).rejects.toThrow("not ready");
      expect(await store.listBudgets(OWNER)).toEqual([]);
    } finally { await db.exec(migration); }
  });
});
