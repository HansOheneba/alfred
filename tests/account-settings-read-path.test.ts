import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadAccountSettings, openAccount, openOwnerProfile } from "@/lib/accounts/settings-store";
import type { SupabaseSettings } from "@/lib/config";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/supabase/connection", () => ({ query: mocks.query }));

// Configuration and rows are synthetic; every database call is intercepted above.
const settings = {} as SupabaseSettings;
const OWNER = "00000000-0000-4000-8000-000000000001";
const TELEGRAM = 123456789;
const user = { id: OWNER, email: "fictional@example.invalid" };
const completeAccount = () => ({ id: OWNER, telegram_ready: true, conversation_ready: true, reminders_ready: true });
const settingsRow = () => ({
  preferred_name: "Fictional reviewer", currency: "GHS", timezone: "Africa/Accra", communication_preference: "detailed",
  financial_goals: "A fictional savings goal", telegram_user_id: String(TELEGRAM), locked_at: new Date("2026-01-01T12:00:00Z"),
  morning_enabled: true, commute_enabled: false, evening_enabled: true, morning_minute: 485, commute_minute: 540, evening_minute: 1200,
});

function expectOwnedRepair(calls: unknown[][]) {
  expect(calls).toHaveLength(4);
  expect(calls.map(([, sql]) => /^\s*insert into public\.([a-z_]+)/i.exec(String(sql))?.[1])).toEqual([
    "profiles", "telegram_accounts", "conversations", "reminder_preferences",
  ]);
  for (const [configuration, sql, values] of calls) {
    expect(configuration).toBe(settings);
    expect(values).toEqual([OWNER]);
    expect(sql).toMatch(/on conflict\s*\([^)]*\)\s*do nothing/i);
  }
}

beforeEach(() => {
  mocks.query.mockReset();
  vi.stubEnv("ALFRED_INVITES", "");
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("existing account loading avoids provisioning roundtrips", () => {
  it("uses one owner-scoped SELECT and no inserts when all companion rows already exist", async () => {
    mocks.query.mockResolvedValueOnce([completeAccount()]);

    expect(await openAccount(settings, user)).toBe("ready");

    expect(mocks.query).toHaveBeenCalledTimes(1);
    const [configuration, sql, values] = mocks.query.mock.calls[0];
    expect(configuration).toBe(settings); expect(values).toEqual([OWNER]);
    expect(sql).toMatch(/^\s*select\b/i);
    expect(sql).toMatch(/where\s+p\.id\s*=\s*\$1/i);
    expect(sql).not.toMatch(/\b(?:insert|update|delete)\b/i);
  });

  it.each(["telegram_ready", "conversation_ready", "reminders_ready"] as const)("preserves the four idempotent repairs when %s is missing", async (missing) => {
    mocks.query.mockResolvedValueOnce([{ ...completeAccount(), [missing]: false }]).mockResolvedValue([]);

    expect(await openAccount(settings, user)).toBe("ready");

    expect(mocks.query).toHaveBeenCalledTimes(5);
    expect(mocks.query.mock.calls[0][2]).toEqual([OWNER]);
    expectOwnedRepair(mocks.query.mock.calls.slice(1));
  });

  it("propagates a failed readiness read without attempting writes", async () => {
    const failure = new Error("Synthetic readiness failure");
    mocks.query.mockRejectedValueOnce(failure);
    await expect(openAccount(settings, user)).rejects.toBe(failure);
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });
});

describe("new account invite and Telegram behavior remains intact", () => {
  it("does not provision a new uninvited account", async () => {
    mocks.query.mockResolvedValueOnce([]);
    expect(await openAccount(settings, user)).toBe("not_invited");
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls[0][1]).not.toMatch(/\binsert\b/i);
  });

  it("still provisions all companion rows for a new invited account without a Telegram binding", async () => {
    vi.stubEnv("ALFRED_INVITES", user.email);
    mocks.query.mockResolvedValue([]);
    expect(await openAccount(settings, user)).toBe("ready");
    expect(mocks.query).toHaveBeenCalledTimes(5);
    expectOwnedRepair(mocks.query.mock.calls.slice(1));
  });

  it("still provisions and links an invited Telegram ID using only the new owner's row", async () => {
    vi.stubEnv("ALFRED_INVITES", `${user.email}:${TELEGRAM}`);
    mocks.query.mockResolvedValueOnce([]);
    for (let index = 0; index < 4; index++) mocks.query.mockResolvedValueOnce([]);
    mocks.query.mockResolvedValueOnce([{ locked_at: null }]).mockResolvedValueOnce([{ owner_id: OWNER }]);

    expect(await openAccount(settings, user)).toBe("ready");

    expect(mocks.query).toHaveBeenCalledTimes(7);
    expectOwnedRepair(mocks.query.mock.calls.slice(1, 5));
    const [, readSql, readValues] = mocks.query.mock.calls[5];
    expect(readSql).toMatch(/select locked_at from public\.telegram_accounts where owner_id\s*=\s*\$1/i);
    expect(readValues).toEqual([OWNER]);
    const [, updateSql, updateValues] = mocks.query.mock.calls[6];
    expect(updateSql).toMatch(/update public\.telegram_accounts/i);
    expect(updateSql).toMatch(/where owner_id\s*=\s*\$1 and locked_at is null/i);
    expect(updateValues).toEqual([OWNER, TELEGRAM]);
  });

  it("does not replace a Telegram binding that is already locked", async () => {
    vi.stubEnv("ALFRED_INVITES", `${user.email}:${TELEGRAM}`);
    mocks.query.mockResolvedValueOnce([]);
    for (let index = 0; index < 4; index++) mocks.query.mockResolvedValueOnce([]);
    mocks.query.mockResolvedValueOnce([{ locked_at: new Date("2026-01-01T12:00:00Z") }]);

    expect(await openAccount(settings, user)).toBe("ready");
    expect(mocks.query).toHaveBeenCalledTimes(6);
    expect(mocks.query.mock.calls.some(([, sql]) => /^\s*update\b/i.test(sql))).toBe(false);
  });
});

describe("account settings read first and repair only missing companion rows", () => {
  it("returns complete settings in one SELECT with no provisioning writes", async () => {
    mocks.query.mockResolvedValueOnce([settingsRow()]);
    expect(await loadAccountSettings(settings, OWNER)).toEqual({
      preferredName: "Fictional reviewer", currency: "GHS", timezone: "Africa/Accra", communicationPreference: "detailed",
      financialGoals: "A fictional savings goal", telegramUserId: String(TELEGRAM), telegramLocked: true,
      morningEnabled: true, commuteEnabled: false, eveningEnabled: true, morningTime: "08:05", commuteTime: "09:00", eveningTime: "20:00",
    });
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls[0][1]).toMatch(/join public\.conversations\s+c\s+on\s+c\.owner_id\s*=\s*p\.id/i);
    expect(mocks.query.mock.calls[0][2]).toEqual([OWNER]);
    expect(mocks.query.mock.calls[0][1]).not.toMatch(/\b(?:insert|update|delete)\b/i);
  });

  it("repairs missing rows then re-reads the same owner's settings in six calls", async () => {
    mocks.query.mockResolvedValueOnce([]);
    for (let index = 0; index < 4; index++) mocks.query.mockResolvedValueOnce([]);
    mocks.query.mockResolvedValueOnce([{ ...settingsRow(), telegram_user_id: null, locked_at: null }]);

    expect(await loadAccountSettings(settings, OWNER)).toMatchObject({ telegramUserId: "", telegramLocked: false });
    expect(mocks.query).toHaveBeenCalledTimes(6);
    expectOwnedRepair(mocks.query.mock.calls.slice(1, 5));
    expect(mocks.query.mock.calls[5]).toEqual(mocks.query.mock.calls[0]);
  });

  it("does not mistake a settings query failure for missing rows and run repairs", async () => {
    const failure = new Error("Synthetic settings read failure");
    mocks.query.mockRejectedValueOnce(failure);
    await expect(loadAccountSettings(settings, OWNER)).rejects.toBe(failure);
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it("reports an absent profile if repair still produces no settings row", async () => {
    mocks.query.mockResolvedValue([]);
    await expect(loadAccountSettings(settings, OWNER)).rejects.toThrow("account profile is missing");
    expect(mocks.query).toHaveBeenCalledTimes(6);
    expectOwnedRepair(mocks.query.mock.calls.slice(1, 5));
  });
});

describe("account read paths on an ephemeral synthetic PostgreSQL", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
      create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}'::jsonb);`);
    const directory = new URL("../supabase/migrations/", import.meta.url);
    for (const name of (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort()) {
      await db.exec(await readFile(new URL(name, directory), "utf8"));
    }
  }, 30_000);
  beforeEach(async () => {
    await db.exec("truncate auth.users cascade");
    // The actual profile trigger creates the initial complete companion rows.
    await db.query("insert into auth.users(id) values($1::uuid)", [OWNER]);
    await db.query("update public.profiles set preferred_name=$2,financial_goals=$3,communication_preference='detailed' where id=$1::uuid", [OWNER, "Fictional existing profile", "Keep this fictional goal"]);
    await db.query("update public.reminder_preferences set morning_enabled=true,morning_minute=485 where owner_id=$1::uuid", [OWNER]);
    mocks.query.mockImplementation(async (_configuration, sql: string, values: unknown[] = []) => (await db.query(sql, values)).rows);
  });
  afterAll(async () => { await db?.close(); });

  it("loads a complete existing account and its settings with one SELECT each and no insert calls", async () => {
    expect(await openAccount(settings, user)).toBe("ready");
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls[0][1]).toMatch(/^\s*select\b/i);
    mocks.query.mockClear();

    const loaded = await loadAccountSettings(settings, OWNER);
    expect(loaded).toMatchObject({ preferredName: "Fictional existing profile", financialGoals: "Keep this fictional goal", communicationPreference: "detailed", morningEnabled: true, morningTime: "08:05" });
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls[0][1]).not.toMatch(/\b(?:insert|update|delete)\b/i);
  });

  it("loads an authenticated owner's complete profile and companion readiness in one read", async () => {
    expect(await openOwnerProfile(settings, user)).toMatchObject({ profileId: OWNER, preferredName: "Fictional existing profile", currency: "GHS", communicationPreference: "detailed" });
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls[0][2]).toEqual([OWNER]);
    expect(mocks.query.mock.calls[0][1]).not.toMatch(/\b(?:insert|update|delete)\b/i);
  });

  it("keeps joined owner profiles and notes isolated between accounts", async () => {
    const otherOwner = "00000000-0000-4000-8000-000000000002";
    await db.query("insert into auth.users(id) values($1::uuid)", [otherOwner]);
    await db.query("update public.profiles set preferred_name='Fictional second person',currency='USD' where id=$1::uuid", [otherOwner]);
    await db.query("insert into public.assistant_notes(owner_id,tone_note) values($1::uuid,'Synthetic second-owner note') on conflict(owner_id) do update set tone_note=excluded.tone_note", [otherOwner]);
    const [first, second] = await Promise.all([openOwnerProfile(settings, user), openOwnerProfile(settings, { id: otherOwner })]);
    expect(first).toMatchObject({ profileId: OWNER, preferredName: "Fictional existing profile", currency: "GHS" });
    expect(second).toMatchObject({ profileId: otherOwner, preferredName: "Fictional second person", currency: "USD", toneNote: "Synthetic second-owner note" });
    expect(first).not.toHaveProperty("toneNote", "Synthetic second-owner note");
  });

  it.each(["telegram_accounts", "conversations", "reminder_preferences"] as const)("repairs an incomplete authenticated owner when %s is missing", async (table) => {
    await db.query(`delete from public.${table} where owner_id=$1::uuid`, [OWNER]);
    expect(await openOwnerProfile(settings, user)).toMatchObject({ profileId: OWNER, preferredName: "Fictional existing profile", communicationPreference: "detailed" });
    expect(mocks.query).toHaveBeenCalledTimes(6);
    expectOwnedRepair(mocks.query.mock.calls.slice(1, 5));
  });

  it("rejects an uninvited absent owner without provisioning", async () => {
    const absent = "00000000-0000-4000-8000-000000000003";
    expect(await openOwnerProfile(settings, { id: absent, email: "not-invited@example.invalid" })).toBe("not_invited");
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls[0][1]).not.toMatch(/\b(?:insert|update|delete)\b/i);
  });

  it("detects an actually missing conversation and repairs all companions without overwriting profile preferences", async () => {
    await db.query("delete from public.conversations where owner_id=$1::uuid", [OWNER]);

    expect(await openAccount(settings, user)).toBe("ready");
    expect(mocks.query).toHaveBeenCalledTimes(5);
    expectOwnedRepair(mocks.query.mock.calls.slice(1));
    expect((await db.query<{ count: number }>("select count(*)::int as count from public.conversations where owner_id=$1::uuid", [OWNER])).rows[0].count).toBe(1);
    expect((await db.query<{ preferred_name: string; financial_goals: string }>("select preferred_name,financial_goals from public.profiles where id=$1::uuid", [OWNER])).rows[0]).toEqual({ preferred_name: "Fictional existing profile", financial_goals: "Keep this fictional goal" });
    expect((await db.query<{ morning_enabled: boolean; morning_minute: number }>("select morning_enabled,morning_minute from public.reminder_preferences where owner_id=$1::uuid", [OWNER])).rows[0]).toEqual({ morning_enabled: true, morning_minute: 485 });
  });

  it.each(["telegram_accounts", "conversations", "reminder_preferences"] as const)("repairs an actually missing %s row then re-reads settings in six calls", async (table) => {
    // The table name is a fixed test case, never request-controlled input.
    await db.query(`delete from public.${table} where owner_id=$1::uuid`, [OWNER]);

    expect(await loadAccountSettings(settings, OWNER)).toMatchObject({ preferredName: "Fictional existing profile", financialGoals: "Keep this fictional goal", communicationPreference: "detailed" });
    expect(mocks.query).toHaveBeenCalledTimes(6);
    expectOwnedRepair(mocks.query.mock.calls.slice(1, 5));
    expect(mocks.query.mock.calls[5]).toEqual(mocks.query.mock.calls[0]);
    expect((await db.query<{ count: number }>(`select count(*)::int as count from public.${table} where owner_id=$1::uuid`, [OWNER])).rows[0].count).toBe(1);
  });
});
