import { afterEach, describe, expect, it, vi } from "vitest";

import { createChatEmptyStatusRefresh, loadOwnedChatEmptyStatus } from "@/app/chat/empty-status";
import { MemoryFinanceStore } from "@/lib/finance/memory-store";
import { expense } from "./helpers";

afterEach(() => { vi.unstubAllGlobals(); });

describe("Chat Get Started after financial changes", () => {
  it("steps aside after adding the first record and returns after deleting that last record", async () => {
    const store = new MemoryFinanceStore();
    let knownEmpty: boolean | null = true;
    const network = vi.fn(async () => Response.json({ ok: true, ownerId: "42", financialsEmpty: !(await store.listTransactions("42")).some(row => row.status === "active") }));
    vi.stubGlobal("fetch", network);
    const status = createChatEmptyStatusRefresh("42", next => { knownEmpty = next; });
    await store.appendTransaction(expense());
    await status.refresh(true);
    expect(knownEmpty).toBe(false);
    await store.updateTransaction("42", expense().transactionId, { status: "deleted" });
    await status.refresh(true);
    expect(knownEmpty).toBe(true);
    expect(network).toHaveBeenCalledTimes(2);
    expect(network).toHaveBeenNthCalledWith(1, "/api/chat/empty", expect.objectContaining({ cache: "no-store" }));
    expect(network).toHaveBeenNthCalledWith(2, "/api/chat/empty", expect.objectContaining({ cache: "no-store" }));
  });

  it("leaves a nonfinancial outcome unchanged without any empty-status or full-summary request", async () => {
    const network = vi.fn(); const publish = vi.fn();
    vi.stubGlobal("fetch", network);
    await createChatEmptyStatusRefresh("42", publish).refresh(false);
    expect(network).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled();
  });

  it("keeps confirmed Get Started visible throughout an empty account's uncertain message recheck", async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(done => { resolve = done; })));
    let knownEmpty: boolean | null = true;
    const publish = vi.fn((next: boolean | null) => { knownEmpty = next; });
    const pending = createChatEmptyStatusRefresh("42", publish).refresh(undefined);
    expect(knownEmpty).toBe(true);
    expect(publish).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(knownEmpty).toBe(true);
    resolve(Response.json({ ok: true, ownerId: "42", financialsEmpty: true }));
    await pending;
    expect(knownEmpty).toBe(true);
    expect(publish.mock.calls).toEqual([[true]]);
  });

  it("retains the last confirmed answer across repeated and superseded in-flight checks", async () => {
    const requests: { resolve: (response: Response) => void; signal: AbortSignal }[] = [];
    vi.stubGlobal("fetch", vi.fn((_url: string, options: RequestInit) => new Promise<Response>(resolve => { requests.push({ resolve, signal: options.signal as AbortSignal }); })));
    let knownEmpty: boolean | null = true;
    const publish = vi.fn((next: boolean | null) => { knownEmpty = next; });
    const status = createChatEmptyStatusRefresh("42", publish);
    const first = status.refresh(undefined);
    expect(knownEmpty).toBe(true);
    const second = status.refresh(undefined);
    expect(knownEmpty).toBe(true);
    const latest = status.refresh(true);
    expect(knownEmpty).toBe(true);
    expect(publish).not.toHaveBeenCalled();
    expect(requests.slice(0, 2).every(request => request.signal.aborted)).toBe(true);
    requests[0].resolve(Response.json({ ok: true, ownerId: "42", financialsEmpty: false }));
    requests[1].resolve(Response.json({ ok: true, ownerId: "42", financialsEmpty: true }));
    await Promise.all([first, second]);
    expect(knownEmpty).toBe(true);
    expect(publish).not.toHaveBeenCalled();
    requests[2].resolve(Response.json({ ok: true, ownerId: "42", financialsEmpty: true }));
    await latest;
    expect(knownEmpty).toBe(true);
    expect(publish.mock.calls).toEqual([[true]]);
  });

  it("switches from Get Started only when the latest response confirms a populated account", async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(done => { resolve = done; })));
    let knownEmpty: boolean | null = true;
    const publish = vi.fn((next: boolean | null) => { knownEmpty = next; });
    const pending = createChatEmptyStatusRefresh("42", publish).refresh(true);
    expect(knownEmpty).toBe(true);
    expect(publish).not.toHaveBeenCalled();
    resolve(Response.json({ ok: true, ownerId: "42", financialsEmpty: false }));
    await pending;
    expect(knownEmpty).toBe(false);
    expect(publish.mock.calls).toEqual([[false]]);
  });

  it.each([true, false])("keeps initially unknown status unknown until a valid answer arrives (%s)", async empty => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(done => { resolve = done; })));
    let knownEmpty: boolean | null = null;
    const publish = vi.fn((next: boolean | null) => { knownEmpty = next; });
    const pending = createChatEmptyStatusRefresh("42", publish).refresh(undefined);
    expect(knownEmpty).toBeNull();
    expect(publish).not.toHaveBeenCalled();
    resolve(Response.json({ ok: true, ownerId: "42", financialsEmpty: empty }));
    await pending;
    expect(knownEmpty).toBe(empty);
    expect(publish.mock.calls).toEqual([[empty]]);
  });

  it.each([
    [200, { ok: true, ownerId: "other-owner", financialsEmpty: true }],
    [500, { ok: false, financialsEmpty: true }],
    [200, { ok: true, ownerId: "42", financialsEmpty: "true" }],
  ])("does not display empty guidance from another session or a failed/invalid response (%s)", async (code, payload) => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(done => { resolve = done; })));
    let knownEmpty: boolean | null = true;
    const publish = vi.fn((next: boolean | null) => { knownEmpty = next; });
    const pending = createChatEmptyStatusRefresh("42", publish).refresh(true);
    expect(knownEmpty).toBe(true);
    expect(publish).not.toHaveBeenCalled();
    resolve(Response.json(payload, { status: code }));
    await pending;
    expect(knownEmpty).toBeNull();
    expect(publish).not.toHaveBeenCalledWith(true);
    expect(publish.mock.calls).toEqual([[null]]);
  });

  it("clears the confirmed answer to unknown if the current check loses its connection", async () => {
    let reject!: (reason: Error) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((_resolve, fail) => { reject = fail; })));
    let knownEmpty: boolean | null = true;
    const publish = vi.fn((next: boolean | null) => { knownEmpty = next; });
    const pending = createChatEmptyStatusRefresh("42", publish).refresh(undefined);
    expect(knownEmpty).toBe(true);
    reject(new Error("Synthetic connection lost"));
    await pending;
    expect(knownEmpty).toBeNull();
    expect(publish.mock.calls).toEqual([[null]]);
  });

  it("ignores an older empty answer after a newer write has returned non-empty, even if fetch ignores abort", async () => {
    const requests: { resolve: (response: Response) => void; signal: AbortSignal }[] = [];
    vi.stubGlobal("fetch", vi.fn((_url: string, options: RequestInit) => new Promise<Response>(resolve => { requests.push({ resolve, signal: options.signal as AbortSignal }); })));
    const publish = vi.fn(); const status = createChatEmptyStatusRefresh("42", publish);
    const older = status.refresh(true); const newer = status.refresh(true);
    expect(requests[0].signal.aborted).toBe(true);
    requests[1].resolve(Response.json({ ok: true, ownerId: "42", financialsEmpty: false }));
    await newer;
    requests[0].resolve(Response.json({ ok: true, ownerId: "42", financialsEmpty: true }));
    await older;
    expect(publish.mock.calls).toEqual([[false]]);
  });

  it("ignores a late failed response after the latest check confirmed the account remains empty", async () => {
    const requests: ((response: Response) => void)[] = [];
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { requests.push(resolve); })));
    let knownEmpty: boolean | null = true;
    const publish = vi.fn((next: boolean | null) => { knownEmpty = next; });
    const status = createChatEmptyStatusRefresh("42", publish);
    const older = status.refresh(undefined);
    const latest = status.refresh(undefined);
    requests[1](Response.json({ ok: true, ownerId: "42", financialsEmpty: true }));
    await latest;
    expect(knownEmpty).toBe(true);
    requests[0](Response.json({ ok: false }, { status: 500 }));
    await older;
    expect(knownEmpty).toBe(true);
    expect(publish.mock.calls).toEqual([[true]]);
  });

  it("cancels outstanding status when its owner/component is disposed", async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(done => { resolve = done; })));
    const publish = vi.fn(); const status = createChatEmptyStatusRefresh("old-owner", publish);
    const pending = status.refresh(true);
    status.dispose();
    resolve(Response.json({ ok: true, ownerId: "old-owner", financialsEmpty: true }));
    await pending;
    await status.refresh(true);
    expect(publish).not.toHaveBeenCalled();
  });

  it("requests an authenticated, uncached status tied to its captured owner", async () => {
    const network = vi.fn(async () => Response.json({ ok: true, ownerId: "42", financialsEmpty: false }));
    vi.stubGlobal("fetch", network);
    const controller = new AbortController();
    await expect(loadOwnedChatEmptyStatus("42", controller.signal)).resolves.toBe(false);
    expect(network).toHaveBeenCalledExactlyOnceWith("/api/chat/empty", { cache: "no-store", credentials: "same-origin", signal: controller.signal });
  });
});
