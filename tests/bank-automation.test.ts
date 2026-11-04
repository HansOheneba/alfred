import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseSettings } from "@/lib/config";
import type { NotificationPreferences } from "@/lib/notifications/store";
import { profile } from "./helpers";

const mocks = vi.hoisted(() => ({ preferences: vi.fn(), mentions: vi.fn(), enqueue: vi.fn(), drain: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/notifications/store", () => ({ loadNotificationPreferences: mocks.preferences }));
vi.mock("@/lib/bank/notices", () => ({ recoverIncomingPaymentMentions: mocks.mentions }));
vi.mock("@/lib/notifications/service", () => ({ recoverPaymentNotifications: mocks.enqueue, drainOwnerNotifications: mocks.drain }));
vi.mock("@/lib/log", () => ({ logError: mocks.error }));
import { deliverBankAutomation } from "@/lib/bank/automation";

const settings = {} as SupabaseSettings, owner = profile(42), now = new Date("2026-11-03T12:00:00Z");
function preferences(patch: Partial<NotificationPreferences> = {}): NotificationPreferences {
  return { paymentMentions: false, outgoingMentions: false, outgoingMentionsSince: null, paymentPush: false, paymentPreview: false, billReminders: true, weeklyOverview: true,
    paymentMentionsSince: null, paymentPushSince: null, billRemindersSince: now.toISOString(), weeklyOverviewSince: now.toISOString(), ...patch };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  mocks.preferences.mockResolvedValue(preferences()); mocks.mentions.mockResolvedValue(0); mocks.enqueue.mockResolvedValue(0); mocks.drain.mockResolvedValue({});
});
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

describe("bank automation avoids unrelated work", () => {
  it("reads preferences once and exits when both payment choices are off, without dispatching bill/weekly work", async () => {
    await deliverBankAutomation(settings, owner);
    expect(mocks.preferences).toHaveBeenCalledExactlyOnceWith(settings, owner.profileId);
    expect(mocks.mentions).not.toHaveBeenCalled(); expect(mocks.enqueue).not.toHaveBeenCalled(); expect(mocks.drain).not.toHaveBeenCalled();
  });
  it("shares an owner-bound preference read for private mentions without touching device delivery", async () => {
    const prefs = preferences({ paymentMentions: true, paymentMentionsSince: now.toISOString() }); mocks.preferences.mockResolvedValue(prefs);
    await deliverBankAutomation(settings, owner);
    expect(mocks.preferences).toHaveBeenCalledOnce();
    expect(mocks.mentions).toHaveBeenCalledExactlyOnceWith(settings, owner.profileId, now, now.getTime() + 10_000, { ownerId: owner.profileId, preferences: prefs });
    expect(mocks.enqueue).not.toHaveBeenCalled(); expect(mocks.drain).not.toHaveBeenCalled();
  });
  it("recovers private outgoing activity when incoming mentions and device nudges are off", async () => {
    const prefs = preferences({ outgoingMentions: true, outgoingMentionsSince: now.toISOString() }); mocks.preferences.mockResolvedValue(prefs);
    await deliverBankAutomation(settings, owner);
    expect(mocks.mentions).toHaveBeenCalledExactlyOnceWith(settings, owner.profileId, now, now.getTime() + 10_000, { ownerId: owner.profileId, preferences: prefs });
    expect(mocks.enqueue).not.toHaveBeenCalled(); expect(mocks.drain).not.toHaveBeenCalled();
  });
  it("recovers and drains payment nudges independently when only push is enabled", async () => {
    mocks.preferences.mockResolvedValue(preferences({ paymentPush: true, paymentPushSince: now.toISOString() }));
    await deliverBankAutomation(settings, owner);
    expect(mocks.mentions).not.toHaveBeenCalled(); expect(mocks.enqueue).toHaveBeenCalledBefore(mocks.drain);
    expect(mocks.drain).toHaveBeenCalledExactlyOnceWith(settings, owner.profileId, { timeBudgetMs: 25_000 });
  });
  it("keeps private notice failures independent of device recovery and excludes private exception contents from logs", async () => {
    mocks.preferences.mockResolvedValue(preferences({ paymentMentions: true, paymentPush: true }));
    mocks.mentions.mockRejectedValue(new Error("FICTIONAL_PRIVATE_SMS_OR_CREDENTIAL"));
    await deliverBankAutomation(settings, owner);
    expect(mocks.enqueue).toHaveBeenCalledOnce(); expect(mocks.drain).toHaveBeenCalledOnce();
    expect(mocks.error).toHaveBeenCalledWith("bank_private_notice", expect.any(Error));
    expect(mocks.error.mock.calls[0][1].message).not.toContain("FICTIONAL_PRIVATE");
  });
  it("starts push recovery before a slow chat query completes", async () => {
    mocks.preferences.mockResolvedValue(preferences({ paymentMentions: true, paymentPush: true }));
    let finishChat!: () => void;
    mocks.mentions.mockImplementation(() => new Promise<void>((resolve) => { finishChat = resolve; }));
    const running = deliverBankAutomation(settings, owner);
    await vi.waitFor(() => expect(mocks.drain).toHaveBeenCalledOnce());
    expect(mocks.mentions).toHaveBeenCalledOnce();
    expect(mocks.enqueue).toHaveBeenCalledBefore(mocks.drain);
    finishChat();
    await running;
  });
  it("does not attempt recovery when the account preference read fails", async () => {
    mocks.preferences.mockRejectedValue(new Error("FICTIONAL_PRIVATE_DATABASE_DETAIL"));
    await expect(deliverBankAutomation(settings, owner)).resolves.toBeUndefined();
    expect(mocks.mentions).not.toHaveBeenCalled(); expect(mocks.enqueue).not.toHaveBeenCalled(); expect(mocks.drain).not.toHaveBeenCalled();
    expect(mocks.error.mock.calls[0][1].message).not.toContain("FICTIONAL_PRIVATE");
  });
  it("respects the deadline before and after reading preferences", async () => {
    await deliverBankAutomation(settings, owner, now.getTime()); expect(mocks.preferences).not.toHaveBeenCalled();
    mocks.preferences.mockImplementation(async () => { vi.setSystemTime(new Date(now.getTime() + 30_000)); return preferences({ paymentMentions: true, paymentPush: true }); });
    await deliverBankAutomation(settings, owner, now.getTime() + 25_000);
    expect(mocks.mentions).not.toHaveBeenCalled(); expect(mocks.enqueue).not.toHaveBeenCalled(); expect(mocks.drain).not.toHaveBeenCalled();
  });
});
