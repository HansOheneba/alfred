import { createECDH } from "node:crypto";
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseSettings } from "@/lib/config";
import type { Execute } from "@/lib/notifications/store";
import { formatOperatorReadiness, operatorChecksPass, operatorDatabase, operatorEnvironment } from "@/lib/notifications/operator-readiness";
import { recordRecoveryCompletion } from "@/lib/notifications/recovery";

const settings = {} as SupabaseSettings;
const pair = createECDH("prime256v1"); pair.generateKeys();
const environment = {
  VAPID_PUBLIC_KEY: pair.getPublicKey().toString("base64url"),
  VAPID_PRIVATE_KEY: pair.getPrivateKey().toString("base64url"),
  VAPID_SUBJECT: "mailto:synthetic-operator@example.com",
  ALFRED_PUSH_DELIVERY_ENABLED: "true",
  ALFRED_NOTIFICATION_SCHEDULES_ENABLED: "true",
  ALFRED_NOTIFICATION_CRON_SECRET: "synthetic-private-scheduler-secret",
  ALFRED_NOTIFICATION_RECOVERY_SCHEDULE_ID: "synthetic/worker",
  ALFRED_NOTIFICATION_RECOVERY_INTERVAL_SECONDS: "60",
};
let db: PGlite;
const execute: Execute = async <T extends Record<string, unknown>>(_settings: SupabaseSettings, sql: string, values: unknown[] = []) => (await db.query<T>(sql, values)).rows;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;
    create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}'::jsonb);`);
  const directory = new URL("../supabase/migrations/", import.meta.url);
  for (const name of (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort()) {
    await db.exec(await readFile(new URL(name, directory), "utf8"));
  }
});
beforeEach(async () => {
  await db.exec("truncate notification_recovery_health");
  vi.unstubAllEnvs();
  for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value);
});
afterAll(async () => { await db.close(); vi.unstubAllEnvs(); });

describe("private read-only operator checks", () => {
  it("checks configuration without claiming a database, scheduler or device was verified", () => {
    const result = operatorEnvironment(environment);
    expect(result).toEqual({ signingKeys: true, deliveryEnabled: true, recoveryConfigured: true, database: "not-checked", recovery: "not-checked" });
    expect(operatorChecksPass(result)).toBe(true);
    const text = formatOperatorReadiness(result).join("\n");
    expect(text).toContain("Scheduler registration and device display are not proved");
    expect(text).toContain("Database schema: not checked");
    for (const secret of [environment.VAPID_PUBLIC_KEY, environment.VAPID_PRIVATE_KEY, environment.VAPID_SUBJECT, environment.ALFRED_NOTIFICATION_CRON_SECRET, environment.ALFRED_NOTIFICATION_RECOVERY_SCHEDULE_ID]) expect(text).not.toContain(secret);
  });

  it("rejects a correctly shaped but mismatched or invalid signing pair", () => {
    const other = createECDH("prime256v1"); other.generateKeys();
    expect(operatorEnvironment({ ...environment, VAPID_PRIVATE_KEY: other.getPrivateKey().toString("base64url") }).signingKeys).toBe(false);
    expect(operatorEnvironment({ ...environment, VAPID_PRIVATE_KEY: Buffer.alloc(32).toString("base64url") }).signingKeys).toBe(false);
    expect(operatorEnvironment({ ...environment, VAPID_PUBLIC_KEY: "malformed" }).signingKeys).toBe(false);
  });

  it("keeps absent keys, delivery off and incomplete registration visible", () => {
    const result = operatorEnvironment({});
    expect(result).toMatchObject({ signingKeys: false, deliveryEnabled: false, recoveryConfigured: false });
    expect(operatorChecksPass(result)).toBe(false);
    expect(operatorEnvironment({ ...environment, ALFRED_NOTIFICATION_RECOVERY_INTERVAL_SECONDS: "3600" }).recoveryConfigured).toBe(false);
    expect(operatorEnvironment({ ...environment, ALFRED_NOTIFICATION_RECOVERY_SCHEDULE_ID: "" }).recoveryConfigured).toBe(false);
  });

  it("reads real catalog objects without manufacturing a first completed heartbeat", async () => {
    const result = await operatorDatabase(settings, { env: environment, execute });
    expect(result).toEqual({ database: "available", recovery: "never-completed" });
    expect(operatorChecksPass({ ...operatorEnvironment(environment), ...result })).toBe(false);
    expect((await db.query("select * from notification_recovery_health")).rows).toEqual([]);
  });

  it("observes an existing recent check-in, preserving the operational row and all empty financial tables", async () => {
    const now = new Date();
    await recordRecoveryCompletion(settings, now, execute);
    const before = (await db.query("select * from notification_recovery_health")).rows;
    const result = await operatorDatabase(settings, { env: environment, now, execute });
    expect(result).toEqual({ database: "available", recovery: "ready" });
    expect(operatorChecksPass({ ...operatorEnvironment(environment), ...result })).toBe(true);
    expect((await db.query("select * from notification_recovery_health")).rows).toEqual(before);
    expect((await db.query("select count(*)::int total from transactions union all select count(*)::int from bank_messages union all select count(*)::int from push_subscriptions union all select count(*)::int from notification_deliveries")).rows).toEqual([{ total: 0 }, { total: 0 }, { total: 0 }, { total: 0 }]);
  });

  it("does not call any application writer while checking schema/health", async () => {
    const calls: string[] = [];
    const read: Execute = async <T extends Record<string, unknown>>(config: SupabaseSettings, sql: string, values: unknown[] = []) => {
      calls.push(sql);
      return execute<T>(config, sql, values);
    };
    await operatorDatabase(settings, { env: environment, execute: read });
    expect(calls).toHaveLength(2);
    expect(calls.every((sql) => /^select\b/i.test(sql.trim()))).toBe(true);
    expect(calls.join("\n")).not.toMatch(/\b(insert|update|delete|dispatch|subscription\s*[,\s])\b/i);
  });

  it("fails closed for missing catalog objects and suppresses database error details", async () => {
    const missing = vi.fn(async () => [{ complete: false }]) as Execute;
    expect(await operatorDatabase(settings, { execute: missing })).toEqual({ database: "incomplete", recovery: "not-checked" });
    const failed: Execute = async () => { throw new Error("synthetic-private-password-and-host"); };
    const result = await operatorDatabase(settings, { execute: failed });
    expect(result).toEqual({ database: "unavailable", recovery: "not-checked" });
    expect(JSON.stringify(result)).not.toContain("synthetic-private");
  });

  it("does not mistake a stale or configuration-changed check-in for live recovery", async () => {
    const now = new Date();
    await recordRecoveryCompletion(settings, now, execute);
    expect(await operatorDatabase(settings, { env: environment, now: new Date(now.getTime() + 301_000), execute })).toMatchObject({ recovery: "stale" });
    expect(await operatorDatabase(settings, { env: { ...environment, ALFRED_NOTIFICATION_RECOVERY_SCHEDULE_ID: "synthetic/replaced" }, now, execute })).toMatchObject({ recovery: "configuration-changed" });
  });

  it("CLI with a clean environment prints statuses without seeking credentials or querying a database", async () => {
    const run = promisify(execFile);
    const outcome = await run(process.execPath, ["--import", "tsx", "scripts/check-automations.ts"], {
      cwd: new URL("../", import.meta.url), env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", ...environment },
    });
    expect(outcome.stderr).toBe("");
    expect(outcome.stdout).toContain("Push signing keys: valid matching pair");
    expect(outcome.stdout).toContain("Database schema: not checked");
    expect(outcome.stdout).not.toContain(environment.VAPID_PRIVATE_KEY);
    expect(outcome.stdout).not.toContain(environment.ALFRED_NOTIFICATION_CRON_SECRET);
  });
});
