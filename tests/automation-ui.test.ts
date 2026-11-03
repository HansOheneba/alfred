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
  it("requires separate outgoing consent and validates its independent cutoff", () => {
    const existing = payload(); existing.preferences.paymentMentions = true;
    existing.preferences.paymentMentionsSince = "2026-11-03T10:00:00Z";
    expect(parseNotificationSettings(existing, owner).preferences).toMatchObject({ paymentMentions: true, outgoingMentions: false, outgoingMentionsSince: null });
    expect(() => parseNotificationSettings({ ...existing, preferences: { ...existing.preferences, outgoingMentions: "yes" } }, owner)).toThrow();
    expect(() => parseNotificationSettings({ ...existing, preferences: { ...existing.preferences, outgoingMentionsSince: "not-a-time" } }, owner)).toThrow();
    const html = renderToStaticMarkup(createElement(NotificationsSection, { initial: parseNotificationSettings(existing, owner), ownerId: owner }));
    expect(html).toContain("Money in"); expect(html).toContain("Money out");
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
    expect(switches).toHaveLength(4);expect(switches.slice(0,2).every(button=>!/\sdisabled(?:=|\s|>)/.test(button))).toBe(true);
    expect(switches.slice(2).every(button=>/\sdisabled(?:=|\s|>)/.test(button))).toBe(true);
    const enable = html.match(/<button[^>]*>Enable notifications<\/button>/)?.[0];
    expect(enable).toBeDefined(); expect(enable).toMatch(/\sdisabled(?:=|\s|>)/);
    expect(html).toContain('aria-labelledby="bill-reminders-title"');
    expect(html).toContain('aria-labelledby="weekly-overview-title"');
    expect(html).toMatch(/<details(?![^>]*\bopen)[^>]*>[\s\S]*?<summary[^>]*>Reminders<\/summary>/);
    expect(html).not.toContain('id="payment-push-title"');
    expect(html).not.toMatch(/scheduled|recovery|VAPID|cron|schema/i);
  });
  it("shows simple device controls without exposing operator setup or promising delivery", () => {
    const input={...payload(),push:{configured:true,publicKey,deliveryEnabled:true,schedulesEnabled:true,recoveryReady:true}};
    const html=renderToStaticMarkup(createElement(NotificationsSection,{initial:parseNotificationSettings(input,owner),ownerId:owner}));
    expect(html).toContain("Device notifications");
    expect(html).toContain("Enable notifications");
    expect(html).toContain("Get a private alert for new payments");
    expect(html).not.toMatch(/scheduled|recovery|VAPID|cron|schema/i);
    expect(html).not.toMatch(/notification was shown|guaranteed delivery|notification was delivered/i);
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
    expect(html).not.toContain('id="payment-push-title"');
    const enable = html.match(/<button[^>]*>Enable notifications<\/button>/)?.[0];
    expect(enable).toBeDefined(); expect(enable).toMatch(/\sdisabled(?:=|\s|>)/);
    expect(html).not.toMatch(/scheduled|recovery|VAPID|cron|schema/i);
    expect(html).not.toContain("Send test");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("keeps lock-screen copy free of payment details", () => {
    const html = renderToStaticMarkup(createElement(DiscreetNotificationPreview));
    expect(html).toContain("There’s a private update for you");
    expect(html).not.toMatch(/GH₵|GHS|Sample Sender|250/);
  });
  it("keeps production deployments closed while permitting local and hosted fictional previews", () => {
    expect(localAutomationPreviewAllowed({ NODE_ENV: "production", ALFRED_LOCAL_PREVIEW: "1" })).toBe(false);
    expect(localAutomationPreviewAllowed({ NODE_ENV: "production", VERCEL_ENV: "production", ALFRED_LOCAL_PREVIEW: "1" })).toBe(false);
    expect(localAutomationPreviewAllowed({ NODE_ENV: "production", VERCEL_ENV: "preview" })).toBe(true);
    expect(localAutomationPreviewAllowed({ NODE_ENV: "development" })).toBe(false);
    expect(localAutomationPreviewAllowed({ NODE_ENV: "development", ALFRED_LOCAL_PREVIEW: "1" })).toBe(true);
  });
  it("clearly distinguishes fictional incoming alerts from live confirmed funds", () => {
    const html = renderToStaticMarkup(createElement(SmsAutomationPreview, paymentMentionPreviewCopies()));
    expect(html).toContain("Demo preview · no live delivery");
    expect(html).toContain("Fictional example");
    expect(html).toContain("Known purpose");
    expect(html).toContain("Unknown purpose");
    expect(html).toContain("Uncertain alert");
    expect(html).toContain("Not enabled on this device");
    expect(html).toContain("Demo · sample choices only. Nothing will be sent.");
    expect(html).toContain("not a bank confirmation");
    expect(html).not.toContain("payment has cleared");
    expect(html).toContain("Managed on your Mac");
    expect(html).toContain("Manage sync");
  });
  it("uses the real message builder to distinguish known purpose, missing purpose and uncertainty", () => {
    const copies = paymentMentionPreviewCopies();
    expect(copies.knownCopy.toLowerCase()).toContain("freelance work");
    expect(copies.knownCopy).toContain("Business");
    expect(copies.unknownCopy).toContain("What was this for?");
    expect(copies.unknownCopy).toContain("unlabelled");
    expect(copies.uncertainCopy).toContain("possible incoming alert");
    expect(copies.uncertainCopy.toLowerCase()).not.toMatch(/freelance|cleared|settled|filed under/);
    expect(copies.outgoingKnownCopy).toContain("Sample Shop");
    expect(copies.outgoingKnownCopy).toContain("Food");
    expect(copies.outgoingUnknownCopy).toContain("What was this for?");
    expect(copies.outgoingUncertainCopy).toMatch(/possible.*money-out alert/);
    expect(copies.outgoingUncertainCopy.toLowerCase()).not.toMatch(/cleared|settled|filed under/);
  });
  it("does not present a forwarding key or browser choice as Mac installation or delivery", () => {
    const html = renderToStaticMarkup(createElement(MacAutomationCard));
    expect(html).toContain("cannot verify that it is installed, running or delivering");
    expect(html).toContain("GCB, generic MTN/Telecel and Achieve are not included");
    expect(html).toContain("Messages from before your first Start stay out");
    expect(html).toContain("catches up on eligible alerts received while paused");
    expect(html).toContain("without a new chat announcement");
    expect(html).toContain("Forwarded alerts are stored in Alfred");
    expect(html).toContain("Unfamiliar alerts may be processed by its AI provider");
  });
});

describe("fictional purpose reply demonstration", () => {
  it("labels only a clear saved outgoing sample and never treats an incoming gift as its expense purpose", () => {
    expect(sampleReplyReducer(EMPTY_SAMPLE_REPLY, { type: "reply", text: "It was for lunch", direction: "out" })).toMatchObject({ category: "Food", description: "lunch" });
    expect(sampleReplyReducer(EMPTY_SAMPLE_REPLY, { type: "reply", text: "Birthday money from grandma", direction: "out" })).toMatchObject({ category: null, description: null });
  });
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
