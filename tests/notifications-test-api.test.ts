import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ owner: vi.fn(), query: vi.fn(), configuration: vi.fn(), send: vi.fn() }));
vi.mock("@/lib/web/api", () => ({ requireOwner: mocks.owner }));
vi.mock("@/lib/supabase/connection", () => ({ query: mocks.query }));
vi.mock("@/lib/notifications/push", async (original) => ({
  ...await original<typeof import("@/lib/notifications/push")>(),
  pushConfiguration: mocks.configuration,
  sendWebPush: mocks.send,
}));

import { POST } from "@/app/api/notifications/test/route";
import { PushFailure } from "@/lib/notifications/push";

const origin = "https://alfred.example";
const ownerId = "00000000-0000-4000-8000-000000000001";
const otherOwnerId = "00000000-0000-4000-8000-000000000002";
const deviceId = "aabbccdd-eeff-4aab-8ccd-aabbccddeeff";
const otherDeviceId = "00000000-0000-4000-8000-000000000011";
const expiredDeviceId = "00000000-0000-4000-8000-000000000012";
const secondDeviceId = "00000000-0000-4000-8000-000000000013";
const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/synthetic-only",
  keys: { p256dh: "synthetic-public-point", auth: "synthetic-auth-secret" } };
const configuration = { publicKey: "synthetic-public", privateKey: "synthetic-private", subject: "mailto:fixture@example.invalid" };
const settings = { fixture: true };
let db: PGlite;

function request(value: unknown = { deviceId }, source: string | null = origin, owner = ownerId): Request {
  return new Request(`${origin}/api/notifications/test`, {
    method: "POST", headers: { ...(source ? { origin: source } : {}), "content-type": "application/json", "x-alfred-owner": owner },
    body: JSON.stringify(value),
  });
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;
    create table public.profiles(id uuid primary key);
    insert into public.profiles values('${ownerId}'),('${otherOwnerId}');`);
  await db.exec(await readFile(new URL("../supabase/migrations/20261103110000_notifications.sql", import.meta.url), "utf8"));
  const migration = await readFile(new URL("../supabase/migrations/20261011170000_accounts.sql", import.meta.url), "utf8");
  const table = migration.match(/create table if not exists public\.api_rate_limits \([\s\S]+?\n\);/i)?.[0];
  if (!table) throw Error("Shipped operational rate-limit table is missing.");
  await db.exec(table);
});

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv("ALFRED_PUSH_DELIVERY_ENABLED", "true");
  mocks.owner.mockResolvedValue({ profile: { profileId: ownerId }, settings: { supabase: settings } });
  mocks.configuration.mockReturnValue({ ready: true, config: configuration });
  mocks.send.mockResolvedValue(new Response(null, { status: 201 }));
  mocks.query.mockImplementation(async (_settings: unknown, sql: string, values: unknown[] = []) => (await db.query(sql, values)).rows);
  await db.exec("truncate public.notification_deliveries,public.push_subscriptions,public.notification_preferences,public.api_rate_limits cascade");
  await db.query(`insert into public.push_subscriptions(id,owner_id,endpoint_hash,subscription,expires_at) values
    ($1,$2,repeat('a',64),$3::jsonb,null),($4,$5,repeat('b',64),$3::jsonb,null),
    ($6,$2,repeat('c',64),$3::jsonb,now()-interval '1 minute'),($7,$2,repeat('d',64),$3::jsonb,null)`,
  [deviceId, ownerId, JSON.stringify(subscription), otherDeviceId, otherOwnerId, expiredDeviceId, secondDeviceId]);
  await db.query("insert into public.notification_preferences(owner_id) values($1)", [ownerId]);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => { await db.close(); });

describe("explicit owner-bound browser notification test", () => {
  it("rejects missing and foreign origins before authentication or database access", async () => {
    for (const source of [null, "https://other.example"]) expect((await POST(request({ deviceId }, source))).status).toBe(403);
    expect(mocks.owner).not.toHaveBeenCalled(); expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
  });

  it("requires a signed-in owner and keeps authentication failures private", async () => {
    mocks.owner.mockResolvedValue(Response.json({ ok: false, text: "Sign in first." }, { status: 401 }));
    const response = await POST(request());
    expect(response.status).toBe(401); expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
  });

  it("rejects consent from a stale displayed account", async () => {
    expect((await POST(request({ deviceId }, origin, otherOwnerId))).status).toBe(409);
    expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
  });

  it("accepts only one device UUID, never caller ownership, payload, or destinations", async () => {
    for (const value of [{}, { deviceId: "invalid" }, { deviceId, ownerId }, { deviceId, kind: "payment" },
      { deviceId, body: "Private financial text" }, { deviceId, endpoint: subscription.endpoint }, { deviceIds: [deviceId] }]) {
      expect((await POST(request(value))).status).toBe(400);
    }
    expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
  });

  it("bounds the JSON body and rejects non-JSON before looking up devices", async () => {
    const wrongType = request(); wrongType.headers.set("content-type", "text/plain");
    expect((await POST(wrongType)).status).toBe(400);
    expect((await POST(request({ deviceId, padding: "x".repeat(4096) }))).status).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
  });

  it("requires configured delivery and its server gate", async () => {
    mocks.configuration.mockReturnValueOnce({ ready: false, config: null });
    expect((await POST(request())).status).toBe(503);
    vi.stubEnv("ALFRED_PUSH_DELIVERY_ENABLED", "false");
    expect((await POST(request())).status).toBe(503);
    expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
  });

  it("does not reveal whether a device is foreign, expired, or unknown", async () => {
    const bodies: unknown[] = [];
    for (const id of [otherDeviceId, expiredDeviceId, "00000000-0000-4000-8000-000000000099"]) {
      const response = await POST(request({ deviceId: id }));
      expect(response.status).toBe(404); bodies.push(await response.json());
    }
    expect(bodies[0]).toEqual(bodies[1]); expect(bodies[1]).toEqual(bodies[2]);
    expect((await db.query("select * from public.api_rate_limits")).rows).toEqual([]);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("sends one fixed test to the selected owned device with all preferences off and recovery unconfigured", async () => {
    const before = (await db.query("select * from public.notification_preferences")).rows;
    const response = await POST(request()), text = await response.text();
    expect(response.status).toBe(200); expect(JSON.parse(text)).toMatchObject({ ok: true, status: "accepted" });
    expect(text).toContain("does not confirm");
    expect(text).not.toMatch(/synthetic-|fcm\.googleapis|endpoint|p256dh/);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith(subscription, configuration, "test");
    expect(mocks.query.mock.calls[0][2]).toEqual([ownerId, deviceId]);
    expect((await db.query("select * from public.notification_preferences")).rows).toEqual(before);
    expect((await db.query("select * from public.notification_deliveries")).rows).toEqual([]);
    expect(mocks.query.mock.calls.every(([, sql]) => /push_subscriptions|api_rate_limits/.test(sql))).toBe(true);
  });

  it("uses the durable limiter to allow only one concurrent request per owner and device", async () => {
    const responses = await Promise.all([POST(request()), POST(request()), POST(request())]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 429, 429]);
    expect(mocks.send).toHaveBeenCalledOnce();
    for (const response of responses.filter(item => item.status === 429)) {
      expect(response.headers.get("retry-after")).toBe("30");
      expect(await response.json()).toMatchObject({ status: "throttled", retryAfterSeconds: 30 });
    }
    expect((await db.query("select hits from public.api_rate_limits")).rows).toEqual([{ hits: 3 }]);
  });

  it("keeps the cooldown across fresh handler calls and permits a different owned device", async () => {
    const now = Date.now(), clock = vi.spyOn(Date, "now").mockReturnValue(now);
    expect((await POST(request())).status).toBe(200);
    expect((await POST(request())).status).toBe(429);
    expect((await POST(request({ deviceId: secondDeviceId }))).status).toBe(200);
    clock.mockReturnValue(now + 30_000);
    expect((await POST(request())).status).toBe(429);
    clock.mockReturnValue(now + 30_001);
    expect((await POST(request())).status).toBe(200);
  });

  it("shares one durable cooldown for alternating-case UUIDs, including concurrent clicks", async () => {
    const now = Date.now(), clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const ids = [deviceId, deviceId.toUpperCase(), deviceId.replace("aabbccdd", "AaBbCcDd")];
    const responses = await Promise.all(ids.map(id => POST(request({ deviceId: id }))));
    expect(responses.map(response => response.status).sort()).toEqual([200, 429, 429]);
    expect(mocks.send).toHaveBeenCalledOnce();
    expect((await db.query("select bucket,hits from public.api_rate_limits")).rows)
      .toEqual([{ bucket: `notification-test:${ownerId}:${deviceId}`, hits: 3 }]);
    clock.mockReturnValue(now + 30_000);
    expect((await POST(request({ deviceId: deviceId.toUpperCase() }))).status).toBe(429);
    clock.mockReturnValue(now + 30_001);
    expect((await POST(request({ deviceId: deviceId.toUpperCase() }))).status).toBe(200);
    expect((await POST(request())).status).toBe(429);
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });

  it("does not send when durable rate-limit storage fails", async () => {
    mocks.query.mockImplementationOnce(async (_settings: unknown, sql: string, values: unknown[]) => (await db.query(sql, values)).rows)
      .mockRejectedValueOnce(new Error("private-database-details"));
    const response = await POST(request());
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("private-database-details");
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it.each([new PushFailure("connection"), new Error("private-provider-endpoint-and-key")])("reports uncertainty without automatic retry", async error => {
    mocks.send.mockRejectedValue(error);
    const response = await POST(request()), text = await response.text();
    expect(response.status).toBe(202); expect(JSON.parse(text)).toMatchObject({ ok: true, status: "unconfirmed" });
    expect(text).not.toContain("private-provider"); expect(text).toContain("not be automatically retried");
    expect((await POST(request())).status).toBe(429); expect(mocks.send).toHaveBeenCalledOnce();
  });

  it.each(["authorization", "encryption"] as const)("distinguishes a preparation failure before sending: %s", async stage => {
    mocks.send.mockRejectedValue(new PushFailure(stage));
    const response = await POST(request());
    expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ ok: false, status: "unavailable" });
    expect((await POST(request())).status).toBe(429); expect(mocks.send).toHaveBeenCalledOnce();
  });

  it.each([401, 410, 429, 503])("reports provider rejection without automatic retry: %i", async status => {
    mocks.send.mockResolvedValue(new Response("private-provider-body", { status }));
    const response = await POST(request()), text = await response.text();
    expect(response.status).toBe(502); expect(JSON.parse(text)).toMatchObject({ ok: false, status: "rejected" });
    expect(text).not.toContain("private-provider-body");
    expect((await POST(request())).status).toBe(429); expect(mocks.send).toHaveBeenCalledOnce();
    expect((await db.query("select id from public.push_subscriptions where id=$1", [deviceId])).rows).toHaveLength(1);
  });
});
