import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), mentions: vi.fn(), dispatch: vi.fn() }));
vi.mock("@/lib/supabase/connection", () => ({ query: mocks.query }));
vi.mock("@/lib/env", () => ({ getDatabaseSettings: () => ({ fixture: true }) }));
vi.mock("@/lib/bank/notices", () => ({ recoverAllIncomingPaymentMentions: mocks.mentions }));
vi.mock("@/lib/notifications/service", () => ({ dispatchScheduledNotifications: mocks.dispatch }));

import type { SupabaseSettings } from "@/lib/config";
import { POST } from "@/app/api/notifications/dispatch/route";
import { loadRecoveryStatus, recordRecoveryCompletion } from "@/lib/notifications/recovery";

const settings = { fixture: true } as unknown as SupabaseSettings;
let db: PGlite;
const call = () => POST(new Request("https://alfred.example/api/notifications/dispatch", {
  method: "POST", headers: { authorization: "Bearer synthetic-dispatch-secret" },
}));

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;
    create table public.profiles(id uuid primary key);`);
  for (const name of ["20261103110000_notifications.sql", "20261103200000_notification_recovery.sql"]) {
    await db.exec(await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8"));
  }
});

beforeEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("ALFRED_NOTIFICATION_CRON_SECRET", "synthetic-dispatch-secret");
  vi.stubEnv("ALFRED_NOTIFICATION_SCHEDULES_ENABLED", "true");
  vi.stubEnv("ALFRED_NOTIFICATION_RECOVERY_SCHEDULE_ID", "synthetic/dispatcher");
  vi.stubEnv("ALFRED_NOTIFICATION_RECOVERY_INTERVAL_SECONDS", "300");
  mocks.query.mockImplementation(async (_settings: SupabaseSettings, text: string, values: unknown[] = []) =>
    (await db.query(text, values)).rows);
  mocks.mentions.mockResolvedValue(0);
  mocks.dispatch.mockResolvedValue({ enabled: true, queued: 0, owners: 0 });
  await db.exec("truncate public.notification_recovery_health");
});

afterAll(async () => { await db.close(); vi.unstubAllEnvs(); });

describe("authenticated dispatcher health with actual database persistence", () => {
  it("invalidates a recent healthy heartbeat after mention failure and restores it only after full recovery", async () => {
    const previous = new Date(Date.now() - 1000);
    await recordRecoveryCompletion(settings, previous);
    expect((await loadRecoveryStatus(settings)).ready).toBe(true);
    mocks.mentions.mockRejectedValueOnce(new Error("synthetic receipt storage unavailable"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try { expect((await call()).status).toBe(503); } finally { logged.mockRestore(); }
    expect(await loadRecoveryStatus(settings)).toMatchObject({ ready: false, reason: "failed", lastCompletedAt: previous.toISOString() });
    expect(mocks.dispatch).not.toHaveBeenCalled();
    const failed = (await db.query<{ last_failed_at: Date | null }>("select last_failed_at from notification_recovery_health")).rows[0];
    expect(failed.last_failed_at).not.toBeNull();

    mocks.mentions.mockResolvedValueOnce(3);
    const retry = await call();
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ recoveryCheckedIn: true, mentionsRecovered: 3 });
    expect(await loadRecoveryStatus(settings)).toMatchObject({ ready: true, reason: "ready" });
    expect((await db.query<{ last_failed_at: Date | null }>("select last_failed_at from notification_recovery_health")).rows[0].last_failed_at).toBeNull();
    expect(mocks.dispatch).toHaveBeenCalledOnce();
  });

  it("does not manufacture a first successful check-in when mention recovery is broken", async () => {
    mocks.mentions.mockRejectedValueOnce(new Error("synthetic missing notice function"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try { expect((await call()).status).toBe(503); } finally { logged.mockRestore(); }
    expect(await loadRecoveryStatus(settings)).toMatchObject({ ready: false, lastCompletedAt: null });
    expect((await db.query("select last_completed_at,last_failed_at from notification_recovery_health")).rows[0])
      .toMatchObject({ last_completed_at: null });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("also retains failure status when notification dispatch fails after mentions succeeded", async () => {
    await recordRecoveryCompletion(settings, new Date(Date.now() - 1000));
    mocks.dispatch.mockRejectedValueOnce(new Error("synthetic notification storage unavailable"));
    expect((await call()).status).toBe(503);
    expect(await loadRecoveryStatus(settings)).toMatchObject({ ready: false, reason: "failed" });
  });
});
