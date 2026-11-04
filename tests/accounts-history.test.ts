import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountPageControls, accountListPage, BalanceHistory, formatAccountTime, ACCOUNT_PAGE_SIZE } from "@/app/accounts/account-history";
import { AccountsWorkspace } from "@/app/accounts/accounts-workspace";
import { emptyAccountingState, type AccountingState } from "@/lib/finance/accounting/types";
const active = vi.hoisted(() => ({ tab: "accounts" }));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return { ...actual, useSyncExternalStore: (subscribe: Parameters<typeof actual.useSyncExternalStore>[0], snapshot: () => unknown, serverSnapshot: () => unknown) => actual.useSyncExternalStore(subscribe, snapshot, subscribe.name === "subscribeTab" ? () => active.tab : serverSnapshot) };
});
vi.mock("@/app/components/app-shell", () => ({ usePrivacyMask: () => [false] }));
function records(count: number) {
  const state = emptyAccountingState("fictional-owner");
  state.accounts.push({ id: "fictional-cash", label: "Fictional cash", provider: "Cash", currency: "GHS", includeInCash: true, createdAt: "2026-11-02T10:00:00Z" });
  state.movements = Array.from({ length: count }, (_, index) => ({ id: `fictional-${index}`, ownerId: state.ownerId, accountId: "fictional-cash", direction: "out", status: "confirmed", amountMinor: 100, feeMinor: 0, currency: "GHS", date: "2026-11-01", occurredAt: "2026-11-01T12:00:00Z", description: `Fictional movement ${index}`, category: "Other", sourceKind: "manual", sourceId: `fictional-source-${index}`, sourceFingerprint: `fictional-fingerprint-${index}`, legacyTransactionId: null, feeTransactionId: null, legacyClassification: null }));
  return state;
}
function workspace(state: AccountingState, subscriptions?: ReturnType<typeof createElement>) {
  return renderToStaticMarkup(createElement(AccountsWorkspace, { state, mode: "live", dispatch: vi.fn(), now: "2026-11-02T12:00:00Z", subscriptions }));
}
beforeEach(() => { active.tab = "accounts"; });
describe("bounded account history", () => {
  it("makes every source reachable through bounded pages without deleting, repeating or reordering records", () => {
    const rows = records(3001).movements, before = structuredClone(rows), reached: string[] = [];
    for (let page = 0; page < Math.ceil(rows.length / ACCOUNT_PAGE_SIZE); page++) {
      const window = accountListPage(rows, page);
      expect(window.rows.length).toBeLessThanOrEqual(ACCOUNT_PAGE_SIZE);
      reached.push(...window.rows.map((row) => row.id));
    }
    expect(reached).toEqual(rows.map((row) => row.id)); expect(new Set(reached).size).toBe(3001); expect(rows).toEqual(before);
    expect(accountListPage(rows, 1000)).toMatchObject({ page: 120, start: 3001, end: 3001 });
    expect(accountListPage(rows, -1)).toMatchObject({ page: 0, start: 1, end: 25 });
    expect(accountListPage([], 500)).toMatchObject({ rows: [], page: 0, start: 0, end: 0, pageCount: 1 });
  });
  it("renders at most one page in each approved responsive activity layout for 3000 records", () => {
    active.tab = "activity";
    const state = records(3000), before = structuredClone(state), markup = workspace(state);
    expect((markup.match(/<tr>/g) ?? []).length).toBe(26);
    expect((markup.match(/class="alfred-accounts-movementRow"/g) ?? []).length).toBe(25);
    expect(markup).toContain("1–25 of 3000 movements"); expect(markup).toContain("3000 movements");
    expect(markup).not.toContain("Fictional movement 2999"); expect(state).toEqual(before);
    expect(markup).toContain('aria-label="Next movements page"');
  });
  it("bounds the needs-attention list while retaining its complete total", () => {
    active.tab = "needs-attention";
    const state = records(1000); state.movements.forEach((row) => { row.status = "review"; });
    const markup = workspace(state);
    expect(markup).toContain("1000 movements"); expect(markup).toContain("1–25 of 1000 movements");
    expect((markup.match(/<tr>/g) ?? []).length).toBe(26);
  });
  it("does not render or format any balance records until their history is opened", () => {
    const state = records(0), account = state.accounts[0], money = vi.fn(() => "fictional balance");
    const snapshots = Array.from({ length: 3000 }, (_, index) => ({ id: `fictional-snapshot-${index}`, accountId: account.id, balanceMinor: index, occurredAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(), sourceId: "fictional-balance", sourceMovementId: null }));
    const markup = renderToStaticMarkup(createElement(BalanceHistory, { snapshots, account, money }));
    expect(markup).toBe('<details class="alfred-account-evidence"><summary>Balance history</summary></details>');
    expect(money).not.toHaveBeenCalled(); expect(snapshots).toHaveLength(3000);
  });
  it("keeps Previous and Next limits explicit and accessible, including the final page", () => {
    const window = accountListPage(Array.from({ length: 51 }, (_, id) => id), 2);
    const markup = renderToStaticMarkup(createElement(AccountPageControls, { ...window, label: "Balances", onPage: vi.fn() }));
    expect(markup).toContain("51–51 of 51 balances");
    expect(markup).toMatch(/disabled=""[^>]*aria-label="Next balances page"/);
    expect(markup).not.toMatch(/disabled=""[^>]*aria-label="Previous balances page"/);
    expect(renderToStaticMarkup(createElement(AccountPageControls, { ...accountListPage([1], 0), label: "Balances", onPage: vi.fn() }))).toBe("");
  });
  it("retains missing and invalid source timestamps rather than inventing them", () => {
    expect(formatAccountTime(null)).toBe("Time not recorded"); expect(formatAccountTime("invalid source time")).toBe("invalid source time");
    expect(formatAccountTime("2026-11-01T12:00:00Z")).toContain("1 Nov 2026");
  });
  it("does not mount subscriptions on other tabs and mounts it only when selected", () => {
    const mounted = vi.fn(), Panel = () => { mounted(); return createElement("p", null, "Fictional subscription"); };
    workspace(records(0), createElement(Panel)); expect(mounted).not.toHaveBeenCalled();
    active.tab = "subscriptions";
    expect(workspace(records(0), createElement(Panel))).toContain("Fictional subscription"); expect(mounted).toHaveBeenCalledOnce();
  });
});
