import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MacAutomationCard } from "@/app/settings/bank-section";
import { connectNotificationDevice, DiscreetNotificationPreview, EMPTY_NOTIFICATION_PREFERENCES, NotificationsSection, parseNotificationSettings, readNotificationSettings, type NotificationConnectionActions } from "@/app/settings/notifications-section";
import { localAutomationPreviewAllowed, paymentMentionPreviewCopies } from "@/app/preview/sms-automation/fixtures";
import { EMPTY_SAMPLE_REPLY, sampleReplyReducer, SmsAutomationPreview } from "@/app/preview/sms-automation/preview";

const owner = "00000000-0000-4000-8000-000000000001";
const device = "00000000-0000-4000-8000-000000000002";
const publicKey = "A".repeat(87); // Invalid fixture bytes, never used by a real push provider.
function payload() {
  return { ok: true, ownerId: owner, preferences: { ...EMPTY_NOTIFICATION_PREFERENCES }, push: { configured: false, publicKey: null, deliveryEnabled: false, schedulesEnabled: false }, devices: [] as { id: string; createdAt: string; endpoint?: string }[] };
}
function connection(options: { permission?: NotificationPermission; existing?: boolean; failSave?: boolean } = {}) {
  const calls: string[] = [];
  const unsubscribe = vi.fn(async () => { calls.push("unsubscribe"); return true; });
  const subscription = { toJSON: () => ({ endpoint: "https://example.invalid/fixture-only", keys: { p256dh: "fixture", auth: "fixture" } }), unsubscribe, options: { applicationServerKey: new Uint8Array(65).buffer } };
  const subscribe = vi.fn(async () => { calls.push("subscribe"); return subscription; });
  const actions: NotificationConnectionActions = {
    requestPermission: async () => { calls.push("permission"); return options.permission ?? "granted"; },
    register: async () => { calls.push("register"); return { pushManager: { getSubscription: async () => { calls.push("inspect"); return options.existing ? subscription : null; }, subscribe } }; },
    save: async () => { calls.push("save"); if (options.failSave) throw new Error("fixture server failure"); return { deviceId: device }; },
  };
  return { actions, calls, unsubscribe, subscribe };
}
afterEach(() => { vi.unstubAllGlobals(); });

describe("explicit browser notification setup", () => {
  it("requests permission before any awaited registration or server operation", async () => {
    const test = connection();
    const pending = connectNotificationDevice(publicKey, test.actions);
    expect(test.calls).toEqual(["permission"]);
    expect(await pending).toBe(device);
    expect(test.calls).toEqual(["permission", "register", "inspect", "subscribe", "save"]);
    expect(test.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
  });
  it.each(["denied", "default"] as const)("leaves everything else untouched when permission is %s", async (permission) => {
    const test = connection({ permission });
    await expect(connectNotificationDevice(publicKey, test.actions)).rejects.toThrow();
    expect(test.calls).toEqual(["permission"]);
  });
  it("does not request permission when server public-key setup is missing", async () => {
    const test = connection();
    await expect(connectNotificationDevice("", test.actions)).rejects.toThrow("not ready");
    expect(test.calls).toEqual([]);
  });
  it("removes a new browser subscription if saving it fails", async () => {
    const test = connection({ failSave: true });
    await expect(connectNotificationDevice(publicKey, test.actions)).rejects.toThrow("could not be confirmed");
    expect(test.unsubscribe).toHaveBeenCalledTimes(1);
  });
  it("preserves an existing subscription if account linking fails", async () => {
    const test = connection({ existing: true, failSave: true });
    await expect(connectNotificationDevice(publicKey, test.actions)).rejects.toThrow();
    expect(test.subscribe).not.toHaveBeenCalled();
    expect(test.unsubscribe).not.toHaveBeenCalled();
  });
  it("does not reflect private browser setup failure details", async () => {
    const test = connection();
    test.actions.register = async () => { throw new Error("private-endpoint-fixture"); };
    await expect(connectNotificationDevice(publicKey, test.actions)).rejects.toThrow("could not finish");
  });
});

describe("private owner-scoped notification settings", () => {
  it("rejects a late response belonging to another account", () => {
    expect(() => parseNotificationSettings(payload(), "00000000-0000-4000-8000-000000000999")).toThrow("session changed");
  });
  it("drops private transport fields before rendering device controls", () => {
    const input = { ...payload(), privateKey: "do-not-render-fixture", devices: [{ id: device, createdAt: "2026-11-03T10:00:00Z", endpoint: "do-not-render-fixture" }] };
    const safe = parseNotificationSettings(input, owner);
    expect(JSON.stringify(safe)).not.toContain("do-not-render-fixture");
    const html = renderToStaticMarkup(createElement(NotificationsSection, { preview: true, initial: safe }));
    expect(html).toContain("Device 1");
    expect(html).not.toContain(device);
    expect(html).not.toContain("do-not-render-fixture");
  });
  it.each([null, {}, { ...payload(), preferences: { paymentMentions: true } }, { ...payload(), push: { configured: true, publicKey: "invalid" } }])("fails closed for an incomplete settings response", (input) => {
    expect(() => parseNotificationSettings(input, owner)).toThrow();
  });
  it("loads account settings without caching or using a different origin", async () => {
    const fetcher = vi.fn(async () => Response.json(payload())); vi.stubGlobal("fetch", fetcher);
    expect((await readNotificationSettings(owner)).ownerId).toBe(owner);
    expect(fetcher).toHaveBeenCalledWith("/api/notifications", expect.objectContaining({ credentials: "same-origin", cache: "no-store" }));
  });
  it("does not infer recovery readiness from delivery or schedule flags", () => {
    const input = payload();input.push.configured=true;input.push.deliveryEnabled=true;input.push.schedulesEnabled=true;
    expect(parseNotificationSettings(input,owner).push.recoveryReady).toBe(false);
    expect(()=>parseNotificationSettings({...input,push:{...input.push,recoveryReady:"yes"}},owner)).toThrow();
  });
  it("keeps private mentions available while new push choices fail closed without recovery", () => {
    const input={...payload(),push:{configured:true,publicKey,deliveryEnabled:true,schedulesEnabled:true,recoveryReady:false}};
    const html=renderToStaticMarkup(createElement(NotificationsSection,{initial:parseNotificationSettings(input,owner),ownerId:owner}));
    const switches=html.match(/<button[^>]*role="switch"[^>]*>/g)??[];
    expect(switches).toHaveLength(4);expect(switches[0]).not.toMatch(/\sdisabled(?:=|\s|>)/);
    expect(switches.slice(1).every(button=>/\sdisabled(?:=|\s|>)/.test(button))).toBe(true);
    expect(html).toContain("Scheduled push recovery is not ready");
  });
  it("shows recent check-in wording without promising actual push delivery", () => {
    const input={...payload(),push:{configured:true,publicKey,deliveryEnabled:true,schedulesEnabled:true,recoveryReady:true}};
    const html=renderToStaticMarkup(createElement(NotificationsSection,{initial:parseNotificationSettings(input,owner),ownerId:owner}));
    expect(html).toContain("Scheduled recovery has recently checked in");
    expect(html).toContain("without waiting for another SMS");
    expect(html).toContain("including overnight");
    expect(html).not.toMatch(/wait until 7am|after 7am|quiet-hour payment/i);
  });
  it("does not reflect server failure details", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: false, text: "private-error-fixture" }, { status: 500 })));
    await expect(readNotificationSettings(owner)).rejects.toThrow("could not be loaded");
  });
});

describe("clear inactive defaults and local preview", () => {
  it("renders all choices off and performs no permission, registration or network action during SSR", () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const html = renderToStaticMarkup(createElement(NotificationsSection, { initial: parseNotificationSettings(payload(), owner), ownerId: owner }));
    expect(html.match(/aria-checked="false"/g)).toHaveLength(4);
    expect(html).toContain("Push delivery is currently off");
    expect(html).not.toContain("Send test");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("keeps lock-screen copy free of payment details", () => {
    const html = renderToStaticMarkup(createElement(DiscreetNotificationPreview));
    expect(html).toContain("There’s a private update for you");
    expect(html).not.toMatch(/GH₵|GHS|Sample Sender|250/);
  });
  it("never permits the fixture page in production, even with its local flag", () => {
    expect(localAutomationPreviewAllowed({ NODE_ENV: "production", ALFRED_LOCAL_PREVIEW: "1" })).toBe(false);
    expect(localAutomationPreviewAllowed({ NODE_ENV: "development" })).toBe(false);
    expect(localAutomationPreviewAllowed({ NODE_ENV: "development", ALFRED_LOCAL_PREVIEW: "1" })).toBe(true);
  });
  it("clearly distinguishes fictional incoming alerts from live confirmed funds", () => {
    const html = renderToStaticMarkup(createElement(SmsAutomationPreview, paymentMentionPreviewCopies()));
    expect(html).toContain("Local preview · no live delivery");
    expect(html).toContain("Fictional example");
    expect(html).toContain("Known purpose");
    expect(html).toContain("Unknown purpose");
    expect(html).toContain("Uncertain alert");
    expect(html).toContain("Sample browser not linked");
    expect(html).toContain("not a bank confirmation");
    expect(html).not.toContain("payment has cleared");
    expect(html).toContain("Prototype · not available");
  });
  it("uses the real message builder to distinguish known purpose, missing purpose and uncertainty", () => {
    const copies = paymentMentionPreviewCopies();
    expect(copies.knownCopy.toLowerCase()).toContain("freelance work");
    expect(copies.knownCopy).toContain("Business");
    expect(copies.unknownCopy).toContain("What was this for?");
    expect(copies.unknownCopy).toContain("unlabelled");
    expect(copies.uncertainCopy).toContain("possible incoming alert");
    expect(copies.uncertainCopy.toLowerCase()).not.toMatch(/freelance|cleared|settled|filed under/);
  });
  it("does not present a forwarding key or browser choice as Mac installation or delivery", () => {
    const html = renderToStaticMarkup(createElement(MacAutomationCard));
    expect(html).toContain("cannot verify that it is installed, running or delivering");
    expect(html).toContain("GCB, generic MTN/Telecel and Achieve are not included");
    expect(html).toContain("No historical backfill");
    expect(html).toContain("Forwarded alerts are stored in Alfred");
    expect(html).toContain("Unfamiliar alerts may be processed by its AI provider");
  });
});

describe("fictional purpose reply demonstration", () => {
  it("understands the birthday example without permission, network or real records", () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const birthday = sampleReplyReducer(EMPTY_SAMPLE_REPLY, { type: "reply", text: "Birthday money from grandma" });
    expect(birthday).toMatchObject({ category: "Gift", description: "birthday money from grandma", deferred: false });
    const unclear = sampleReplyReducer(birthday, { type: "reply", text: "Maybe birthday money or a loan" });
    expect(unclear).toMatchObject({ category: null, description: null, deferred: false });
    expect(sampleReplyReducer(birthday, { type: "reset" })).toEqual(EMPTY_SAMPLE_REPLY);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("files the fictional sample only after an explicit clear reply", () => {
    const answered = sampleReplyReducer(EMPTY_SAMPLE_REPLY, { type: "reply", text: "It was for freelance work" });
    expect(answered).toMatchObject({ category: "Business", description: "freelance work", deferred: false });
    expect(EMPTY_SAMPLE_REPLY).toEqual({ userReply: "", category: null, description: null, deferred: false });
  });
  it.each(["It wasn't for freelance work", "Maybe a gift", "It was for rent", "not freelance", "perhaps freelance work"])("asks for clarification instead of guessing from %s", (text) => {
    expect(sampleReplyReducer(EMPTY_SAMPLE_REPLY, { type: "reply", text })).toMatchObject({ category: null, description: null, deferred: false });
  });
  it("can keep the sample in Review and reset without retaining a purpose", () => {
    const answered = sampleReplyReducer(EMPTY_SAMPLE_REPLY, { type: "reply", text: "Freelance" });
    expect(sampleReplyReducer(answered, { type: "defer" })).toMatchObject({ category: null, description: null, deferred: true });
    expect(sampleReplyReducer(answered, { type: "reset" })).toEqual(EMPTY_SAMPLE_REPLY);
  });
  it("does not make a network request for a fictional reply", () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const state = sampleReplyReducer(EMPTY_SAMPLE_REPLY, { type: "reply", text: "It was for freelance work" });
    expect(state.category).toBe("Business");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
