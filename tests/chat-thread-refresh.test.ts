import { describe, expect, it, vi } from "vitest";
import { createOwnedChatThreadRefresh } from "@/app/chat/chat-panel";
const ownerId = "fictional-owner";
const body = (text: string, owner = ownerId) => ({ ok: true, ownerId: owner, messages: [{ id: text, role: "assistant", text, channel: "telegram", createdAt: "2026-11-03T12:00:00Z", clientId: null, ledgerChanged: false }], choices: [[{ label: text, choice: `b:${text}` }]] });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

describe("fresh chat answers and history", () => {
  it("reloads current buttons and history with one fresh owner-scoped read, without a page refresh", async () => {
    const publish = vi.fn(), request = vi.fn(async () => Response.json(body("Current question")));
    const refresh = createOwnedChatThreadRefresh(ownerId, publish, request);
    await refresh.refresh();
    expect(request).toHaveBeenCalledExactlyOnceWith("/api/chat", expect.objectContaining({ cache: "no-store", credentials: "same-origin", signal: expect.any(AbortSignal) }));
    expect(publish).toHaveBeenCalledExactlyOnceWith({ messages: body("Current question").messages, choices: body("Current question").choices });
  });
  it("aborts and discards an older response when a newer realtime question arrives", async () => {
    const old = deferred<Response>(), publish = vi.fn();
    const request = vi.fn().mockImplementationOnce(() => old.promise).mockResolvedValueOnce(Response.json(body("New question")));
    const refresh = createOwnedChatThreadRefresh(ownerId, publish, request);
    const first = refresh.refresh(), firstSignal = request.mock.calls[0][1].signal;
    await refresh.refresh();
    expect(firstSignal.aborted).toBe(true);
    old.resolve(Response.json(body("Old question"))); await first;
    expect(publish).toHaveBeenCalledOnce(); expect(publish.mock.calls[0][0].choices[0][0].label).toBe("New question");
  });
  it("rejects responses from another owner and discards reads canceled for a send or owner unmount", async () => {
    const publish = vi.fn(), request = vi.fn(async () => Response.json(body("Other owner's question", "fictional-other-owner")));
    const refresh = createOwnedChatThreadRefresh(ownerId, publish, request);
    await refresh.refresh(); expect(publish).not.toHaveBeenCalled();
    const pending = deferred<Response>(); request.mockImplementationOnce(() => pending.promise);
    const read = refresh.refresh(); refresh.cancel(); pending.resolve(Response.json(body("Pre-send question"))); await read;
    expect(publish).not.toHaveBeenCalled();
    const late = deferred<Response>(); request.mockImplementationOnce(() => late.promise);
    const oldOwner = refresh.refresh(); refresh.dispose(); late.resolve(Response.json(body("Late owner question"))); await oldOwner;
    expect(publish).not.toHaveBeenCalled(); await refresh.refresh(); expect(request).toHaveBeenCalledTimes(3);
  });
  it("does not replace saved answers/history with a failed read", async () => {
    const publish = vi.fn(), request = vi.fn(async () => Response.json({ ok: false }, { status: 500 }));
    const refresh = createOwnedChatThreadRefresh(ownerId, publish, request);
    await refresh.refresh(); expect(publish).not.toHaveBeenCalled();
  });
});
