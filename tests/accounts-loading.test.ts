import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AccountsPage from "@/app/accounts/page";
import { emptyAccountingState } from "@/lib/finance/accounting/types";

const mocks = vi.hoisted(() => ({ signedInAccount: vi.fn(), loadAccountingReadModel: vi.fn(), subscriptions: vi.fn(), bills: vi.fn() }));
vi.mock("@/app/signed-in", () => ({ publicAuthConfigured: () => true, signedInAccount: mocks.signedInAccount, MissingAuthConfig: () => null }));
vi.mock("@/app/components/app-shell", () => ({ AppShell: ({ children }: { children: ReactNode }) => createElement("main", null, children), usePrivacyMask: () => [false] }));
vi.mock("@/lib/finance/accounting/persisted-store", () => ({ loadAccountingReadModel: mocks.loadAccountingReadModel }));
vi.mock("@/app/accounts/subscriptions-panel", () => ({ SubscriptionsPanel: () => { mocks.subscriptions(); return createElement("div", null, "Loaded subscriptions"); } }));

vi.mock("@/lib/finance/bills", async (original) => {
  const actual = await original<typeof import("@/lib/finance/bills")>();
  return { ...actual, createSupabaseBillStore: () => ({ list: mocks.bills }) };
});

const owner = { profile: { profileId: "fictional-owner", preferredName: "Fictional", currency: "GHS" }, settings: { supabase: { url: "synthetic-only" } } };
async function screen() {
  const boundary = AccountsPage() as ReactElement<{ children: ReactElement }>;
  const child = boundary.props.children as ReactElement;
  return await (child.type as () => Promise<ReactElement>)();
}
beforeEach(() => { vi.clearAllMocks(); mocks.signedInAccount.mockResolvedValue({ kind: "ready", ...owner }); });

describe("Accounts initial read", () => {
  it("renders saved accounting from one owner-scoped read without a second fetch or subscription read", async () => {
    const state = emptyAccountingState(owner.profile.profileId);
    state.accounts.push({ id: "fictional-account", label: "Fictional savings", provider: "Cash", currency: "GHS", includeInCash: true, createdAt: "2026-11-02T10:00:00Z" });
    mocks.loadAccountingReadModel.mockResolvedValue({ state, availability: "ready", sourceVersion: "fictional-version", rawTransactions: [] });
    mocks.bills.mockImplementation(() => new Promise(() => {}));
    const fetch = vi.spyOn(globalThis, "fetch");
    const markup = renderToStaticMarkup(await screen());
    expect(mocks.loadAccountingReadModel).toHaveBeenCalledExactlyOnceWith(owner.settings.supabase, owner.profile.profileId);
    expect(markup).toContain("Fictional savings");
    expect(markup).not.toContain("Loading your account records");
    expect(mocks.subscriptions).not.toHaveBeenCalled();
    expect(mocks.bills).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });
  it("keeps read failure explicit with a retry instead of a false empty state", async () => {
    mocks.loadAccountingReadModel.mockRejectedValue(new Error("synthetic database failure"));
    const markup = renderToStaticMarkup(await screen());
    expect(markup).toContain("could not load your accounts");
    expect(markup).toContain("Retry"); expect(markup).toContain('role="alert"');
    expect(markup).not.toContain("Give your money a home"); expect(markup).not.toContain("synthetic database failure");
  });
  it("preserves known unavailable storage and saved records without enabling saves", async () => {
    const state = emptyAccountingState(owner.profile.profileId);
    state.accounts.push({ id: "fictional-account", label: "Existing cash", provider: "Cash", currency: "GHS", includeInCash: true, createdAt: "2026-11-02T10:00:00Z" });
    mocks.loadAccountingReadModel.mockResolvedValue({ state, availability: "migration-required", sourceVersion: null, rawTransactions: [] });
    const markup = renderToStaticMarkup(await screen());
    expect(markup).toContain("Account storage is not set up yet."); expect(markup).toContain("Existing cash");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Record balance/);
  });
  it("separates failed-read clients by owner even when neither read has a version", async () => {
    mocks.loadAccountingReadModel.mockRejectedValue(new Error("synthetic unavailable"));
    const first = await screen();
    mocks.signedInAccount.mockResolvedValue({ kind: "ready", ...owner, profile: { ...owner.profile, profileId: "fictional-second-owner" } });
    const next = await screen();
    const firstClient = (first.props as { children: ReactElement }).children;
    const nextClient = (next.props as { children: ReactElement }).children;
    expect(firstClient.key).toBe("fictional-owner:unavailable");
    expect(nextClient.key).toBe("fictional-second-owner:unavailable");
    expect(nextClient.props).toMatchObject({ initialPayload: null });
  });
  it("uses a new client identity for every fresh server read, including unversioned legacy data", async () => {
    mocks.loadAccountingReadModel.mockResolvedValue({ state: emptyAccountingState(owner.profile.profileId), availability: "migration-required", sourceVersion: null, rawTransactions: [] });
    const first = await screen(), next = await screen();
    const firstClient = (first.props as { children: ReactElement }).children;
    const nextClient = (next.props as { children: ReactElement }).children;
    expect(firstClient.key).not.toBe(nextClient.key);
  });
});
