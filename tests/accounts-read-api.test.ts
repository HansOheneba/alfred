import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/accounts/view/route";
import { applyAccountingAction } from "@/lib/finance/accounting/reducer";
import { AccountingError, emptyAccountingState, type AccountingAction } from "@/lib/finance/accounting/types";
import { MAX_ACCOUNTING_COMMAND_BYTES } from "@/lib/finance/accounting/schema";

const mocks = vi.hoisted(() => ({ owner: vi.fn(), read: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/web/api", () => ({ requireOwner: mocks.owner }));
vi.mock("@/lib/finance/accounting/persisted-store", () => ({ loadAccountingReadModel: mocks.read, saveAccountingAction: mocks.save }));

const OWNER = "fictional-api-owner", AT = "2026-11-05T12:00:00.000Z";
const owner = { profile: { profileId: OWNER, currency: "GHS" }, settings: { supabase: { url: "fictional-only" } } };
const result = (state = emptyAccountingState(OWNER)) => ({ state, availability: "ready", sourceVersion: "fictional-source-version", rawTransactions: [] });
const action: AccountingAction = { type: "create_account", expectedRevision: 0, requestId: "fictional-request:1", account: { id: "fictional-wallet", label: "Fictional wallet", provider: "Fictional", currency: "GHS", includeInCash: true } };
const post = (body: unknown = action, search = "") => POST(new Request(`https://alfred.invalid/api/accounts/view${search}`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", "x-alfred-owner": OWNER } }));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.owner.mockResolvedValue(owner);
  mocks.read.mockResolvedValue(result());
  mocks.save.mockResolvedValue(result(applyAccountingAction(emptyAccountingState(OWNER), action, AT)));
});

describe("owner-scoped Accounts read API", () => {
  it("loads one coherent owner-scoped server model and returns a compact, uncached DTO", async () => {
    const response = await GET(new Request("https://alfred.invalid/api/accounts/view?ownerId=fictional-other-owner"));
    expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, view: { kind: "accounts-read", ownerId: OWNER, currency: "GHS", page: { section: "activity", rows: [] } } });
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith(owner.settings.supabase, OWNER);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("authenticates before reading or mutating and does not accept a client owner", async () => {
    mocks.owner.mockResolvedValue(Response.json({ ok: false, text: "Sign in first." }, { status: 401 }));
    expect((await GET(new Request("https://alfred.invalid/api/accounts/view"))).status).toBe(401);
    expect((await post()).status).toBe(401);
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("fails closed if the loaded model belongs to another owner", async () => {
    mocks.read.mockResolvedValue(result(emptyAccountingState("fictional-other-owner")));
    const response = await GET(new Request("https://alfred.invalid/api/accounts/view"));
    expect(response.status).toBe(403); expect(JSON.stringify(await response.json())).not.toContain("fictional-other-owner");
  });

  it("rejects stale revision/source cursors and changed evidence fingerprints", async () => {
    const state = emptyAccountingState(OWNER);
    state.movements = [{ id: "fictional-payment", ownerId: OWNER, accountId: null, direction: "out", status: "review", amountMinor: 100, feeMinor: 0, currency: "GHS", date: "2026-11-05", occurredAt: AT,
      description: "Fictional payment", category: "Other", sourceId: "fictional-source", sourceKind: "bank", sourceFingerprint: "fictional-current", sourceText: "Fictional original alert", legacyTransactionId: null, feeTransactionId: null, legacyClassification: null }];
    mocks.read.mockResolvedValue(result(state));
    for (const search of ["?expectedRevision=1&expectedSourceVersion=fictional-source-version", "?expectedRevision=0&expectedSourceVersion=fictional-stale", "?section=evidence&movementId=fictional-payment&fingerprint=fictional-stale"]) {
      const response = await GET(new Request(`https://alfred.invalid/api/accounts/view${search}`));
      expect(response.status).toBe(409); expect(JSON.stringify(await response.json())).not.toContain("Fictional original alert");
    }
  });

  it("validates bounded selections before making any financial read", async () => {
    const response = await GET(new Request(`https://alfred.invalid/api/accounts/view?search=${"x".repeat(201)}`));
    expect(response.status).toBe(400); expect(mocks.read).not.toHaveBeenCalled();
  });

  it("does not expose database errors or report failed reads as empty successful accounts", async () => {
    mocks.read.mockRejectedValue(new Error("Fictional private database connection details"));
    const response = await GET(new Request("https://alfred.invalid/api/accounts/view"));
    expect(response.status).toBe(500); const body = await response.json();
    expect(body.ok).toBe(false); expect(body).not.toHaveProperty("view"); expect(JSON.stringify(body)).not.toContain("private");
  });
});

describe("compact Accounts command response", () => {
  it("rejects a changed authenticated session before reading a command body or calling the writer", async () => {
    mocks.owner.mockResolvedValue({ ...owner, profile: { ...owner.profile, profileId: "fictional-new-session-owner" } });
    // Both ledgers could be revision zero; revision checking alone cannot fence a session switch.
    const request = new Request("https://alfred.invalid/api/accounts/view", { method: "POST", body: JSON.stringify(action), headers: { "Content-Type": "application/json", "x-alfred-owner": OWNER } });
    const response = await POST(request);
    expect(response.status).toBe(403); expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ ok: false, text: expect.stringContaining("account changed") });
    expect(request.bodyUsed).toBe(false); expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.read).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "fictional-other-owner"])("requires the matching owner fence before any write (%s)", async expectedOwner => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (expectedOwner !== undefined) headers["x-alfred-owner"] = expectedOwner;
    const request = new Request("https://alfred.invalid/api/accounts/view", { method: "POST", body: JSON.stringify(action), headers });
    const response = await POST(request);
    expect(response.status).toBe(403); expect(request.bodyUsed).toBe(false);
    expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.read).not.toHaveBeenCalled();
  });

  it("sends the original strict command once to the full authoritative writer and acknowledges revision/request/fingerprint", async () => {
    const response = await post(action, "?section=snapshots&accountId=fictional-wallet&expectedRevision=0&expectedSourceVersion=fictional-source-version");
    expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    expect(body.ack).toEqual({ ownerId: OWNER, revision: 1, requestId: action.requestId });
    expect(body.view).toMatchObject({ kind: "accounts-read", revision: 1, page: { section: "snapshots", rows: [] }, accounts: [action.account] });
    expect(body).not.toHaveProperty("state"); expect(body.view.audit[0]).not.toHaveProperty("before");
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith(owner.settings.supabase, OWNER, action);
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it.each(["owner", "revision", "request", "audit-revision", "fingerprint"])("returns an uncertain save when the writer does not acknowledge the original %s", async kind => {
    const saved = result(applyAccountingAction(emptyAccountingState(OWNER), action, AT));
    if (kind === "owner") saved.state.ownerId = "fictional-other-owner";
    if (kind === "revision") saved.state.revision = 0;
    if (kind === "request") saved.state.audit[0].requestId = "fictional-other-request";
    if (kind === "audit-revision") saved.state.audit[0].revision = 0;
    if (kind === "fingerprint") saved.state.audit[0].actionFingerprint = "fictional-wrong-fingerprint";
    mocks.save.mockResolvedValue(saved);
    const response = await post();
    expect(response.status).toBe(500); const body = await response.json();
    expect(body).toMatchObject({ ok: false, code: "unconfirmed" }); expect(body.text).toContain("may have completed");
    expect(body).not.toHaveProperty("ack"); expect(body).not.toHaveProperty("view"); expect(mocks.save).toHaveBeenCalledOnce();
  });

  it("does not present a post-write projection failure as a safely retryable rejection", async () => {
    const response = await post(action, "?section=evidence&movementId=fictional-missing&fingerprint=fictional-missing");
    expect(response.status).toBe(500); expect(await response.json()).toMatchObject({ ok: false, code: "unconfirmed" });
    expect(mocks.save).toHaveBeenCalledOnce();
  });

  it("preserves stale/owner failures without replaying the command", async () => {
    mocks.save.mockRejectedValue(new AccountingError("fictional-source-private-details", "stale"));
    const response = await post();
    expect(response.status).toBe(409); expect(JSON.stringify(await response.json())).not.toContain("private-details");
    expect(mocks.save).toHaveBeenCalledOnce(); expect(mocks.read).not.toHaveBeenCalled();
  });

  it("keeps unavailable storage explicit and reports that no change was made", async () => {
    mocks.save.mockResolvedValue({ ...result(), availability: "migration-required", sourceVersion: null });
    const response = await post();
    expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ ok: false, text: expect.stringContaining("No financial change was made") });
  });

  it.each([{ ...action, ownerId: "fictional-other" }, { action }, { ...action, account: { ...action.account, currency: "bad" } }, { ...action, expectedRevision: -1 }])("rejects replacement state or invalid commands before calling the writer", async body => {
    const response = await post(body);
    expect(response.status).toBe(400); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("validates selection before writing and bounds bodies even without a Content-Length header", async () => {
    expect((await post(action, "?section=not-a-section")).status).toBe(400); expect(mocks.save).not.toHaveBeenCalled();
    const response = await POST(new Request("https://alfred.invalid/api/accounts/view", { method: "POST", body: "x".repeat(MAX_ACCOUNTING_COMMAND_BYTES + 1), headers: { "x-alfred-owner": OWNER } }));
    expect(response.status).toBe(413); expect(mocks.save).not.toHaveBeenCalled();
  });
});
