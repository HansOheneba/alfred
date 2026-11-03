import { webcrypto } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), configuration: vi.fn(), send: vi.fn() }));
vi.mock("@/lib/supabase/connection", () => ({ query: mocks.query }));
vi.mock("@/lib/notifications/push", async original => ({
  ...await original<typeof import("@/lib/notifications/push")>(),
  pushConfiguration: mocks.configuration,
  sendWebPush: mocks.send,
}));

import type { SupabaseSettings, UserProfile } from "@/lib/config";
import { deliverBankAutomation } from "@/lib/bank/automation";
import { ingestBankText } from "@/lib/bank/ingest";
import { createSupabaseBankStore } from "@/lib/bank/store";
import { loadAccountingState } from "@/lib/finance/accounting/persisted-store";
import { accountingReportRows } from "@/lib/finance/accounting/view";
import { notificationPayload, type PushKind } from "@/lib/notifications/push";
import { ownedPaymentMovement } from "@/lib/notifications/payment-target";
import { recordRecoveryCompletion } from "@/lib/notifications/recovery";
import { drainOwnerNotifications, recoverPaymentNotifications } from "@/lib/notifications/service";
import { createNotificationStore } from "@/lib/notifications/store";
import { createSupabaseFinanceStore } from "@/lib/supabase/finance-store";

// The database and push provider are the only substituted transports. No test
// can contact a real project or deliver a real browser notification.
const settings = { projectRef: "synthetic", host: "synthetic.invalid", user: "synthetic", database: "postgres", password: "" } as unknown as SupabaseSettings;
const ownerId = "00000000-0000-4000-8000-000000000001";
const otherOwnerId = "00000000-0000-4000-8000-000000000002";
const profile = (profileId = ownerId): UserProfile => ({ profileId, telegramUserId: null, spreadsheetId: "",
  preferredName: "Synthetic tester", currency: "GHS", timezone: "Africa/Accra", communicationPreference: "concise" });
const hubtelOut = "GHS 1.00 was withdrawn from your Hubtel wallet. Available balance: GHS 99.00. Transaction ID: 88123456.";
const hubtelIn = "GHS 1.00 was deposited into your Hubtel wallet. Available balance: GHS 100.00. Transaction ID: 88123457.";
const momoIn = "Payment received for GHS 1.00 from FICTIONAL OWNER Current Balance: GHS 100.00 . Available Balance: GHS 100.00. Reference: transfer. Transaction ID: 92300000001. TRANSACTION FEE: 0.00";
const momoOut = "Payment made for GHS 1.00 to FICTIONAL OWNER Current Balance: GHS 99.00 . Available Balance: GHS 99.00. Reference: transfer. Transaction ID: 92300000002. Fee charged: GHS0.00 Tax charged: 0.";
const pairs = [["Hubtel to Mobile Money", hubtelOut, momoIn], ["Mobile Money to Hubtel", momoOut, hubtelIn]] as const;
let db: PGlite, now: Date, deviceId: string;
let subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
let payloads: ReturnType<typeof notificationPayload>[];

beforeAll(async () => {
  db = new PGlite();
  await db.exec("create role anon;create role authenticated;create schema auth;create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}'::jsonb);");
  const directory = new URL("../supabase/migrations/", import.meta.url);
  for (const name of (await readdir(directory)).filter(name => name.endsWith(".sql")).sort()) {
    await db.exec(await readFile(new URL(name, directory), "utf8"));
  }
  const pair = await webcrypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/fictional-journey-only", keys: {
    p256dh: Buffer.from(await webcrypto.subtle.exportKey("raw", pair.publicKey)).toString("base64url"), auth: Buffer.alloc(16, 7).toString("base64url"),
  } };
}, 30_000);

beforeEach(async () => {
  vi.clearAllMocks();
  await db.exec("truncate auth.users cascade;truncate public.notification_recovery_health");
  mocks.query.mockImplementation(async (_settings: unknown, sql: string, values: unknown[] = []) => (await db.query(sql, values)).rows);
  vi.stubEnv("ALFRED_PUSH_DELIVERY_ENABLED", "true");
  vi.stubEnv("ALFRED_NOTIFICATION_SCHEDULES_ENABLED", "true");
  vi.stubEnv("ALFRED_NOTIFICATION_CRON_SECRET", "fictional-journey-secret");
  vi.stubEnv("ALFRED_NOTIFICATION_RECOVERY_SCHEDULE_ID", "synthetic/journey");
  vi.stubEnv("ALFRED_NOTIFICATION_RECOVERY_INTERVAL_SECONDS", "60");
  mocks.configuration.mockReturnValue({ ready: true, config: { publicKey: "synthetic", privateKey: "synthetic", subject: "mailto:fixture@example.invalid" } });
  payloads = [];
  mocks.send.mockImplementation(async (_subscription: unknown, _configuration: unknown, kind: PushKind, _fetcher: unknown, target: string | undefined) => {
    payloads.push(notificationPayload(kind, target));
    return new Response(null, { status: 201 });
  });
  await db.query("insert into auth.users(id) values($1),($2)", [ownerId, otherOwnerId]);
  now = (await db.query<{ at: Date }>("select now() at")).rows[0].at;
  await enableOwner(ownerId);
  await recordRecoveryCompletion(settings, now);
});
afterEach(() => { vi.unstubAllEnvs(); });
afterAll(async () => { await db.close(); });

async function enableOwner(owner: string) {
  const store = createNotificationStore(settings);
  await store.update(owner, { paymentMentions: true, outgoingMentions: true, paymentPush: true });
  const id = await store.subscribe(owner, { ...subscription, endpoint: subscription.endpoint + "/" + owner });
  // Model a connection and consent established before these fictional alerts.
  await db.query(`update notification_preferences set payment_mentions_since=$2,outgoing_mentions_since=$2,payment_push_since=$2 where owner_id=$1`,
    [owner, new Date(Date.now() - 60 * 60_000)]);
  await db.query("update push_subscriptions set created_at=$2 where id=$1", [id, new Date(Date.now() - 60 * 60_000)]);
  if (owner === ownerId) deviceId = id;
  return id;
}

async function ingest(text: string, receivedAt = now) {
  return ingestBankText({ bank: createSupabaseBankStore(settings), ledger: createSupabaseFinanceStore(settings), now,
    createId: () => webcrypto.randomUUID() }, profile(), text,
  { channel: "mac", sender: text.includes("Hubtel") ? "Hubtel" : "MobileMoney", receivedAt });
}
async function counts() {
  return (await db.query<{ notices: number; receipts: number; deliveries: number; transactions: number }>(`select
    (select count(*)::int from messages where intent like 'automation:%') notices,
    (select count(*)::int from bank_notice_receipts) receipts,
    (select count(*)::int from notification_deliveries) deliveries,
    (select count(*)::int from transactions) transactions`)).rows[0];
}

describe("small-payment announcements through the actual server stores", () => {
  it.each(pairs)("announces both GHS1 legs of %s once while leaving classification and accounts for review", async (_label, outgoing, incoming) => {
    const events: string[] = [];
    for (const text of [outgoing, incoming]) {
      const result = await ingest(text);
      expect(result).toMatchObject({ found: 1, duplicates: 0 });
      expect(result.outcomes[0].message).toMatchObject({ kind: "payment", status: "needs_label", amount: "1.00", transactionId: null });
      events.push(result.outcomes[0].message.id);
    }
    await deliverBankAutomation(settings, profile());
    const state = (await loadAccountingState(settings, ownerId)).state;
    expect(state.movements).toHaveLength(2);
    expect(state.movements.map(movement => ({ amount: movement.amountMinor, account: movement.accountId, status: movement.status, direction: movement.direction }))
      .sort((a, b) => a.direction.localeCompare(b.direction))).toEqual([
      { amount: 100, account: null, status: "review", direction: "in" }, { amount: 100, account: null, status: "review", direction: "out" },
    ]);
    expect(state.accounts).toHaveLength(0); expect(state.transfers).toHaveLength(0);
    expect(accountingReportRows(state)).toEqual([]);
    expect(await counts()).toEqual({ notices: 2, receipts: 2, deliveries: 2, transactions: 0 });
    const notices = (await db.query<{ intent: string; meta: { paymentNotice: { bankMessageId: string; requiresPurpose: boolean } } }>(
      "select intent,meta from messages where intent like 'automation:%' order by intent")).rows;
    expect(notices.map(message => message.intent)).toEqual(["automation:incoming-payment", "automation:outgoing-payment"]);
    expect(notices.every(message => message.meta.paymentNotice.requiresPurpose)).toBe(true);
    expect(payloads).toHaveLength(2);
    expect(payloads.map(payload => payload.targetId).sort()).toEqual([...events].sort());
    expect(JSON.stringify(payloads)).not.toMatch(/GHS|FICTIONAL OWNER|Hubtel|1\.00|88123456|92300000001/);
    for (const event of events) {
      expect(ownedPaymentMovement(state, ownerId, event)?.sourceId).toBe(event);
      expect(ownedPaymentMovement(state, otherOwnerId, event)).toBeNull();
    }
    expect((await db.query<{ status: string; attempts: number; subscription_id: string }>("select status,attempts,subscription_id from notification_deliveries")).rows)
      .toEqual(expect.arrayContaining([expect.objectContaining({ status: "accepted", attempts: 1, subscription_id: deviceId })]));
    for (const text of [outgoing, incoming]) expect(await ingest(text)).toMatchObject({ duplicates: 1, outcomes: [] });
    await deliverBankAutomation(settings, profile());
    expect(await counts()).toEqual({ notices: 2, receipts: 2, deliveries: 2, transactions: 0 });
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });

  it("stores alerts without announcements or sends when the owner has not opted in", async () => {
    await createNotificationStore(settings).update(ownerId, { paymentMentions: false, outgoingMentions: false, paymentPush: false });
    await ingest(hubtelOut); await ingest(momoIn);
    await deliverBankAutomation(settings, profile());
    expect(await counts()).toEqual({ notices: 0, receipts: 0, deliveries: 0, transactions: 0 });
    expect((await createSupabaseBankStore(settings).listMessages(ownerId)).map(message => message.status)).toEqual(["needs_label", "needs_label"]);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("does not replay an alert from before account consent", async () => {
    await ingest(hubtelOut, new Date(now.getTime() - 2 * 60 * 60_000));
    await deliverBankAutomation(settings, profile());
    expect(await counts()).toEqual({ notices: 0, receipts: 0, deliveries: 0, transactions: 0 });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("keeps an eligible chat notice but excludes a device connected after that alert", async () => {
    await db.query("update push_subscriptions set created_at=$2 where id=$1", [deviceId, now]);
    await ingest(momoIn, new Date(now.getTime() - 60_000));
    await deliverBankAutomation(settings, profile());
    expect(await counts()).toEqual({ notices: 1, receipts: 1, deliveries: 0, transactions: 0 });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("honors opt-out between durable enqueue and the provider claim", async () => {
    await ingest(hubtelOut); await ingest(momoIn);
    expect(await recoverPaymentNotifications(settings, ownerId)).toBe(2);
    await createNotificationStore(settings).update(ownerId, { paymentPush: false });
    expect(await drainOwnerNotifications(settings, ownerId)).toMatchObject({ attempted: 0, accepted: 0 });
    expect((await db.query<{ status: string; attempts: number }>("select status,attempts from notification_deliveries")).rows)
      .toEqual([{ status: "canceled", attempts: 0 }, { status: "canceled", attempts: 0 }]);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("cannot enqueue, claim, deliver, or resolve another owner's event", async () => {
    await enableOwner(otherOwnerId);
    const event = (await ingest(momoIn)).outcomes[0].message.id;
    const store = createNotificationStore(settings);
    expect(await store.enqueuePayment(otherOwnerId, event)).toBe(0);
    expect(await store.enqueuePayment(ownerId, event)).toBe(1);
    const [delivery] = (await db.query<{ id: string }>("select id::text from notification_deliveries")).rows;
    expect(await store.claim(otherOwnerId, delivery.id, new Date())).toBeNull();
    expect(await drainOwnerNotifications(settings, otherOwnerId)).toMatchObject({ attempted: 0 });
    const ownState = (await loadAccountingState(settings, ownerId)).state;
    const otherState = (await loadAccountingState(settings, otherOwnerId)).state;
    expect(ownedPaymentMovement(otherState, otherOwnerId, event)).toBeNull();
    expect(ownedPaymentMovement(ownState, otherOwnerId, event)).toBeNull();
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
