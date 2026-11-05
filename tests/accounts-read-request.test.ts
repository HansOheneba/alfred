import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCOUNTS_VIEW_TIMEOUT_MS, AccountsViewRequestError, requestAccountsView } from "@/app/accounts/read-request";
import { projectAccountsReadView, type AccountsReadView } from "@/lib/finance/accounting/read-view";
import { applyAccountingAction } from "@/lib/finance/accounting/reducer";
import { emptyAccountingState, type AccountingAction, type AccountingState, type CashMovement } from "@/lib/finance/accounting/types";

const mutation = vi.hoisted(() => ({ assertMutationsAvailable: vi.fn(), requireMutationRecovery: vi.fn() }));
vi.mock("@/app/components/mutation-request", () => mutation);
const OWNER = "fictional-transport-owner", AT = "2026-11-05T12:00:00.000Z";
const action: AccountingAction = { type: "create_account", requestId: "fictional-request", expectedRevision: 0, account: { id: "fictional-cash", label: "Fictional cash", provider: "Fictional", currency: "GHS", includeInCash: true } };
function view(state: AccountingState = emptyAccountingState(OWNER)): AccountsReadView {
  return projectAccountsReadView({ state, availability: "ready", sourceVersion: "fictional-source-version", rawTransactions: [] }, { currency: "GHS", section: "activity", page: 0 });
}
const savedView = () => view(applyAccountingAction(emptyAccountingState(OWNER), action, AT));
const body = (value = savedView()) => ({ ok: true, view: value, ack: { ownerId: OWNER, revision: 1, requestId: action.requestId } });
const row: CashMovement = { id: "fictional-movement", ownerId: OWNER, accountId: null, direction: "out", status: "review", amountMinor: 100, feeMinor: 0, taxMinor: 0,
  currency: "GHS", date: "2026-11-05", occurredAt: AT, description: "Fictional payment", category: "Other", sourceId: "fictional-source", sourceKind: "manual", sourceFingerprint: "fictional-fingerprint", legacyTransactionId: null, feeTransactionId: null, legacyClassification: null };
const never: typeof fetch = () => new Promise<Response>(() => {});
beforeEach(() => { mutation.assertMutationsAvailable.mockReset(); mutation.requireMutationRecovery.mockClear(); });
afterEach(() => { vi.useRealTimers(); });

describe("bounded Accounts read transport", () => {
  it("accepts a genuine read DTO and sends an owner-session, uncached GET without mutation guards", async () => {
    const expected = view(), request = vi.fn<typeof fetch>(async () => Response.json({ ok: true, view: expected }));
    const query = new URLSearchParams({ section: "snapshots", accountId: "fictional-cash", page: "2" });
    await expect(requestAccountsView({ ownerId: OWNER, query, request })).resolves.toEqual(expected);
    expect(request).toHaveBeenCalledExactlyOnceWith(`/api/accounts/view?${query}`, expect.objectContaining({ method: "GET", cache: "no-store", credentials: "same-origin", signal: expect.any(AbortSignal) }));
    expect(request.mock.calls[0][1]).not.toHaveProperty("body");
    expect(mutation.assertMutationsAvailable).not.toHaveBeenCalled(); expect(mutation.requireMutationRecovery).not.toHaveBeenCalled();
  });

  it("rejects the old complete-state envelope instead of treating it as a display DTO", async () => {
    const request = vi.fn(async () => Response.json({ ok: true, state: emptyAccountingState(OWNER), availability: "ready" }));
    await expect(requestAccountsView({ ownerId: OWNER, request })).rejects.toMatchObject({ unconfirmed: false });
    expect(mutation.requireMutationRecovery).not.toHaveBeenCalled();
  });

  it.each(["GET", "POST"] as const)("rejects a %s DTO belonging to another owner", async method => {
    const wrong = savedView(); wrong.ownerId = "fictional-other-owner";
    const request = vi.fn(async () => Response.json(body(wrong)));
    await expect(requestAccountsView({ ownerId: OWNER, method, action, request })).rejects.toMatchObject({ unconfirmed: method === "POST" });
    expect(mutation.requireMutationRecovery).toHaveBeenCalledTimes(method === "POST" ? 1 : 0);
  });

  it.each(["activity", "attention", "targets", "movement", "similar", "transfer-outgoing", "transfer-incoming", "settlement-original", "return-movement"])("rejects nested foreign-owner source rows in %s", async section => {
    const base = savedView(), compact = { ...row, linked: false }, wrong = { ...compact, ownerId: "fictional-other-owner" };
    const reference = { movementId: row.id, sourceFingerprint: row.sourceFingerprint };
    let page: unknown;
    if (section.startsWith("transfer")) page = { section: "transfers", rows: [{ link: { id: "fictional-transfer", outgoing: reference, incoming: reference, createdAt: AT }, outgoing: section === "transfer-outgoing" ? wrong : compact, incoming: section === "transfer-incoming" ? wrong : compact }] };
    else if (section === "settlement-original") page = { section: "settlements", rows: [{ id: "fictional-settlement", kind: "refund", createdAt: AT, original: wrong, originalReference: reference, returnedMinor: 0, outstandingMinor: null, returnCount: 0, issue: null }] };
    else if (section === "return-movement") page = { section: "returns", rows: [{ movement: wrong, reference, principalMinor: 1 }] };
    else page = { section, rows: [wrong] };
    const selected = { ...base, page: { page: 0, pageSize: 25, total: 1, ...page as object } };
    const request = vi.fn(async () => Response.json({ ...body(), view: selected }));
    await expect(requestAccountsView({ ownerId: OWNER, method: "POST", action, request })).rejects.toMatchObject({ unconfirmed: true });
    expect(mutation.requireMutationRecovery).toHaveBeenCalledOnce();
  });

  it("rejects more than 25 source rows even if the rest of the DTO is valid", async () => {
    const oversized = savedView();
    oversized.page = { section: "activity", page: 0, pageSize: 25, total: 1000, rows: Array.from({ length: 1000 }, (_, index) => ({ ...row, id: `fictional:${index}`, linked: false })) };
    const request = vi.fn(async () => Response.json(body(oversized)));
    await expect(requestAccountsView({ ownerId: OWNER, method: "POST", action, request })).rejects.toMatchObject({ unconfirmed: true });
    expect(mutation.requireMutationRecovery).toHaveBeenCalledOnce();
  });

  it("rejects raw source evidence leaking into a compact activity row", async () => {
    const compact = savedView();
    compact.page = { section: "activity", page: 0, pageSize: 25, total: 1, rows: [{ ...row, linked: false, sourceText: "Fictional raw alert must load separately" } as CashMovement & { linked: boolean }] };
    const request = vi.fn(async () => Response.json(body(compact)));
    await expect(requestAccountsView({ ownerId: OWNER, method: "POST", action, request })).rejects.toMatchObject({ unconfirmed: true });
    expect(mutation.requireMutationRecovery).toHaveBeenCalledOnce();
  });

  it("bounds stalled GET headers without requiring mutation recovery", async () => {
    vi.useFakeTimers();
    const request = vi.fn(never), result = requestAccountsView({ ownerId: OWNER, request, timeoutMs: 20 });
    const rejected = expect(result).rejects.toMatchObject({ unconfirmed: false });
    await vi.advanceTimersByTimeAsync(20); await rejected;
    expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true); expect(request).toHaveBeenCalledOnce();
    expect(mutation.requireMutationRecovery).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the default 20-second deadline for stalled write headers and never retries", async () => {
    vi.useFakeTimers();
    expect(ACCOUNTS_VIEW_TIMEOUT_MS).toBe(20_000);
    const request = vi.fn(never), result = requestAccountsView({ ownerId: OWNER, method: "POST", action, request });
    const rejected = expect(result).rejects.toMatchObject({ unconfirmed: true });
    await vi.advanceTimersByTimeAsync(ACCOUNTS_VIEW_TIMEOUT_MS); await rejected;
    expect(request).toHaveBeenCalledOnce(); expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(mutation.requireMutationRecovery).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it("includes stalled JSON body decoding in the write deadline", async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>(async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }) as Response);
    const result = requestAccountsView({ ownerId: OWNER, method: "POST", action, request, timeoutMs: 20 });
    const rejected = expect(result).rejects.toMatchObject({ unconfirmed: true });
    await vi.advanceTimersByTimeAsync(20); await rejected;
    expect(request).toHaveBeenCalledOnce(); expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(mutation.requireMutationRecovery).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["headers", "body"] as const)("does not publish a late successful %s response after an uncertain write", async stage => {
    vi.useFakeTimers();
    let finishHeaders: ((response: Response) => void) | undefined, finishBody: ((value: unknown) => void) | undefined;
    const request = vi.fn<typeof fetch>(() => stage === "headers"
      ? new Promise<Response>(resolve => { finishHeaders = resolve; })
      : Promise.resolve({ ok: true, status: 200, json: () => new Promise(resolve => { finishBody = resolve; }) } as Response));
    const published = vi.fn(), failed = vi.fn();
    const completion = requestAccountsView({ ownerId: OWNER, method: "POST", action, request, timeoutMs: 20 }).then(published, failed);
    await vi.advanceTimersByTimeAsync(20); await completion;
    expect(failed).toHaveBeenCalledOnce(); expect(published).not.toHaveBeenCalled();
    if (stage === "headers") finishHeaders?.(Response.json(body())); else finishBody?.(body());
    await vi.advanceTimersByTimeAsync(100);
    expect(published).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce(); expect(mutation.requireMutationRecovery).toHaveBeenCalledOnce();
  });
});

describe("Accounts command acknowledgment and recovery", () => {
  it("submits the original revision and request ID exactly once and returns only an acknowledged compact view", async () => {
    const expected = body(), request = vi.fn(async () => Response.json(expected));
    await expect(requestAccountsView({ ownerId: OWNER, method: "POST", action, request })).resolves.toEqual(expected.view);
    expect(request).toHaveBeenCalledExactlyOnceWith("/api/accounts/view", expect.objectContaining({ method: "POST", body: JSON.stringify(action), headers: { "Content-Type": "application/json", "x-alfred-owner": OWNER }, cache: "no-store", credentials: "same-origin" }));
    expect(mutation.assertMutationsAvailable).toHaveBeenCalledOnce(); expect(mutation.requireMutationRecovery).not.toHaveBeenCalled();
  });

  it.each(["owner", "revision", "request", "view-revision", "missing"])("requires recovery when acknowledgment %s does not match", async kind => {
    const response: Record<string, unknown> = body();
    const ack = response.ack as { ownerId: string; revision: number; requestId: string };
    if (kind === "owner") ack.ownerId = "fictional-other-owner";
    if (kind === "revision") ack.revision = 2;
    if (kind === "request") ack.requestId = "fictional-other-request";
    if (kind === "view-revision") (response.view as AccountsReadView).revision = 2;
    if (kind === "missing") delete response.ack;
    const request = vi.fn(async () => Response.json(response));
    await expect(requestAccountsView({ ownerId: OWNER, method: "POST", action, request })).rejects.toMatchObject({ unconfirmed: true });
    expect(request).toHaveBeenCalledOnce(); expect(mutation.requireMutationRecovery).toHaveBeenCalledOnce();
  });

  it.each([400, 403, 409, 422])("keeps a known HTTP %s command rejection editable and never retries it", async status => {
    const request = vi.fn(async () => Response.json({ ok: false, text: "Fictional known rejected action." }, { status }));
    await expect(requestAccountsView({ ownerId: OWNER, method: "POST", action, request })).rejects.toMatchObject({ status, unconfirmed: false, message: "Fictional known rejected action." });
    expect(request).toHaveBeenCalledOnce(); expect(mutation.requireMutationRecovery).not.toHaveBeenCalled();
  });

  it.each([
    ["network failure", () => Promise.reject(new TypeError("Fictional network failure"))],
    ["invalid JSON", async () => new Response("Fictional broken JSON")],
    ["server error", async () => Response.json({ ok: false }, { status: 500 })],
    ["malformed success", async () => Response.json({ ok: true, view: { ownerId: OWNER } })],
    ["false success", async () => Response.json({ ok: false })],
  ] as const)("treats %s as uncertain and blocks further mutations", async (_kind, transport) => {
    const request = vi.fn(transport);
    await expect(requestAccountsView({ ownerId: OWNER, method: "POST", action, request })).rejects.toBeInstanceOf(AccountsViewRequestError);
    expect(request).toHaveBeenCalledOnce(); expect(mutation.requireMutationRecovery).toHaveBeenCalledOnce();
  });

  it("does not send another write when a prior mutation requires recovery", async () => {
    mutation.assertMutationsAvailable.mockImplementationOnce(() => { throw new Error("Fictional reload required."); });
    const request = vi.fn(async () => Response.json(body()));
    await expect(requestAccountsView({ ownerId: OWNER, method: "POST", action, request })).rejects.toMatchObject({ unconfirmed: true });
    expect(request).not.toHaveBeenCalled(); expect(mutation.requireMutationRecovery).toHaveBeenCalledOnce();
  });
});
