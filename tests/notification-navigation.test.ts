import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
// This installed Next release still exports the test helper under its former name.
import { unstable_doesMiddlewareMatch as doesProxyMatch } from "next/experimental/testing/server";
import { config } from "@/proxy";

const origin = "https://alfred.hansopoku.com";
const payment = "11111111-1111-4111-8111-111111111111";
const href = `${origin}/chat?payment=${payment}`;
type WindowClient = {
  url: string; frameType?: string; focused?: boolean; visibilityState?: string;
  focus: ReturnType<typeof vi.fn>; navigate: ReturnType<typeof vi.fn>;
};
function client(url: string, extra: Partial<WindowClient> = {}): WindowClient {
  const result = { url, focus: vi.fn(), navigate: vi.fn(), ...extra };
  result.focus.mockResolvedValue(result); result.navigate.mockResolvedValue(result);
  return result;
}
async function clickWorker(windows: WindowClient[] = []) {
  const source = await readFile(new URL("../public/alfred-push-sw.js", import.meta.url), "utf8");
  const handlers = new Map<string, (event: unknown) => void>();
  const matchAll = vi.fn(async () => windows), openWindow = vi.fn(async () => null);
  const worker = { location: { origin }, clients: { matchAll, openWindow }, addEventListener: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler) };
  vm.runInNewContext(source, { self: worker, URL, Object, setTimeout, clearTimeout });
  return { matchAll, openWindow, click(data: unknown = { kind: "payment", targetId: payment }) {
    let completed!: Promise<unknown>;
    const close = vi.fn();
    handlers.get("notificationclick")!({ notification: { data, close }, waitUntil: (promise: Promise<unknown>) => { completed = promise; } });
    return { completed, close };
  } };
}
const flush = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };
afterEach(() => vi.useRealTimers());

describe("notification taps bring a usable first-party window forward", () => {
  it("focuses before a slow navigation completes", async () => {
    const existing = client(origin + "/dashboard"), worker = await clickWorker([existing]);
    let finish!: (value: WindowClient) => void;
    existing.navigate.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const click = worker.click(); await flush();
    expect(existing.focus).toHaveBeenCalledOnce();
    expect(existing.focus).toHaveBeenCalledBefore(existing.navigate);
    expect(existing.navigate).toHaveBeenCalledWith(href); expect(worker.openWindow).not.toHaveBeenCalled();
    finish(existing); await click.completed; expect(click.close).toHaveBeenCalledOnce();
  });
  it("re-enters the exact payment URL after its temporary Chat binding may have cleared, without taking over another draft", async () => {
    const draft = client(origin + "/chat", { focused: true }), exact = client(href);
    const worker = await clickWorker([draft, exact]); await worker.click().completed;
    expect(exact.focus).toHaveBeenCalledOnce(); expect(exact.navigate).toHaveBeenCalledExactlyOnceWith(href);
    expect(exact.focus).toHaveBeenCalledBefore(exact.navigate);
    expect(draft.focus).not.toHaveBeenCalled(); expect(draft.navigate).not.toHaveBeenCalled(); expect(worker.openWindow).not.toHaveBeenCalled();
  });
  it("focuses an existing non-payment destination without an unnecessary reload", async () => {
    const settings = client(origin + "/settings"), worker = await clickWorker([settings]);
    await worker.click({ kind: "test" }).completed;
    expect(settings.focus).toHaveBeenCalledOnce(); expect(settings.navigate).not.toHaveBeenCalled();
    expect(worker.openWindow).not.toHaveBeenCalled();
  });
  it("uses controlled top-level same-origin clients and prefers the focused one", async () => {
    const wrongOrigin = client("https://evil.invalid/chat"), frame = client(origin + "/chat", { frameType: "nested" });
    const hidden = client(origin + "/dashboard"), focused = client(origin + "/settings", { focused: true });
    const worker = await clickWorker([wrongOrigin, frame, hidden, focused]); await worker.click().completed;
    expect(worker.matchAll).toHaveBeenCalledWith({ type: "window" });
    expect(focused.navigate).toHaveBeenCalledWith(href);
    for (const unused of [wrongOrigin, frame, hidden]) { expect(unused.focus).not.toHaveBeenCalled(); expect(unused.navigate).not.toHaveBeenCalled(); }
  });
  it("falls back once when client lookup fails", async () => {
    const worker = await clickWorker(); worker.matchAll.mockRejectedValue(new Error("unavailable"));
    await worker.click().completed; expect(worker.openWindow).toHaveBeenCalledExactlyOnceWith(href);
  });
  it("does not wait indefinitely for frozen clients or navigate them after the fallback opens", async () => {
    vi.useFakeTimers(); const existing = client(origin + "/dashboard"), worker = await clickWorker();
    let resolve!: (windows: WindowClient[]) => void;
    worker.matchAll.mockImplementation(() => new Promise(done => { resolve = done; }));
    const click = worker.click(); await vi.advanceTimersByTimeAsync(1000); await click.completed;
    expect(worker.openWindow).toHaveBeenCalledExactlyOnceWith(href);
    resolve([existing]); await flush(); expect(existing.focus).not.toHaveBeenCalled(); expect(existing.navigate).not.toHaveBeenCalled();
    expect(worker.openWindow).toHaveBeenCalledOnce();
  });
  it("does not open a duplicate window after successful navigation when focus fails", async () => {
    const existing = client(origin + "/dashboard"), worker = await clickWorker([existing]);
    existing.focus.mockRejectedValue(new Error("focus unavailable"));
    await worker.click().completed; expect(existing.navigate).toHaveBeenCalledWith(href); expect(worker.openWindow).not.toHaveBeenCalled();
  });
  it("does not let a stalled focus hold a successful navigation open indefinitely", async () => {
    vi.useFakeTimers(); const existing = client(origin + "/dashboard"), worker = await clickWorker([existing]);
    existing.focus.mockImplementation(() => new Promise(() => {}));
    const click = worker.click(); await vi.advanceTimersByTimeAsync(1000); await click.completed;
    expect(existing.navigate).toHaveBeenCalledWith(href); expect(worker.openWindow).not.toHaveBeenCalled();
  });
  it("opens one safe target if the existing client cannot navigate", async () => {
    const existing = client(origin + "/dashboard"), worker = await clickWorker([existing]);
    existing.navigate.mockRejectedValue(new Error("discarded client"));
    await worker.click().completed; expect(worker.openWindow).toHaveBeenCalledExactlyOnceWith(href);
  });
  it("never forwards an untrusted URL or malformed target", async () => {
    const worker = await clickWorker();
    await worker.click({ kind: "payment", targetId: payment + "&next=https://evil.invalid", url: "https://evil.invalid" }).completed;
    expect(worker.openWindow).toHaveBeenCalledExactlyOnceWith(origin + "/chat");
  });
});

async function navigationWorker() {
  const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
  const handlers = new Map<string, (event: unknown) => void>();
  const fallback = new Response("PUBLIC_RETRY_PAGE", { headers: { "content-type": "text/html" } });
  const match = vi.fn(async (): Promise<Response | undefined> => fallback);
  const fetch = vi.fn<(request: unknown, init?: RequestInit) => Promise<Response>>(async () => new Response("LIVE_PAGE"));
  const cachePut = vi.fn(), open = vi.fn(async () => ({ put: cachePut, match: vi.fn(), addAll: vi.fn() }));
  const worker = { location: { origin }, addEventListener: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler) };
  vm.runInNewContext(source, { self: worker, URL, Object, importScripts: vi.fn(), caches: { match, open }, fetch, Response, AbortController, setTimeout, clearTimeout });
  return { match, fetch, cachePut, fallback, navigate(preloadResponse: Promise<Response | undefined> = Promise.resolve(undefined), path = `/chat?payment=${payment}`, mode = "navigate") {
    let response: Promise<Response> | undefined;
    const request = { method: "GET", mode, url: origin + path };
    handlers.get("fetch")!({ request, preloadResponse, respondWith: (value: Promise<Response>) => { response = value; } });
    return response;
  } };
}

describe("installed app navigation uses a bounded private-network wait", () => {
  it("uses an available navigation preload without sending a duplicate request or caching the private page", async () => {
    vi.useFakeTimers(); const worker = await navigationWorker(), page = new Response("PRIVATE_PAGE");
    expect(await worker.navigate(Promise.resolve(page))).toBe(page);
    expect(worker.fetch).not.toHaveBeenCalled(); expect(worker.cachePut).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it("returns a public retry page after stalled preload headers without issuing a second request", async () => {
    vi.useFakeTimers(); const worker = await navigationWorker();
    let resolve!: (value: undefined) => void;
    const response = worker.navigate(new Promise(done => { resolve = done; }))!;
    await vi.advanceTimersByTimeAsync(9999); expect(worker.match).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(await response).toBe(worker.fallback);
    expect(worker.match).toHaveBeenCalledExactlyOnceWith("/offline.html"); expect(worker.fetch).not.toHaveBeenCalled(); expect(worker.cachePut).not.toHaveBeenCalled();
    resolve(undefined); await flush(); expect(worker.fetch).not.toHaveBeenCalled();
  });
  it("aborts its own stalled fetch and exposes retry without altering the notification URL", async () => {
    vi.useFakeTimers(); const worker = await navigationWorker(); let signal: AbortSignal | undefined;
    worker.fetch.mockImplementation(async (_request, init) => {
      signal = init?.signal ?? undefined;
      return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    });
    const response = worker.navigate()!; await vi.advanceTimersByTimeAsync(10_000);
    expect(await response).toBe(worker.fallback); expect(signal?.aborted).toBe(true); expect(worker.fetch).toHaveBeenCalledOnce();
    expect(worker.fetch.mock.calls[0][0]).toMatchObject({ url: href }); expect(worker.cachePut).not.toHaveBeenCalled();
  });
  it("keeps streaming HTML unbuffered once headers arrive", async () => {
    vi.useFakeTimers(); const worker = await navigationWorker();
    const page = new Response(new ReadableStream()); worker.fetch.mockResolvedValue(page);
    expect(await worker.navigate()).toBe(page); expect(page.bodyUsed).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });
  it("still has a nonfinancial retry response if public fallback storage is unavailable", async () => {
    const worker = await navigationWorker(); worker.fetch.mockRejectedValue(new Error("private network details")); worker.match.mockRejectedValue(new Error("unavailable cache"));
    const response = await worker.navigate(); expect(response?.status).toBe(503);
    const html = await response!.text(); expect(html).toContain("Try again"); expect(html).toContain("location.reload()"); expect(html).not.toMatch(/private network|payment=|11111111|PRIVATE_PAGE/);
  });
  it("does not intercept API requests or cache authenticated responses", async () => {
    const worker = await navigationWorker(); expect(worker.navigate(Promise.resolve(undefined), "/api/chat", "cors")).toBeUndefined();
    expect(worker.fetch).not.toHaveBeenCalled(); expect(worker.cachePut).not.toHaveBeenCalled(); expect(worker.match).not.toHaveBeenCalled();
  });
});

describe("the public push worker dependency skips session refresh", () => {
  it.each(["/sw.js", "/alfred-push-sw.js"])("does not invoke auth proxy for %s", url => {
    expect(doesProxyMatch({ config, nextConfig: {}, url })).toBe(false);
  });
  it.each(["/chat?payment=" + payment, "/api/chat", "/api/notifications", "/settings", "/alfred-push-sw.js/private", "/alfred-push-swXjs"])("keeps normal session handling for %s", url => {
    expect(doesProxyMatch({ config, nextConfig: {}, url })).toBe(true);
  });
});
