import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseSettings } from "@/lib/config";
import type { NotificationPreferences } from "@/lib/notifications/store";

const mocks = vi.hoisted(() => ({ preferences: vi.fn(), query: vi.fn() }));
vi.mock("@/lib/notifications/store", () => ({ loadNotificationPreferences: mocks.preferences }));
vi.mock("@/lib/supabase/connection", () => ({ query: mocks.query }));
import { recoverIncomingPaymentMentions } from "@/lib/bank/notices";

const settings = {} as SupabaseSettings, ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", now = new Date("2026-11-03T12:00:00Z");
const prefs: NotificationPreferences = { paymentMentions: true, paymentPush: false, paymentPreview: false, billReminders: false, weeklyOverview: false, outgoingMentions: false, outgoingMentionsSince: null,
  paymentMentionsSince: "2026-11-03T11:00:00Z", paymentPushSince: null, billRemindersSince: null, weeklyOverviewSince: null };
beforeEach(() => { mocks.query.mockResolvedValue([]); mocks.preferences.mockResolvedValue({ ...prefs, paymentMentions: false }); });
afterEach(() => vi.resetAllMocks());

describe("shared owner-bound notice preferences", () => {
  it("avoids a second preference read only for the same owner", async () => {
    expect(await recoverIncomingPaymentMentions(settings, ownerId, now, Infinity, { ownerId, preferences: prefs })).toBe(0);
    expect(mocks.preferences).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledExactlyOnceWith(settings, expect.stringContaining("where b.owner_id=$1::uuid"), [ownerId, "2026-11-03T11:00:00.000Z", "2026-11-03T12:05:00.000Z", "2026-11-03T11:00:00.000Z", null]);
  });
  it("does not borrow another account's enabled snapshot", async () => {
    expect(await recoverIncomingPaymentMentions(settings, ownerId, now, Infinity, { ownerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", preferences: prefs })).toBe(0);
    expect(mocks.preferences).toHaveBeenCalledExactlyOnceWith(settings, ownerId); expect(mocks.query).not.toHaveBeenCalled();
  });
  it("still requires the atomic database receipt boundary to accept a mention after a shared read", async () => {
    mocks.query.mockResolvedValueOnce([{ id: "11111111-1111-4111-8111-111111111111", owner_id: ownerId, channel: "mac", direction: "in", kind: "payment", amount: "25.00", currency: "GHS", counterparty: "Fictional sender", occurred_at: new Date("2026-11-03T11:55:00Z"), created_at: new Date("2026-11-03T11:56:00Z"), status: "needs_label", transaction_id: null, fee_transaction_id: null, read_by: "rules", purpose_owner_id: null, purpose_transaction_id: null, purpose_category: null, purpose_description: null, purpose_record_status: null }])
      .mockResolvedValueOnce([{ written: false }]);
    expect(await recoverIncomingPaymentMentions(settings, ownerId, now, Infinity, { ownerId, preferences: prefs })).toBe(0);
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.query.mock.calls[1][1]).toContain("public.alfred_record_bank_activity_notice(");
    expect(mocks.query.mock.calls[1][2]).toEqual([ownerId, "11111111-1111-4111-8111-111111111111", expect.stringMatching(/^bank_notice_/), expect.any(String), false, "needs_label", null, true, null, expect.any(String)]);
    expect(mocks.preferences).not.toHaveBeenCalled();
  });
});
