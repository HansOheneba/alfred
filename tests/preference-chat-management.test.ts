import { createECDH } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import type { SupabaseSettings } from "@/lib/config";
import type { ActionContext } from "@/lib/finance/action-router";
import { MemoryFinanceStore } from "@/lib/finance/memory-store";
import {
  createSupabasePreferenceManagementStore, executePreferenceManagement, handlePreferenceManagement,
  MemoryPreferenceManagementStore, normaliseReminderTime, type PreferenceExecute,
} from "@/lib/accounts/preference-management";
import { preferenceActionSchema, preferencePendingSchema, type PreferencePending } from "@/lib/accounts/preference-management-schema";
import { recoveryConfiguration } from "@/lib/notifications/recovery";
import { profile, NOW } from "./helpers";

const OWNER = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const initialProfile = { preferredName: "Synthetic owner", currency: "GHS", timezone: "Africa/Accra", communicationPreference: "concise" as const, financialGoals: "Build a buffer" };
const initialReminders = { morningEnabled: false, commuteEnabled: false, eveningEnabled: false, morningTime: "08:00", commuteTime: "08:30", eveningTime: "20:00" };
const initialNotifications = { paymentMentions: false, outgoingMentions: false, paymentPush: false, paymentPreview: false, billReminders: false, weeklyOverview: false };
afterEach(() => vi.unstubAllEnvs());
function fixture() {
  const preferences = new MemoryPreferenceManagementStore();
  for (const ownerId of [OWNER, OTHER]) {
    preferences.profiles.set(ownerId, { values: { ...initialProfile }, revision: `profile:${ownerId}` });
    preferences.reminders.set(ownerId, { values: { ...initialReminders }, revision: `reminders:${ownerId}`, timezone: "Africa/Accra" });
    preferences.notifications.set(ownerId, { values: { ...initialNotifications }, revision: `notifications:${ownerId}` });
  }
  let counter = 0;
  const ctx: ActionContext & { preferences: MemoryPreferenceManagementStore } = {
    profile: profile(42, { profileId: OWNER }), store: new MemoryFinanceStore(), preferences,
    now: NOW, updateId: 1, chatId: 100, confirmTransactions: "auto", pendingTtlMs: 60_000,
    createId: () => `synthetic-${++counter}`, createActionId: () => `preference${++counter}`,
  };
  return { ctx, preferences };
}
async function pending(ctx: ActionContext): Promise<PreferencePending> {
  const records = await ctx.store.listPendingActions(ctx.profile.profileId);
  return preferencePendingSchema.parse(JSON.parse(records.at(-1)!.payloadJson));
}

describe("confirmed preference management", () => {
  it("reads actual settings without creating a pending change or exposing connection bindings", async () => {
    const { ctx } = fixture();
    const result = await handlePreferenceManagement({ type: "read_settings", section: "all" }, ctx);
    expect(result).toMatchObject({ kind: "text" });
    expect(result.text).toContain('Preferred name: "Synthetic owner"');
    expect(result.text).toContain("local timezone Africa/Accra");
    expect(result.text).not.toContain("telegramUserId");
    expect(await ctx.store.listPendingActions(OWNER)).toEqual([]);
  });

  it("reviews exact before/after values and updates only the authenticated owner's requested profile fields", async () => {
    const { ctx, preferences } = fixture();
    const other = await preferences.readProfile(OTHER);
    const result = await handlePreferenceManagement({ type: "update_profile_settings", changes: { preferredName: "Synthetic nickname", currency: "USD" } }, ctx);
    expect(result).toMatchObject({ kind: "confirm" });
    expect(result.text).toContain('Preferred name: "Synthetic owner" → "Synthetic nickname"');
    expect(result.text).toContain('Default currency: "GHS" → "USD"');
    expect((await preferences.readProfile(OWNER)).values).toEqual(initialProfile);
    const confirmed = await executePreferenceManagement(await pending(ctx), ctx);
    expect(confirmed.text).toContain("Saved those profile preferences");
    expect((await preferences.readProfile(OWNER)).values).toEqual({ ...initialProfile, preferredName: "Synthetic nickname", currency: "USD" });
    expect(await preferences.readProfile(OTHER)).toEqual(other);
  });

  it("rejects stale settings confirmations without overwriting a later change", async () => {
    const { ctx, preferences } = fixture();
    await handlePreferenceManagement({ type: "update_profile_settings", changes: { communicationPreference: "detailed" } }, ctx);
    const action = await pending(ctx);
    await preferences.updateProfile(OWNER, await preferences.readProfile(OWNER), { financialGoals: "A newer goal" });
    expect((await executePreferenceManagement(action, ctx)).text).toContain("changed since I asked");
    expect((await preferences.readProfile(OWNER)).values).toEqual({ ...initialProfile, financialGoals: "A newer goal" });
  });

  it("asks AM/PM for ambiguous times, normalises explicit times and states reminder timezone and delivery limits", async () => {
    const { ctx, preferences } = fixture();
    for (const time of ["8", "8:00", "24:00", "08:60", "tomorrow"]) {
      const result = await handlePreferenceManagement({ type: "update_reminder_settings", changes: { morningTime: time } }, ctx);
      expect(result.kind).toBe("text");
      expect(result.text).toContain("AM or PM");
    }
    expect(await ctx.store.listPendingActions(OWNER)).toEqual([]);
    const result = await handlePreferenceManagement({ type: "update_reminder_settings", changes: { morningEnabled: true, morningTime: "8 pm" } }, ctx);
    expect(result.kind).toBe("confirm");
    expect(result.text).toContain('Morning time: "08:00" → "20:00"');
    expect(result.text).toContain("Africa/Accra");
    expect(result.text).toContain("does not guarantee delivery");
    expect((await executePreferenceManagement(await pending(ctx), ctx)).text).toContain("Saved those check-in preferences");
    expect((await preferences.readReminders(OWNER)).values).toEqual({ ...initialReminders, morningEnabled: true, morningTime: "20:00" });
    expect(normaliseReminderTime("12 am")).toBe("00:00");
    expect(normaliseReminderTime("12 pm")).toBe("12:00");
  });

  it("invalidates reminder review when timezone changes and supports a fresh review in the new timezone", async () => {
    const { ctx, preferences } = fixture();
    const original = await preferences.readReminders(OWNER);
    await preferences.updateProfile(OWNER, await preferences.readProfile(OWNER), { timezone: "Europe/London" });
    expect(await preferences.updateReminders(OWNER, original, { morningEnabled: true })).toBe(false);
    const current = await preferences.readReminders(OWNER);
    expect(current.timezone).toBe("Europe/London");
    expect(await preferences.updateReminders(OWNER, current, { morningEnabled: true })).toBe(true);
    expect((await preferences.readReminders(OWNER)).values.morningEnabled).toBe(true);
    expect((await preferences.readReminders(OTHER)).values.morningEnabled).toBe(false);
    expect(ctx.profile.timezone).toBe("Africa/Accra");
  });

  it("checks push readiness at proposal and again at confirmation while allowing opt-out", async () => {
    const { ctx, preferences } = fixture();
    for (const flag of ["paymentPush", "billReminders", "weeklyOverview"] as const) {
      const result = await handlePreferenceManagement({ type: "update_notification_settings", changes: { [flag]: true } }, ctx);
      expect(result.kind).toBe("text");
      expect(result.text).toContain("recent healthy scheduled recovery");
    }
    expect(await ctx.store.listPendingActions(OWNER)).toEqual([]);
    preferences.ready = true;
    expect((await handlePreferenceManagement({ type: "update_notification_settings", changes: { paymentPush: true } }, ctx)).kind).toBe("confirm");
    const action = await pending(ctx);
    preferences.ready = false;
    expect((await executePreferenceManagement(action, ctx)).text).toContain("Nothing was changed");
    expect((await preferences.readNotifications(OWNER)).values.paymentPush).toBe(false);
    preferences.notifications.get(OWNER)!.values.paymentPush = true;
    ctx.updateId++;
    expect((await handlePreferenceManagement({ type: "update_notification_settings", changes: { paymentPush: false } }, ctx)).kind).toBe("confirm");
    expect((await executePreferenceManagement(await pending(ctx), ctx)).text).toContain("Saved those notification preferences");
  });

  it("supports a first notification opt-in from verified all-off defaults and rejects concurrent creation", async () => {
    const { ctx, preferences } = fixture();
    preferences.notifications.delete(OWNER);
    const absent = await preferences.readNotifications(OWNER);
    expect(absent).toEqual({ values: initialNotifications, revision: "absent" });
    expect(preferences.notifications.has(OWNER)).toBe(false);
    expect(await preferences.updateNotifications(OWNER, absent, { paymentMentions: true })).toBe(true);
    expect(await preferences.updateNotifications(OWNER, absent, { outgoingMentions: true })).toBe(false);
    expect((await preferences.readNotifications(OWNER)).values).toEqual({ ...initialNotifications, paymentMentions: true });
    expect((await handlePreferenceManagement({ type: "read_settings", section: "notifications" }, ctx)).text).toContain("Payment mentions: on");
  });

  it("fails closed on unavailable storage and invalid field/timezone patches without creating settings", async () => {
    const { ctx, preferences } = fixture();
    expect(preferenceActionSchema.safeParse({ type: "update_profile_settings", changes: { telegramUserId: "999" } }).success).toBe(false);
    expect(preferenceActionSchema.safeParse({ type: "update_profile_settings", changes: { timezone: "Made/Up" } }).success).toBe(false);
    expect(preferenceActionSchema.safeParse({ type: "update_profile_settings", changes: {} }).success).toBe(false);
    preferences.profiles.delete(OWNER);
    const result = await handlePreferenceManagement({ type: "read_settings", section: "profile" }, ctx);
    expect(result.text).toContain("can't load these settings");
    expect(result.text).not.toContain("Default currency");
    expect(await ctx.store.listPendingActions(OWNER)).toEqual([]);
    expect(preferences.profiles.has(OWNER)).toBe(false);
  });

  it("does not offer a confirmation when exact review values would be truncated in chat", async () => {
    const { ctx, preferences } = fixture();
    preferences.profiles.get(OWNER)!.values.financialGoals = "x".repeat(2000);
    const result = await handlePreferenceManagement({ type: "update_profile_settings", changes: { financialGoals: "y".repeat(2000) } }, ctx);
    expect(result.kind).toBe("text");
    expect(result.text).toContain("review the full values");
    expect(await ctx.store.listPendingActions(OWNER)).toEqual([]);
  });
});

describe("owner-scoped partial settings SQL", () => {
  let db: PGlite | undefined;
  afterEach(async () => { await db?.close(); db = undefined; });
  async function database() {
    db = new PGlite();
    await db.exec(`create table public.profiles(id uuid primary key,preferred_name text,currency text,timezone text,communication_preference text,financial_goals text,account_names text,updated_at timestamptz default now());
      create table public.telegram_accounts(owner_id uuid primary key,telegram_user_id text,locked_at timestamptz);
      create table public.reminder_preferences(owner_id uuid primary key,morning_enabled boolean,commute_enabled boolean,evening_enabled boolean,morning_minute integer,commute_minute integer,evening_minute integer,updated_at timestamptz default now());
      create table public.notification_preferences(owner_id uuid primary key,payment_mentions boolean,outgoing_mentions boolean,payment_push boolean,payment_preview boolean,bill_reminders boolean,weekly_overview boolean,
        payment_mentions_since timestamptz,outgoing_mentions_since timestamptz,payment_push_since timestamptz,bill_reminders_since timestamptz,weekly_overview_since timestamptz,
        payment_epoch integer,bill_epoch integer,weekly_epoch integer,message_push boolean default true,updated_at timestamptz default now());`);
    for (const ownerId of [OWNER, OTHER]) {
      await db.query("insert into public.profiles values($1::uuid,'Synthetic owner','GHS','Africa/Accra','concise','Build a buffer','Preserved account names','2026-11-01T00:00:00Z')", [ownerId]);
      await db.query("insert into public.telegram_accounts values($1::uuid,'synthetic-link','2026-11-01T00:00:00Z')", [ownerId]);
      await db.query("insert into public.reminder_preferences values($1::uuid,false,false,false,480,510,1200,'2026-11-01T00:00:00Z')", [ownerId]);
      await db.query("insert into public.notification_preferences values($1::uuid,false,false,false,false,false,false,null,null,null,null,null,0,0,0,true,'2026-11-01T00:00:00Z')", [ownerId]);
    }
    const execute: PreferenceExecute = async <T extends Record<string, unknown>>(_settings: SupabaseSettings, sql: string, values?: unknown[]) => (await db!.query<T>(sql, values)).rows;
    return createSupabasePreferenceManagementStore({} as SupabaseSettings, { execute, pushReady: async () => true });
  }

  it("executes partial profile CAS without changing unrelated fields or Telegram and refuses stale/foreign snapshots", async () => {
    const store = await database();
    const snapshot = await store.readProfile(OWNER);
    expect(await store.updateProfile(OWNER, snapshot, { preferredName: "Synthetic nickname" })).toBe(true);
    expect(await store.updateProfile(OWNER, snapshot, { currency: "USD" })).toBe(false);
    expect((await store.readProfile(OWNER)).values).toEqual({ ...initialProfile, preferredName: "Synthetic nickname" });
    expect((await store.readProfile(OTHER)).values).toEqual(initialProfile);
    expect((await db!.query("select account_names from profiles where id=$1::uuid", [OWNER])).rows).toEqual([{ account_names: "Preserved account names" }]);
    expect((await db!.query("select telegram_user_id from telegram_accounts where owner_id=$1::uuid", [OWNER])).rows).toEqual([{ telegram_user_id: "synthetic-link" }]);
    await expect(store.readProfile("00000000-0000-4000-8000-000000000099")).rejects.toThrow();
  });

  it("executes reminder CAS against the reviewed timezone and preserves other check-ins", async () => {
    const store = await database();
    const old = await store.readReminders(OWNER);
    await store.updateProfile(OWNER, await store.readProfile(OWNER), { timezone: "Europe/London" });
    expect(await store.updateReminders(OWNER, old, { morningEnabled: true })).toBe(false);
    const current = await store.readReminders(OWNER);
    expect(await store.updateReminders(OWNER, current, { morningEnabled: true, morningTime: "09:15" })).toBe(true);
    expect((await store.readReminders(OWNER)).values).toEqual({ ...initialReminders, morningEnabled: true, morningTime: "09:15" });
    expect((await store.readReminders(OTHER)).values).toEqual(initialReminders);
  });

  it("preserves notification epochs, opt-in windows and unrelated flags; supports absent-row CAS", async () => {
    const store = await database();
    const before = await store.readNotifications(OWNER);
    expect(await store.updateNotifications(OWNER, before, { paymentPush: true, outgoingMentions: true })).toBe(true);
    expect(await store.updateNotifications(OWNER, before, { billReminders: true })).toBe(false);
    let row = (await db!.query<Record<string, unknown>>("select * from notification_preferences where owner_id=$1::uuid", [OWNER])).rows[0];
    expect(row).toMatchObject({ payment_push: true, outgoing_mentions: true, payment_epoch: 1, bill_epoch: 0, weekly_epoch: 0, message_push: true, bill_reminders: false });
    expect(row.payment_push_since).not.toBeNull();
    expect(row.outgoing_mentions_since).not.toBeNull();
    expect(await store.updateNotifications(OWNER, await store.readNotifications(OWNER), { paymentPush: false })).toBe(true);
    row = (await db!.query<Record<string, unknown>>("select * from notification_preferences where owner_id=$1::uuid", [OWNER])).rows[0];
    expect(row).toMatchObject({ payment_push: false, payment_push_since: null, payment_epoch: 2, outgoing_mentions: true, message_push: true });
    expect((await store.readNotifications(OTHER)).values).toEqual(initialNotifications);
    await db!.query("delete from notification_preferences where owner_id=$1::uuid", [OWNER]);
    const absent = await store.readNotifications(OWNER);
    expect(absent).toEqual({ revision: "absent", values: initialNotifications });
    expect(await store.updateNotifications(OWNER, absent, { weeklyOverview: true })).toBe(true);
    expect(await store.updateNotifications(OWNER, absent, { billReminders: true })).toBe(false);
    row = (await db!.query<Record<string, unknown>>("select * from notification_preferences where owner_id=$1::uuid", [OWNER])).rows[0];
    expect(row).toMatchObject({ weekly_overview: true, weekly_epoch: 1, payment_epoch: 0, bill_epoch: 0 });
  });

  it("never treats a missing table or failed read as default preferences", async () => {
    const store = await database();
    await db!.exec("drop table notification_preferences");
    await expect(store.readNotifications(OWNER)).rejects.toThrow();
  });

  it("requires every existing push prerequisite before the SQL writer can enable a push preference", async () => {
    const key = createECDH("prime256v1"); key.generateKeys();
    for (const [name, value] of Object.entries({
      VAPID_PUBLIC_KEY: key.getPublicKey().toString("base64url"), VAPID_PRIVATE_KEY: key.getPrivateKey().toString("base64url"), VAPID_SUBJECT: "mailto:synthetic@example.invalid",
      ALFRED_PUSH_DELIVERY_ENABLED: "true", ALFRED_NOTIFICATION_SCHEDULES_ENABLED: "true", ALFRED_NOTIFICATION_CRON_SECRET: "synthetic-recovery-secret",
      ALFRED_NOTIFICATION_RECOVERY_SCHEDULE_ID: "synthetic-preferences", ALFRED_NOTIFICATION_RECOVERY_INTERVAL_SECONDS: "60",
    })) vi.stubEnv(name, value);
    let policyReady = true, recoveryReady = true, writes = 0;
    const execute: PreferenceExecute = async <T extends Record<string, unknown>>(_settings: SupabaseSettings, sql: string) => {
      if (sql.includes("to_regprocedure")) return [{ ready: policyReady }] as unknown as T[];
      if (sql.includes("from public.notification_recovery_health")) return [{ configuration_fingerprint: recoveryConfiguration().fingerprint, last_completed_at: recoveryReady ? new Date() : null, last_failed_at: null }] as unknown as T[];
      writes++; return [{ owner_id: OWNER }] as unknown as T[];
    };
    const store = createSupabasePreferenceManagementStore({} as SupabaseSettings, { execute });
    const expected = { revision: "synthetic-review", values: { ...initialNotifications } };
    expect(await store.pushReady()).toBe(true);
    vi.stubEnv("ALFRED_PUSH_DELIVERY_ENABLED", "false");
    expect(await store.updateNotifications(OWNER, expected, { paymentPush: true })).toBe(false);
    vi.stubEnv("ALFRED_PUSH_DELIVERY_ENABLED", "true");
    policyReady = false;
    expect(await store.updateNotifications(OWNER, expected, { billReminders: true })).toBe(false);
    policyReady = true; recoveryReady = false;
    expect(await store.updateNotifications(OWNER, expected, { weeklyOverview: true })).toBe(false);
    recoveryReady = true; vi.stubEnv("VAPID_PUBLIC_KEY", "invalid");
    expect(await store.updateNotifications(OWNER, expected, { paymentPush: true })).toBe(false);
    expect(writes).toBe(0);
  });
});
