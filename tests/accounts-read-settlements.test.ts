import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReadSettlements, requestAccountSubscriptions } from "@/app/accounts/accounts-read-client";
import { Field } from "@/app/accounts/accounts-workspace";
import { emptyAccountingState, type CashMovement } from "@/lib/finance/accounting/types";
import { projectAccountsReadView } from "@/lib/finance/accounting/read-view";

type Element = ReactElement<Record<string, unknown>>;
type Setter<T> = (next: T | ((old: T) => T)) => void;
const runtime = vi.hoisted(() => ({ current: null as { state<T>(value: T | (() => T)): [T, Setter<T>] } | null }));
const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/app/accounts/read-request", () => ({ requestAccountsView: api.request, AccountsViewRequestError: class extends Error {} }));
vi.mock("@/app/components/app-shell", () => ({ usePrivacyMask: () => [false] }));
vi.mock("@/app/components/category-catalog", () => ({ useCustomCategories: () => [] }));
vi.mock("@/app/accounts/subscriptions-actions", () => ({ loadAccountSubscriptionsView: vi.fn() }));
vi.mock("react", async load => {
  const react = await load<typeof import("react")>();
  return { ...react, useState: <T>(value: T | (() => T)) => runtime.current ? runtime.current.state(value) : react.useState(value), useRef: <T>(value: T) => runtime.current ? runtime.current.state({ current: value })[0] : react.useRef(value), useEffect: () => undefined };
});
function nodes(value: ReactNode): Element[] { return Array.isArray(value) ? value.flatMap(nodes) : isValidElement<Record<string, unknown>>(value) ? [value, ...nodes(value.props.children as ReactNode)] : []; }
class Screen {
  private values: unknown[] = []; private cursor = 0; tree!: ReactNode;
  constructor(private component: () => ReactNode) {}
  state<T>(initial: T | (() => T)): [T, Setter<T>] { const index = this.cursor++; if (!(index in this.values)) this.values[index] = typeof initial === "function" ? (initial as () => T)() : initial; return [this.values[index] as T, value => { this.values[index] = typeof value === "function" ? (value as (previous: T) => T)(this.values[index] as T) : value; }]; }
  render() { this.cursor = 0; runtime.current = this; try { this.tree = this.component(); } finally { runtime.current = null; } return this; }
  choose(label: string, value: unknown) { const picker = nodes(this.tree).find(row => typeof row.type === "function" && row.type.name === "MovementPicker" && row.props.label === label)!; (picker.props.choose as (value: unknown) => void)(value); return this.render(); }
  amount(value: string) { const field = nodes(this.tree).find(row => row.type === Field && row.props.label === "Principal returned")!; const input = nodes(field.props.children as ReactNode).find(row => row.type === "input")!; (input.props.onChange as (event: unknown) => void)({ target: { value } }); return this.render(); }
  async submit() { await (nodes(this.tree).find(row => row.type === "form")!.props.onSubmit as (event: unknown) => Promise<void>)({ preventDefault() {} }); return this.render(); }
}
const OWNER = "fictional-settlement-owner", AT = "2026-11-05T12:00:00.000Z";
function movement(id: string, direction: "in" | "out"): CashMovement { return { id, ownerId: OWNER, accountId: "fictional-cash", direction, status: "confirmed", amountMinor: 10_000, feeMinor: 0, taxMinor: 0, currency: "GHS", date: "2026-11-05", occurredAt: AT, description: id, category: "Other", sourceId: id, sourceKind: "manual", sourceFingerprint: `current:${id}`, legacyTransactionId: null, feeTransactionId: null, legacyClassification: null }; }
function fixture() {
  const state = emptyAccountingState(OWNER);
  state.accounts = [{ id: "fictional-cash", label: "Fictional cash", provider: "Fictional", currency: "GHS", includeInCash: true, createdAt: AT }];
  state.movements = [movement("fictional-original", "out"), movement("fictional-return", "in")];
  const base = projectAccountsReadView({ state, availability: "ready", sourceVersion: "fictional-version", rawTransactions: [] }, { section: "activity", page: 0, currency: "GHS" });
  return { base, original: { ...state.movements[0], linked: true }, returned: { ...state.movements[1], linked: false } };
}
afterEach(() => { api.request.mockReset(); runtime.current = null; vi.useRealTimers(); });

describe("paged Accounts partial return workflows", () => {
  it.each(["refund", "loan"] as const)("appends a %s to the same saved link without changing historical fingerprints or dropping earlier pages", async kind => {
    const { base, original, returned } = fixture();
    const previous = Array.from({ length: 30 }, (_, index) => ({ movementId: `fictional-prior-return:${index}`, sourceFingerprint: `saved-fingerprint:${index}`, principalMinor: 10 }));
    const storedOriginal = { movementId: original.id, sourceFingerprint: "saved-original-fingerprint" };
    api.request.mockResolvedValue({ ...base, page: { section: "settlement-plan", page: 0, pageSize: 25, total: 1, rows: [{ existing: { id: "fictional-existing-link", kind, original: storedOriginal, returns: previous }, usedPrincipalMinor: 300 }] } });
    const run = vi.fn(async () => true);
    const screen = new Screen(() => ReadSettlements({ base, run, busy: false, money: value => String(value) })).render();
    const type = nodes(screen.tree).find(row => row.type === Field && row.props.label === "Return type")!;
    (nodes(type.props.children as ReactNode)[0].props.onChange as (event: unknown) => void)({ target: { value: kind } });
    screen.render().choose("Original outgoing payment", original).choose("Incoming return", returned).amount("5.00");
    await screen.submit();
    expect(api.request).toHaveBeenCalledOnce();
    const params = api.request.mock.calls[0][0].query as URLSearchParams;
    expect(Object.fromEntries(params)).toMatchObject({ section: "settlement-plan", movementId: original.id, kind, expectedRevision: String(base.revision), expectedSourceVersion: base.sourceVersion });
    expect(run).toHaveBeenCalledWith([{ type: "save_settlement", settlement: { id: "fictional-existing-link", kind, original: storedOriginal, returns: [...previous, { movementId: returned.id, sourceFingerprint: returned.sourceFingerprint, principalMinor: 500 }] } }], expect.any(String), base.revision, base.sourceVersion);
  });
  it("does not write when a bound settlement plan fails or changes version", async () => {
    const { base, original, returned } = fixture(), run = vi.fn(); api.request.mockRejectedValue(new Error("Source evidence changed. Reload."));
    const screen = new Screen(() => ReadSettlements({ base, run, busy: false, money: String })).render().choose("Original outgoing payment", original).choose("Incoming return", returned).amount("1.00");
    await screen.submit(); expect(run).not.toHaveBeenCalled();
    expect(JSON.stringify(screen.tree)).toContain("Source evidence changed. Reload.");
  });
  it("prevents a double confirmation while the plan is pending", async () => {
    const { base, original, returned } = fixture(), run = vi.fn(); let resolve!: (value: unknown) => void;
    api.request.mockImplementation(() => new Promise(value => { resolve = value; }));
    const screen = new Screen(() => ReadSettlements({ base, run, busy: false, money: String })).render().choose("Original outgoing payment", original).choose("Incoming return", returned).amount("1.00");
    const pending = screen.submit(); await screen.submit(); expect(api.request).toHaveBeenCalledOnce();
    resolve({ ...base, page: { section: "settlement-plan", page: 0, pageSize: 25, total: 1, rows: [{ existing: null, usedPrincipalMinor: 0 }] } }); await pending;
    expect(run).toHaveBeenCalledOnce();
  });
});

describe("Accounts subscriptions bounded read outcomes", () => {
  it("surfaces rejected reads and owner changes", async () => {
    await expect(requestAccountSubscriptions(OWNER, async () => { throw new Error("Fictional offline"); })).rejects.toThrow("Fictional offline");
    await expect(requestAccountSubscriptions(OWNER, async () => ({ ok: false, text: "Fictional read failed" }))).rejects.toThrow("Fictional read failed");
    await expect(requestAccountSubscriptions(OWNER, async () => ({ ok: true, ownerId: "fictional-other", data: { bills: [], upcoming: [], suggestions: [], currency: "GHS", today: "2026-11-05" } }))).rejects.toThrow("signed-in account changed");
  });
  it("stops waiting for a hung read and never publishes its late response", async () => {
    vi.useFakeTimers(); let resolve!: (value: Awaited<ReturnType<typeof import("@/app/accounts/subscriptions-actions").loadAccountSubscriptionsView>>) => void;
    const read = vi.fn(() => new Promise<Awaited<ReturnType<typeof import("@/app/accounts/subscriptions-actions").loadAccountSubscriptionsView>>>(done => { resolve = done; }));
    const request = requestAccountSubscriptions(OWNER, read, 20), rejected = expect(request).rejects.toThrow("Subscriptions could not be loaded");
    await vi.advanceTimersByTimeAsync(20); await rejected;
    resolve({ ok: true, ownerId: OWNER, data: { bills: [], upcoming: [], suggestions: [], currency: "GHS", today: "2026-11-05" } });
    await vi.runAllTimersAsync(); expect(read).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
});
