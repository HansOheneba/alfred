import { afterEach, describe, expect, it, vi } from "vitest";

import { buildChatContext } from "@/lib/web/chat-context";
import type { Ledger } from "@/lib/web/ledger";

import { CHAT_SESSION_CHANGED, invalidateAfterChatOutcome, loadOwnedChatContext } from "@/app/chat/context-data";

afterEach(() => { vi.unstubAllGlobals(); });

describe("owner-scoped lazy Chat context", () => {
  const context = buildChatContext({ today: "2026-11-05", currency: "GHS", rows: [], budgets: [], goals: [], insights: [], owed: [], owe: [], bank: { connected: false, lastUsedAt: null, lastEmptyAt: null, accountNames: [], needsLabel: [], balances: [] } } as Ledger);

  it("accepts only the captured conversation owner's authenticated response", async () => {
    const network = vi.fn(async () => Response.json({ ok: true, ownerId: "synthetic-owner", context }));
    vi.stubGlobal("fetch", network);
    const controller = new AbortController();
    await expect(loadOwnedChatContext("synthetic-owner", controller.signal)).resolves.toEqual(context);
    expect(network).toHaveBeenCalledExactlyOnceWith("/api/chat/context", { cache: "no-store", credentials: "same-origin", signal: controller.signal });
  });

  it.each(["different-synthetic-owner", undefined])("rejects another session or an unstamped response (%s) before exposing its ledger", async ownerId => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, ownerId, context })));
    await expect(loadOwnedChatContext("synthetic-owner", new AbortController().signal)).rejects.toThrow(CHAT_SESSION_CHANGED);
  });

  it("checks the expected owner even if authentication changes while the request is in flight", async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(done => { resolve = done; })));
    const pending = loadOwnedChatContext("owner-at-request-start", new AbortController().signal);
    resolve(Response.json({ ok: true, ownerId: "new-session-owner", context }));
    await expect(pending).rejects.toThrow(CHAT_SESSION_CHANGED);
  });
});

describe("Chat context invalidation policy", () => {
  it("keeps plain read-only chat from invalidating context", () => {
    const invalidate = vi.fn(), refreshCategories = vi.fn();
    invalidateAfterChatOutcome(false, invalidate, refreshCategories);
    expect(invalidate).not.toHaveBeenCalled();
    expect(refreshCategories).not.toHaveBeenCalled();
  });

  it.each([true, undefined])("invalidates context exactly once after a write or unknown outcome (%s)", changed => {
    const invalidate = vi.fn(), refreshCategories = vi.fn();
    invalidateAfterChatOutcome(changed, invalidate, refreshCategories);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(refreshCategories).toHaveBeenCalledTimes(1);
  });
});
