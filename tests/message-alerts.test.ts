import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatMessageAlert, ChatUnreadBadge, chatIsReadable, createVisibleChatGate, messageRequest, parseMessageUpdates, publishChatRead } from "@/app/chat/message-alerts";
import { createOwnedChatThreadRefresh } from "@/app/chat/chat-panel";
import { MessageNotificationSettings, parseMessagePreferences } from "@/app/settings/message-notifications";
import { messagePushDetails } from "@/lib/notifications/message-copy";
import { notificationPayload } from "@/lib/notifications/push";

const owner = "11111111-1111-4111-8111-111111111111", id = "22222222-2222-4222-8222-222222222222";
const updates = { ok: true, ownerId: owner, initialized: true, unreadCount: 2, latestMessageId: id };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("owned message alerts", () => {
  it("accepts only current-owner metadata and never exposes message bodies", () => {
    expect(parseMessageUpdates({ ...updates, body: "private sample" }, owner)).toEqual(updates);
    expect(() => parseMessageUpdates(updates, id)).toThrow();
    for (const patch of [{ unreadCount: -1 }, { unreadCount: 0.2 }, { latestMessageId: "unsafe" }, { initialized: "true" }]) expect(() => parseMessageUpdates({ ...updates, ...patch }, owner)).toThrow();
  });
  it("renders a discreet accessible unread badge and another-tab alert", () => {
    expect(renderToStaticMarkup(createElement(ChatUnreadBadge, { count: 0 }))).toBe("");
    expect(renderToStaticMarkup(createElement(ChatUnreadBadge, { count: 120 }))).toContain("99+");
    const html = renderToStaticMarkup(createElement(ChatMessageAlert, { count: 2, dismiss: () => {} }));
    expect(html).toContain("2 unread"); expect(html).toContain('href="/chat"'); expect(html).toContain('aria-live="polite"'); expect(html).not.toContain("private sample");
  });
  it("does not emit a read marker for an inactive view or invalid owner", () => {
    const dispatch = vi.fn();
    vi.stubGlobal("window", { dispatchEvent: dispatch });
    vi.stubGlobal("CustomEvent", class { constructor(readonly type: string, readonly options: { detail: unknown }) {} });
    publishChatRead({ ownerId: "invalid", messageId: id, active: true }); expect(dispatch).not.toHaveBeenCalled();
    publishChatRead({ ownerId: owner, messageId: id, active: false });
    expect(dispatch.mock.calls[0][0].options.detail).toEqual({ ownerId: owner, messageId: null, active: false });
  });
  it("bounds a stalled body and never treats another owner as the current session", async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>(async () => ({ ok: true, json: () => new Promise(() => {}) }) as Response);
    const failed = expect(messageRequest(owner, "GET", undefined, request)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(8000); await failed;
    expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await expect(messageRequest(owner, "GET", undefined, async () => Response.json({ ...updates, ownerId: id }))).rejects.toThrow();
  });
  it("sends an explicit owned read signal once without enabling delivery", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json(updates));
    await messageRequest(owner, "POST", { op: "read", messageId: id, active: true, presenceId: owner }, request);
    expect(request).toHaveBeenCalledExactlyOnceWith("/api/chat/notifications", expect.objectContaining({ method: "POST", headers: { "content-type": "application/json", "x-alfred-owner": owner } }));
  });
  it("cancels stale session work without invoking the financial save gate", async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>(() => new Promise(() => {})), lifetime = new AbortController();
    const failed = expect(messageRequest(owner, "GET", undefined, request, lifetime.signal)).rejects.toThrow("canceled");
    lifetime.abort(); await failed;
    expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it("refreshes missed realtime messages and withholds stale presence even when the thread read fails", async () => {
    const nextId = "33333333-3333-4333-8333-333333333333";
    const oldView = { ownerId: owner, messageId: id, active: true };
    let now = 0;
    const pending: Promise<void>[] = [];
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ok: false }, { status: 503 })).mockResolvedValueOnce(Response.json({ ok: true, ownerId: owner, messages: [{ id: nextId, role: "assistant", text: "A fictional new reply", channel: "web", createdAt: "2026-11-05T02:00:00Z", clientId: null }], choices: [] }));
    const shown = vi.fn();
    const thread = createOwnedChatThreadRefresh(owner, shown, request);
    const gate = createVisibleChatGate(owner, () => { pending.push(thread.refresh()); }, () => now);
    expect(gate.read(oldView, true).active).toBe(false); // Metadata hasn't loaded yet.
    gate.observe(id); expect(gate.read(oldView, true).active).toBe(true);
    gate.observe(nextId); // Polling discovered an insert that realtime missed.
    expect(gate.read(oldView, true)).toEqual({ ownerId: owner, messageId: null, active: false });
    await pending[0]; expect(shown).not.toHaveBeenCalled();
    now = 14000; expect(gate.read(oldView, true).active).toBe(false); expect(request).toHaveBeenCalledTimes(1);
    now = 15000; expect(gate.read(oldView, true).active).toBe(false); await pending[1];
    expect(request).toHaveBeenCalledTimes(2); expect(shown.mock.calls[0][0].messages[0].id).toBe(nextId);
    expect(gate.read({ ...oldView, messageId: nextId }, true).active).toBe(true);
    thread.dispose();
  });
  it("does not grant presence or refresh the wrong owner, a hidden thread, or a scrolled-away view", () => {
    const refresh = vi.fn(), gate = createVisibleChatGate(owner, refresh);
    gate.observe(id);
    expect(gate.read({ ownerId: id, messageId: id, active: true }, true).active).toBe(false);
    expect(gate.read({ ownerId: owner, messageId: null, active: true }, false).active).toBe(false);
    expect(gate.read({ ownerId: owner, messageId: null, active: false }, true).active).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });
  it("keeps a new reply unread behind an open Context drawer until the thread is visible again", () => {
    const nextId = "33333333-3333-4333-8333-333333333333";
    const modal = { open: true };
    const documentView = { visibilityState: "visible", hasFocus: () => true, querySelector: vi.fn<() => typeof modal | null>().mockReturnValue(null) };
    vi.stubGlobal("document", documentView);
    const gate = createVisibleChatGate(owner, vi.fn());
    gate.observe(id);
    expect(gate.read({ ownerId: owner, messageId: id, active: true }, chatIsReadable()).active).toBe(true);
    documentView.querySelector.mockReturnValue(modal);
    gate.observe(nextId);
    const renderedBehindDrawer = { ownerId: owner, messageId: nextId, active: true };
    expect(gate.read(renderedBehindDrawer, chatIsReadable())).toEqual({ ownerId: owner, messageId: null, active: false });
    documentView.querySelector.mockReturnValue(null);
    expect(gate.read(renderedBehindDrawer, chatIsReadable()).active).toBe(true);
  });
  it("keeps device push and message previews off in the sample settings", () => {
    const html = renderToStaticMarkup(createElement(MessageNotificationSettings, { ownerId: owner, ready: true, connected: true, preview: true }));
    expect(html.match(/aria-checked="false"/g)).toHaveLength(2); expect(html).toContain("including financial details"); expect(html).toContain("Hidden by default");
    expect(() => parseMessagePreferences({ messagePush: true, messagePreview: "yes", messagePushSince: null })).toThrow();
  });
});

describe("message push privacy and worker", () => {
  it("defaults to discreet copy and an opaque stable tag", () => {
    const data = notificationPayload("message", undefined, undefined, { id });
    expect(data.notification.body).toBe("Alfred sent you a message. Open Chat to read it."); expect(data.notification.navigate).toMatch(/\/chat$/); expect(data.notification.tag).toBe(`alfred-message-${id}`);
    expect(() => notificationPayload("message")).toThrow(); expect(() => notificationPayload("payment", undefined, undefined, { id })).toThrow();
  });
  it("limits explicitly permitted previews to bounded plain text", () => {
    const details = messagePushDetails({ id, text: "Sample\nmessage\u202e " + "x".repeat(250) })!;
    expect(details.text?.length).toBe(180); expect(details.text).not.toMatch(/[\n\u202e]/);
    expect(messagePushDetails({ id: "https://other.invalid", text: "unsafe" })).toBeNull();
  });
  it("ignores arbitrary nested notification copy and accepts only the structured message preview", async () => {
    const handlers = new Map<string, (event: { data: { json: () => unknown }; waitUntil: (promise: Promise<unknown>) => void }) => void>(), shown = vi.fn();
    vm.runInNewContext(readFileSync("public/alfred-push-sw.js", "utf8"), { self: { addEventListener: (type: string, callback: typeof handlers extends Map<string, infer H> ? H : never) => handlers.set(type, callback), registration: { showNotification: shown } }, setTimeout, clearTimeout, URL });
    const push = async (value: unknown) => { let work: Promise<unknown> | undefined; handlers.get("push")!({ data: { json: () => value }, waitUntil: promise => { work = promise; } }); await work; };
    await push({ kind: "message", message: { id }, notification: { body: "must not appear", navigate: "https://other.invalid" } });
    expect(shown.mock.calls[0][1]).toMatchObject({ body: "Alfred sent you a message. Open Chat to read it.", tag: `alfred-message-${id}` });
    await push({ kind: "message", message: { id, text: "A permitted sample preview." } }); expect(shown.mock.calls[1][1].body).toBe("A permitted sample preview.");
    await push({ kind: "message", message: { id, text: "unsafe\u202etext" } }); expect(shown.mock.calls[2][1].body).toBe("Alfred sent you a message. Open Chat to read it.");
  });
});
