import { afterEach, describe, expect, it, vi } from "vitest";
import { createMutationTransport, MutationUnconfirmedError } from "@/app/components/mutation-request";

afterEach(() => { vi.useRealTimers(); });
const pending: typeof fetch = () => new Promise(() => {});

describe("shared save recovery", () => {
  it("submits once and returns a confirmed JSON response without blocking other saves", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ ok: true, id: "sample" }));
    const transport = createMutationTransport({ request });
    await expect(transport.requestMutationJson("/api/goals", "POST", { title: "Sample goal" })).resolves.toEqual({ ok: true, id: "sample" });
    expect(request).toHaveBeenCalledExactlyOnceWith("/api/goals", expect.objectContaining({ method: "POST", body: JSON.stringify({ title: "Sample goal" }), credentials: "same-origin", cache: "no-store", signal: expect.any(AbortSignal) }));
    expect(transport.getMutationRecoverySnapshot()).toBe(false);
  });
  it("ends a stalled write and blocks subsequent submissions until a fresh page", async () => {
    vi.useFakeTimers();
    const request = vi.fn(pending), changed = vi.fn();
    const transport = createMutationTransport({ request, timeoutMs: 50 });
    transport.subscribeMutationRecovery(changed);
    const failed = expect(transport.requestMutationJson("/api/bills", "POST", { op: "create" })).rejects.toBeInstanceOf(MutationUnconfirmedError);
    await vi.advanceTimersByTimeAsync(50); await failed;
    expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(transport.getMutationRecoverySnapshot()).toBe(true); expect(changed).toHaveBeenCalledOnce();
    await expect(transport.requestMutationJson("/api/goals", "POST", { title: "Other form" })).rejects.toBeInstanceOf(MutationUnconfirmedError);
    expect(request).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    const freshPage = createMutationTransport({ request: async () => Response.json({ ok: true }) });
    await expect(freshPage.requestMutationJson("/api/bills", "POST", {})).resolves.toEqual({ ok: true });
  });
  it("includes response decoding in the deadline", async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>(async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }) as Response);
    const transport = createMutationTransport({ request, timeoutMs: 50 });
    const failed = expect(transport.requestMutationJson("/api/settings", "POST", {})).rejects.toBeInstanceOf(MutationUnconfirmedError);
    await vi.advanceTimersByTimeAsync(50); await failed;
    expect(transport.getMutationRecoverySnapshot()).toBe(true); expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
  it("does not publish a late success or clear recovery after the deadline", async () => {
    vi.useFakeTimers();
    let resolve!: (value: Response) => void;
    const request = vi.fn<typeof fetch>(() => new Promise(done => { resolve = done; }));
    const transport = createMutationTransport({ request, timeoutMs: 50 }), publish = vi.fn();
    const result = transport.requestMutationJson("/api/investments", "POST", {}).then(publish);
    const failed = expect(result).rejects.toBeInstanceOf(MutationUnconfirmedError);
    await vi.advanceTimersByTimeAsync(50); await failed;
    resolve(Response.json({ ok: true })); await vi.advanceTimersByTimeAsync(1);
    expect(publish).not.toHaveBeenCalled(); expect(transport.getMutationRecoverySnapshot()).toBe(true); expect(request).toHaveBeenCalledOnce();
  });
  it.each([
    ["lost connection", async () => { throw new TypeError("Sample disconnected network"); }],
    ["unreadable success", async () => new Response("Sample invalid JSON")],
    ["missing acknowledgement", async () => Response.json({ value: "sample" })],
    ["server failure", async () => Response.json({ ok: false, text: "Could not load after writing" }, { status: 500 })],
  ])("requires recovery after %s without replaying", async (_, request) => {
    const submit = vi.fn(request), transport = createMutationTransport({ request: submit as typeof fetch });
    await expect(transport.requestMutationJson("/api/budgets", "POST", {})).rejects.toBeInstanceOf(MutationUnconfirmedError);
    expect(transport.getMutationRecoverySnapshot()).toBe(true); expect(submit).toHaveBeenCalledOnce();
  });
  it.each([400, 403, 409, 422])("keeps a known %s rejection editable and preserves the server message", async status => {
    const transport = createMutationTransport({ request: async () => Response.json({ ok: false, text: "Check these details." }, { status }) });
    await expect(transport.requestMutationJson("/api/settings", "POST", {})).rejects.toThrow("Check these details.");
    expect(transport.getMutationRecoverySnapshot()).toBe(false);
  });
  it("preserves an explicit application rejection and removes unsubscribed listeners", async () => {
    const transport = createMutationTransport({ request: async () => Response.json({ ok: false, text: "Already exists." }) });
    await expect(transport.requestMutationJson("/api/bills", "POST", {})).rejects.toThrow("Already exists.");
    expect(transport.getMutationRecoverySnapshot()).toBe(false);
    const changed = vi.fn(), unsubscribe = transport.subscribeMutationRecovery(changed);
    unsubscribe(); transport.requireMutationRecovery(); transport.requireMutationRecovery();
    expect(changed).not.toHaveBeenCalled(); expect(transport.getMutationRecoverySnapshot()).toBe(true);
  });
});
