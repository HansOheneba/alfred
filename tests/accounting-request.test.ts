import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountingRequestError, dispatchAccounting, requestAccounting, UNCONFIRMED_SAVE_MESSAGE } from "@/app/accounts/accounting-request";
import { emptyAccountingState, type AccountingAction } from "@/lib/finance/accounting/types";
import { executeAccountReview, prepareMovementReview } from "@/app/accounts/activity-tools";
import { applyAccountingAction } from "@/lib/finance/accounting/reducer";

const gate = vi.hoisted(() => ({ assertMutationsAvailable: vi.fn(), requireMutationRecovery: vi.fn() }));
vi.mock("@/app/components/mutation-request", () => gate);

const ownerId = "sample-owner";
const action: AccountingAction = { type: "assign_movement", requestId: "sample-request", expectedRevision: 0, movement: { movementId: "sample-rent", sourceFingerprint: "sample-source" }, accountId: "sample-wallet" };
const payload = () => ({ ok: true, state: emptyAccountingState(ownerId), availability: "ready" });
function sampleState() {
  const state = emptyAccountingState(ownerId);
  state.accounts.push({ id: "sample-wallet", label: "Sample wallet", currency: "GHS", provider: "Sample", includeInCash: true, createdAt: "2026-11-05T00:00:00Z" });
  state.movements.push({ id: "sample-rent", ownerId, accountId: null, direction: "out", status: "confirmed", amountMinor: 150000, feeMinor: 0, taxMinor: 0, currency: "GHS", date: "2026-11-05", occurredAt: null, description: "Rent", category: "Rent & home", sourceId: "sample-source", sourceKind: "manual", sourceFingerprint: "sample-source", legacyTransactionId: null, feeTransactionId: null, legacyClassification: null });
  return state;
}
const savedPayload = () => ({ ...payload(), state: applyAccountingAction(sampleState(), action, "2026-11-05T00:00:00Z") });
const pending: typeof fetch = () => new Promise<Response>(() => {});
beforeEach(() => { gate.assertMutationsAvailable.mockReset(); gate.requireMutationRecovery.mockClear(); });
afterEach(() => { vi.useRealTimers(); });

describe("bounded accounting requests", () => {
  it("posts an action once with its original revision and request ID", async () => {
    const request = vi.fn(async () => Response.json(savedPayload())), publish = vi.fn(), recover = vi.fn();
    await expect(dispatchAccounting(action, { ownerId, request, publish, recover })).resolves.toEqual(savedPayload().state);
    expect(publish).toHaveBeenCalledExactlyOnceWith(savedPayload()); expect(recover).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledExactlyOnceWith("/api/accounting", expect.objectContaining({ method: "POST", cache: "no-store", credentials: "same-origin", signal: expect.any(AbortSignal), body: JSON.stringify(action) }));
  });
  it("does not submit an account action while another save requires recovery", async () => {
    gate.assertMutationsAvailable.mockImplementationOnce(() => { throw new Error("Reload before another change."); });
    const request = vi.fn(async () => Response.json(savedPayload())), publish = vi.fn(), recover = vi.fn();
    await expect(dispatchAccounting(action, { ownerId, request, publish, recover })).rejects.toMatchObject({ unconfirmed: true });
    expect(request).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled(); expect(recover).toHaveBeenCalledOnce();
  });
  it.each(["revision", "request ID"])("requires recovery when a success response does not acknowledge the %s", async mismatch => {
    const body = savedPayload();
    if (mismatch === "revision") body.state.revision = action.expectedRevision;
    else body.state.audit.at(-1)!.requestId = "sample-other-request";
    const request = vi.fn(async () => Response.json(body)), publish = vi.fn(), recover = vi.fn();
    await expect(dispatchAccounting(action, { ownerId, request, publish, recover })).rejects.toMatchObject({ unconfirmed: true });
    expect(publish).not.toHaveBeenCalled(); expect(recover).toHaveBeenCalledExactlyOnceWith(UNCONFIRMED_SAVE_MESSAGE); expect(request).toHaveBeenCalledOnce();
  });
  it("ends a stalled write, aborts the transport, and requires fresh records without replaying", async () => {
    vi.useFakeTimers();
    const request = vi.fn(pending), publish = vi.fn(), recover = vi.fn();
    const result = dispatchAccounting(action, { ownerId, request, publish, recover, timeoutMs: 50 });
    const failure = expect(result).rejects.toMatchObject({ unconfirmed: true, message: UNCONFIRMED_SAVE_MESSAGE });
    await vi.advanceTimersByTimeAsync(50); await failure;
    expect(request).toHaveBeenCalledOnce(); expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(publish).not.toHaveBeenCalled(); expect(recover).toHaveBeenCalledExactlyOnceWith(UNCONFIRMED_SAVE_MESSAGE);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("includes response body decoding in the deadline", async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>(async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }) as Response);
    const result = requestAccounting({ method: "POST", action, request, timeoutMs: 50 });
    const failure = expect(result).rejects.toMatchObject({ unconfirmed: true });
    await vi.advanceTimersByTimeAsync(50); await failure;
    expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
  it("bounds the refresh after a conflict and never submits the write again", async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockResolvedValueOnce(Response.json({ ok: false, text: "Records changed" }, { status: 409 })).mockImplementationOnce(pending);
    const publish = vi.fn(), recover = vi.fn();
    const result = dispatchAccounting(action, { ownerId, request, publish, recover, timeoutMs: 50 });
    const failure = expect(result).rejects.toThrow(/Records changed/);
    await vi.advanceTimersByTimeAsync(50); await failure;
    expect(request.mock.calls.map(([, options]) => options.method)).toEqual(["POST", "GET"]);
    expect(publish).not.toHaveBeenCalled(); expect(recover).toHaveBeenCalledOnce();
  });
  it("publishes a fresh conflict response without retrying the action", async () => {
    const request = vi.fn().mockResolvedValueOnce(Response.json({ ok: false, text: "Source evidence changed." }, { status: 409 })).mockResolvedValueOnce(Response.json(payload()));
    const publish = vi.fn(), recover = vi.fn();
    await expect(dispatchAccounting(action, { ownerId, request, publish, recover })).rejects.toThrow("Source evidence changed. The latest records are loaded.");
    expect(publish).toHaveBeenCalledExactlyOnceWith(payload()); expect(recover).not.toHaveBeenCalled(); expect(request).toHaveBeenCalledTimes(2);
  });
  it("preserves a protected-record conflict instead of blaming another session", async () => {
    const reason = "Legacy refund or loan classification must be resolved before reclassifying this movement.";
    const request = vi.fn().mockResolvedValueOnce(Response.json({ ok: false, text: reason }, { status: 409 })).mockResolvedValueOnce(Response.json(payload()));
    const publish = vi.fn(), recover = vi.fn();
    const result = dispatchAccounting(action, { ownerId, request, publish, recover });
    await expect(result).rejects.toThrow(reason);
    expect(publish).toHaveBeenCalledOnce(); expect(recover).not.toHaveBeenCalled(); expect(request).toHaveBeenCalledTimes(2);
  });
  it.each([
    ["rejected connection", () => Promise.reject(new TypeError("Sample disconnected network"))],
    ["unreadable response", async () => new Response("Sample broken JSON")],
    ["unconfirmed server response", async () => Response.json({ ok: false }, { status: 500 })],
    ["malformed state", async () => Response.json({ ...payload(), state: { ownerId } })],
    ["wrong owner", async () => Response.json({ ...payload(), state: emptyAccountingState("sample-other-owner") })],
  ])("treats %s as unconfirmed and blocks further edits until reloaded", async (_, request) => {
    const publish = vi.fn(), recover = vi.fn();
    await expect(dispatchAccounting(action, { ownerId, request: request as typeof fetch, publish, recover })).rejects.toBeInstanceOf(AccountingRequestError);
    expect(publish).not.toHaveBeenCalled(); expect(recover).toHaveBeenCalledExactlyOnceWith(UNCONFIRMED_SAVE_MESSAGE);
  });
  it("keeps a rejected validation response explicit without claiming success", async () => {
    const request = vi.fn(async () => Response.json({ ok: false, text: "Choose an account in this currency." }, { status: 400 }));
    const publish = vi.fn(), recover = vi.fn();
    await expect(dispatchAccounting(action, { ownerId, request, publish, recover })).rejects.toMatchObject({ status: 400, unconfirmed: false, message: "Choose an account in this currency." });
    expect(publish).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled();
  });
  it("stops the account-only Rent review when its transport stalls", async () => {
    vi.useFakeTimers();
    const state = sampleState();
    const review = prepareMovementReview(state, "sample-rent", { accountId: "sample-wallet", category: "Rent & home", status: "confirmed" });
    const request = vi.fn(pending), progress = vi.fn(), recover = vi.fn();
    const result = executeAccountReview(review, state, command => dispatchAccounting(command, { ownerId, request, recover, publish: vi.fn(), timeoutMs: 50 }), () => "sample-request", progress);
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toMatchObject({ ok: false, confirmed: 0, total: 1 });
    expect(request).toHaveBeenCalledOnce(); expect(progress).not.toHaveBeenCalled(); expect(recover).toHaveBeenCalledOnce();
    expect(state.movements[0].accountId).toBeNull(); expect(state.movements[0].amountMinor).toBe(150000);
  });
});
