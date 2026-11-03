import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadAccountSubscriptions } from "@/app/accounts/subscriptions-actions";
import { subscriptionLoading, subscriptionReadState, subscriptionReloadFailed } from "@/app/accounts/subscriptions-state";
const mocks = vi.hoisted(() => ({ requireOwner: vi.fn(), accounting: vi.fn(), bills: vi.fn() }));
vi.mock("@/lib/web/api", () => ({ requireOwner: mocks.requireOwner }));
vi.mock("@/lib/finance/accounting/persisted-store", () => ({ loadAccountingState: mocks.accounting }));
vi.mock("@/lib/finance/bills", () => ({ createSupabaseBillStore: () => ({ list: mocks.bills }) }));
const owner = { profile: { profileId: "fictional-owner", currency: "GHS", timezone: "Africa/Accra" }, settings: { supabase: { url: "synthetic" } } };
beforeEach(() => { vi.resetAllMocks(); mocks.requireOwner.mockResolvedValue(owner); mocks.bills.mockResolvedValue([]); });
describe("deferred subscription bill reads", () => {
  it("authenticates before reading any financial record", async () => {
    mocks.requireOwner.mockResolvedValue(new Response(null, { status: 401 }));
    expect(await loadAccountSubscriptions()).toEqual({ ok: false, text: "Sign in again to load your subscriptions." });
    expect(mocks.accounting).not.toHaveBeenCalled(); expect(mocks.bills).not.toHaveBeenCalled();
  });
  it("reads authenticated owner's bill facts without loading accounting a second time", async () => {
    const result = await loadAccountSubscriptions();
    expect(result).toMatchObject({ ok: true, ownerId: owner.profile.profileId, data: { bills: [], currency: "GHS" } });
    expect(mocks.bills).toHaveBeenCalledExactlyOnceWith(owner.profile.profileId);
    expect(mocks.accounting).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("state"); expect(result).not.toHaveProperty("rawTransactions");
  });
  it.each(["bills", "requireOwner"] as const)("reports a %s read failure without returning false empty data", async (source) => {
    mocks[source].mockRejectedValue(new Error("synthetic private detail"));
    expect(await loadAccountSubscriptions()).toEqual({ ok: false, text: "Your subscriptions could not be loaded. Try again shortly." });
  });
});
const subscriptionData = { bills: [], currency: "GHS", today: "2026-11-02" };
describe("subscription response ownership and freshness", () => {
  it("rejects another session owner's successful response before cards become ready", () => {
    const result = subscriptionReadState({ ok: true, ownerId: "other-fictional-owner", data: subscriptionData }, "expected-fictional-owner");
    expect(result).toEqual({ kind: "error", text: "Your signed-in account changed. Reload Accounts before viewing subscriptions." });
    expect(result).not.toHaveProperty("data");
  });
  it("only accepts matching authenticated ownership", () => {
    expect(subscriptionReadState({ ok: true, ownerId: "fictional-owner", data: subscriptionData }, "fictional-owner")).toEqual({ kind: "ready", ownerId: "fictional-owner", data: subscriptionData });
  });
  it("loading and failed refresh states cannot contain stale cards, and a saved write stays explicit", () => {
    expect(subscriptionLoading).toEqual({ kind: "loading" });
    expect(subscriptionReadState({ ok: false, text: "Read failed" }, "fictional-owner", true)).toEqual({ kind: "error", text: subscriptionReloadFailed });
    expect(subscriptionReadState({ ok: false, text: "Read failed" }, "fictional-owner", true)).not.toHaveProperty("data");
  });
});
