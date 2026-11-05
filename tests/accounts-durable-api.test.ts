import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/accounts/view/route";
import { DurableDisplayUpdating } from "@/lib/finance/accounting/durable-read";
import { applyAccountingAction } from "@/lib/finance/accounting/reducer";
import { emptyAccountingState, type AccountingAction } from "@/lib/finance/accounting/types";
import { projectAccountsReadView } from "@/lib/finance/accounting/read-view";

const mocks = vi.hoisted(() => ({ owner: vi.fn(), display: vi.fn(), fullRead: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/web/api", () => ({ requireOwner: mocks.owner }));
vi.mock("@/lib/finance/accounting/durable-accounts", () => ({ loadAccountsReadView: mocks.display }));
vi.mock("@/lib/finance/accounting/persisted-store", () => ({ loadAccountingReadModel: mocks.fullRead, saveAccountingAction: mocks.save }));
const OWNER = "fictional-durable-api-owner", AT = "2026-11-05T12:00:00.000Z";
const owner = { profile: { profileId: OWNER, currency: "GHS" }, settings: { supabase: { url: "fictional-only" } } };
const action: AccountingAction = { type: "create_account", expectedRevision: 0, requestId: "fictional-durable-command", account: { id: "fictional-cash", label: "Fictional cash", provider: "Fictional", currency: "GHS", includeInCash: true } };
const result = (state = emptyAccountingState(OWNER)) => ({ state, availability: "ready" as const, sourceVersion: "fictional-source", rawTransactions: [] });
beforeEach(() => { vi.clearAllMocks(); mocks.owner.mockResolvedValue(owner); mocks.fullRead.mockRejectedValue(new Error("Full source read forbidden")); });

describe("Accounts durable GET and authoritative POST separation", () => {
  it("returns a durable DTO without loading complete sources", async () => {
    const view = projectAccountsReadView(result(), { currency: "GHS", section: "activity", page: 0 }); mocks.display.mockResolvedValue(view);
    const response = await GET(new Request("https://alfred.invalid/api/accounts/view?section=activity&page=2"));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true, view });
    expect(mocks.display).toHaveBeenCalledExactlyOnceWith(owner.settings.supabase, OWNER, expect.objectContaining({ section: "activity", page: 2 }));
    expect(mocks.fullRead).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it("reports202 updating without exposing an old or empty successful financial view", async () => {
    mocks.display.mockRejectedValue(new DurableDisplayUpdating());
    const response = await GET(new Request("https://alfred.invalid/api/accounts/view"));
    expect(response.status).toBe(202); expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json(); expect(body).toMatchObject({ ok: false, code: "updating", text: expect.stringContaining("updating") });
    expect(body).not.toHaveProperty("view"); expect(mocks.fullRead).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it("a command always calls the complete writer and projects its acknowledged result, even if durable reads are unavailable", async () => {
    mocks.display.mockRejectedValue(new DurableDisplayUpdating());
    const saved = result(applyAccountingAction(emptyAccountingState(OWNER), action, AT)); mocks.save.mockResolvedValue(saved);
    const response = await POST(new Request("https://alfred.invalid/api/accounts/view", { method: "POST", headers: { "Content-Type": "application/json", "x-alfred-owner": OWNER }, body: JSON.stringify(action) }));
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ ok: true, ack: { ownerId: OWNER, revision: 1, requestId: action.requestId }, view: { accounts: [action.account] } });
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith(owner.settings.supabase, OWNER, action);
    expect(mocks.display).not.toHaveBeenCalled(); expect(mocks.fullRead).not.toHaveBeenCalled();
  });
});
