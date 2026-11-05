import { isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountsReadClient, useAccountsPanel } from "@/app/accounts/accounts-read-client";
import { AccountsViewRequestError } from "@/app/accounts/read-request";
import { Button } from "@/app/components/ui";
import { Field, MovementList } from "@/app/accounts/accounts-workspace";
import { Select } from "@/app/components/select";
import { projectAccountsReadView, type AccountsReadView } from "@/lib/finance/accounting/read-view";
import { applyAccountingAction } from "@/lib/finance/accounting/reducer";
import { emptyAccountingState, type AccountingAction, type AccountingState } from "@/lib/finance/accounting/types";
import type { AccountCommand } from "@/app/accounts/activity-tools";

type Setter<T> = (next: T | ((old: T) => T)) => void;
type Element = ReactElement<Record<string, unknown>>;
type Run = (commands: AccountCommand[], message: string, revision?: number, sourceVersion?: string | null) => Promise<boolean>;
const runtime = vi.hoisted(() => ({ current: null as { state<T>(initial: T | (() => T)): [T, Setter<T>]; ref<T>(initial: T): { current: T }; effect(callback: EffectCallback, dependencies?: readonly unknown[]): void } | null }));
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/app/accounts/read-request", async load => ({ ...await load<typeof import("@/app/accounts/read-request")>(), requestAccountsView: mocks.request }));
vi.mock("@/app/components/app-shell", () => ({ usePrivacyMask: () => [false] }));
vi.mock("@/app/components/category-catalog", () => ({ useCustomCategories: () => [] }));
vi.mock("react", async load => {
  const react = await load<typeof import("react")>();
  return { ...react,
    useState: <T>(initial: T | (() => T)) => runtime.current ? runtime.current.state(initial) : react.useState(initial),
    useRef: <T>(initial: T) => runtime.current ? runtime.current.ref(initial) : react.useRef(initial),
    useEffect: (callback: EffectCallback, dependencies?: readonly unknown[]) => { runtime.current?.effect(callback, dependencies); },
  };
});
function nodes(value: ReactNode): Element[] { return Array.isArray(value) ? value.flatMap(nodes) : isValidElement<Record<string, unknown>>(value) ? [value, ...nodes(value.props.children as ReactNode)] : []; }
function text(value: ReactNode): string { return typeof value === "string" || typeof value === "number" ? String(value) : Array.isArray(value) ? value.map(text).join("") : isValidElement<Record<string, unknown>>(value) ? text(value.props.children as ReactNode) : ""; }
class Screen {
  private values: unknown[] = []; private cursor = 0; private effects = new Map<number, { dependencies?: readonly unknown[]; cleanup?: () => void }>();
  private pending: (() => void)[] = []; tree!: ReactNode;
  constructor(private component: () => ReactNode, private runEffects = false) {}
  state<T>(initial: T | (() => T)): [T, Setter<T>] {
    const index = this.cursor++; if (!(index in this.values)) this.values[index] = typeof initial === "function" ? (initial as () => T)() : initial;
    return [this.values[index] as T, next => { this.values[index] = typeof next === "function" ? (next as (old: T) => T)(this.values[index] as T) : next; }];
  }
  ref<T>(initial: T) { const index = this.cursor++; if (!(index in this.values)) this.values[index] = { current: initial }; return this.values[index] as { current: T }; }
  effect(callback: EffectCallback, dependencies?: readonly unknown[]) {
    const index = this.cursor++, previous = this.effects.get(index);
    if (!this.runEffects || previous && dependencies && previous.dependencies && dependencies.length === previous.dependencies.length && dependencies.every((value, item) => Object.is(value, previous.dependencies![item]))) return;
    this.pending.push(() => { previous?.cleanup?.(); const cleanup = callback(); this.effects.set(index, { dependencies, ...(typeof cleanup === "function" ? { cleanup } : {}) }); });
  }
  render() { this.cursor = 0; runtime.current = this; try { this.tree = this.component(); } finally { runtime.current = null; } const pending = this.pending; this.pending = []; pending.forEach(effect => effect()); return this; }
  componentNamed(name: string) { const found = nodes(this.tree).find(node => typeof node.type === "function" && node.type.name === name); if (!found) throw new Error(`Missing ${name}`); return found; }
  componentOf(type: unknown) { const found = nodes(this.tree).find(node => node.type === type); if (!found) throw new Error("Missing component"); return found; }
  button(label: string) { return nodes(this.tree).find(node => node.type === Button && text(node.props.children as ReactNode).trim() === label); }
  click(label: string) { const button = this.button(label); if (!button) throw new Error(`Missing button ${label}`); (button.props.onClick as () => void)(); return this.render(); }
  openMovement() { const list = this.componentOf(MovementList); const first = (list.props.rows as { id: string }[])[0]; (list.props.open as (id: string) => void)(first.id); return this.render().componentNamed("ReadMovementEditor"); }
  get run() { return this.openMovement().props.run as Run; }
  get currentView() { return this.componentNamed("ReadTransfers").props.base as AccountsReadView; }
  unmount() { this.effects.forEach(effect => effect.cleanup?.()); }
}
const OWNER = "fictional-client-owner", AT = "2026-11-05T12:00:00.000Z", SOURCE = "fictional-source:0";
function fixture(): AccountingState {
  const state = emptyAccountingState(OWNER);
  state.accounts = [{ id: "fictional-cash", label: "Fictional cash", provider: "Fictional", currency: "GHS", includeInCash: true, createdAt: AT }];
  state.movements = [0, 1].map(index => ({ id: `fictional-movement:${index}`, ownerId: OWNER, accountId: null, direction: "out", status: "review", amountMinor: 100, feeMinor: 0, currency: "GHS", date: "2026-11-05", occurredAt: AT,
    description: `Fictional payment ${index}`, category: "Other", sourceId: `fictional-source:${index}`, sourceKind: "manual", sourceFingerprint: `fictional-fingerprint:${index}`, legacyTransactionId: null, feeTransactionId: null, legacyClassification: null }));
  return state;
}
function display(state: AccountingState, sourceVersion = SOURCE): AccountsReadView { return projectAccountsReadView({ state, availability: "ready", sourceVersion, rawTransactions: [] }, { currency: "GHS", section: "activity", page: 0 }); }
function screen(initial = display(fixture())) { return new Screen(() => AccountsReadClient({ initialView: initial, expectedOwnerId: OWNER, defaultCurrency: "GHS" })).render(); }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function flush() { for (let index = 0; index < 8; index += 1) await Promise.resolve(); }
const reference = { movementId: "fictional-movement:0", sourceFingerprint: "fictional-fingerprint:0" };
const commands: AccountCommand[] = [{ type: "assign_movement", movement: reference, accountId: "fictional-cash" }, { type: "classify_movement", movement: reference, category: "Food", status: "confirmed" }];
beforeEach(() => {
  mocks.request.mockReset();
  vi.stubGlobal("window", { location: { href: "https://alfred.invalid/accounts", search: "", reload: vi.fn() }, history: { pushState: vi.fn() }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(() => { runtime.current = null; vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("Accounts read client confirmed mutations", () => {
  it("executes reviewed commands sequentially using each acknowledged revision and original source fingerprints", async () => {
    let state = fixture();
    mocks.request.mockImplementation(async ({ action }: { action: AccountingAction }) => { state = applyAccountingAction(state, action, AT); return display(state); });
    const root = screen(), run = root.run;
    await expect(run(commands, "Fictional changes saved.", 0, SOURCE)).resolves.toBe(true);
    root.render();
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(mocks.request.mock.calls.map(([input]) => input.action.expectedRevision)).toEqual([0, 1]);
    expect(mocks.request.mock.calls.map(([input]) => input.action.movement)).toEqual([reference, reference]);
    expect(mocks.request.mock.calls[0][0].action.requestId).not.toBe(mocks.request.mock.calls[1][0].action.requestId);
    expect(root.currentView.revision).toBe(2);
    expect((root.componentOf(MovementList).props.rows as { id: string; category: string }[]).find(row => row.id === reference.movementId)?.category).toBe("Food");
    expect(root.button("Undo this change")).toBeDefined();
  });

  it("does not offer a scoped Undo receipt after executing an undo batch", async () => {
    let state = applyAccountingAction(fixture(), { ...commands[0], expectedRevision: 0, requestId: "fictional-before" } as AccountingAction, AT);
    mocks.request.mockImplementation(async ({ action }: { action: AccountingAction }) => { state = applyAccountingAction(state, action, AT); return display(state); });
    const root = screen(display(state));
    await expect(root.run([{ type: "undo" }], "Fictional undo saved.", 1, SOURCE)).resolves.toBe(true); root.render();
    expect(root.currentView.revision).toBe(2); expect(root.button("Undo this change")).toBeUndefined();
    expect(text(root.tree)).toContain("Fictional undo saved.");
  });

  it("refuses empty batches without sending a write or claiming a saved change", async () => {
    const root = screen();
    await expect(root.run([], "Fictional false success.")).resolves.toBe(false); root.render();
    expect(mocks.request).not.toHaveBeenCalled(); expect(root.button("Undo this change")).toBeUndefined();
    expect(text(root.tree)).toContain("Change a selected payment before confirming"); expect(text(root.tree)).not.toContain("Fictional false success.");
  });
});

describe("Accounts read client stale-view fences", () => {
  it("hides previous financial facts and blocks held commands while the durable model is updating", async () => {
    mocks.request.mockRejectedValueOnce(new AccountsViewRequestError("Alfred is updating your financial view.", 202));
    const root = screen(), oldRun = root.run;
    (root.componentNamed("Pager").props.onPage as (page: number) => void)(1); await flush(); root.render();
    expect(text(root.tree)).not.toContain("Total account balance");
    expect(root.componentNamed("AccountsErrorState").props).toMatchObject({ title: "Updating account records", retryLabel: "Check latest records" });
    await expect(oldRun([commands[0]], "Fictional unsafe edit.")).resolves.toBe(false);
    expect(mocks.request).toHaveBeenCalledOnce();
    mocks.request.mockResolvedValueOnce(display(fixture(), "fictional-source:ready"));
    (root.componentNamed("AccountsErrorState").props.onRetry as () => void)(); await flush(); root.render();
    expect(root.currentView.sourceVersion).toBe("fictional-source:ready");
    expect(new URLSearchParams(mocks.request.mock.calls[1][0].query).has("expectedRevision")).toBe(false);
  });

  it("does not start a main-page GET while a command is being saved", async () => {
    const pending = deferred<AccountsReadView>(); mocks.request.mockReturnValue(pending.promise);
    const root = screen(), run = root.run, pager = root.componentNamed("Pager");
    const saving = run([commands[0]], "Fictional save.");
    (pager.props.onPage as (page: number) => void)(1); await flush();
    expect(mocks.request).toHaveBeenCalledOnce(); expect(mocks.request.mock.calls[0][0].method).toBe("POST");
    pending.resolve(display(applyAccountingAction(fixture(), mocks.request.mock.calls[0][0].action, AT))); await saving; root.render();
    expect(root.currentView.revision).toBe(1);
  });

  it("does not let an old command handler save while a main read is pending", async () => {
    const pending = deferred<AccountsReadView>(); mocks.request.mockReturnValue(pending.promise);
    const root = screen(), oldRun = root.run;
    (root.componentNamed("Pager").props.onPage as (page: number) => void)(1);
    await expect(oldRun([commands[0]], "Fictional stale save.")).resolves.toBe(false);
    expect(mocks.request).toHaveBeenCalledOnce(); expect(mocks.request.mock.calls[0][0].method).toBeUndefined();
    pending.resolve(display(fixture())); await flush(); root.render();
  });

  it("reloads after a409 and keeps a held old handler blocked when that reload fails", async () => {
    mocks.request.mockRejectedValueOnce(new AccountsViewRequestError("Fictional records changed.", 409)).mockRejectedValueOnce(new Error("Fictional fresh read failed."));
    const root = screen(), oldRun = root.run;
    await expect(oldRun([commands[0]], "Fictional save.")).resolves.toBe(false); await flush(); root.render();
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(mocks.request.mock.calls.map(([input]) => input.method ?? "GET")).toEqual(["POST", "GET"]);
    expect(new URLSearchParams(mocks.request.mock.calls[1][0].query).has("expectedRevision")).toBe(false);
    await expect(oldRun([commands[0]], "Fictional stale retry.")).resolves.toBe(false);
    expect(mocks.request).toHaveBeenCalledTimes(2); expect(text(root.tree)).toContain("Fictional fresh read failed.");
  });

  it("rejects a review after sources change even when its accounting revision is unchanged", async () => {
    const changed = display(fixture(), "fictional-source:1"); mocks.request.mockResolvedValueOnce(changed);
    const root = screen(), oldRun = root.run;
    (root.componentNamed("Pager").props.onPage as (page: number) => void)(0); await flush(); root.render();
    expect(root.currentView.revision).toBe(0); expect(root.currentView.sourceVersion).toBe(changed.sourceVersion);
    await expect(oldRun([commands[0]], "Fictional stale review.", 0, SOURCE)).resolves.toBe(false); root.render();
    expect(mocks.request).toHaveBeenCalledOnce(); expect(text(root.tree)).toContain("Records changed after this review");
  });

  it("does not open a late payment-detail response after a newer confirmed write", async () => {
    const pending = deferred<AccountsReadView>(); let state = fixture();
    mocks.request.mockImplementation(({ method, action }: { method?: string; action?: AccountingAction }) => {
      if (method !== "POST") return pending.promise;
      state = applyAccountingAction(state, action!, AT); return Promise.resolve(display(state));
    });
    const root = screen(), editor = root.openMovement(), oldRun = editor.props.run as Run;
    (editor.props.next as (id: string) => void)("fictional-movement:1");
    await oldRun([commands[0]], "Fictional saved."); root.render();
    const stale = projectAccountsReadView({ state: fixture(), availability: "ready", sourceVersion: SOURCE, rawTransactions: [] }, { currency: "GHS", section: "movement", page: 0, movementId: "fictional-movement:1" });
    pending.resolve(stale); await flush(); root.render();
    expect(root.currentView.revision).toBe(1);
    expect(nodes(root.tree).some(node => typeof node.type === "function" && node.type.name === "ReadMovementEditor")).toBe(false);
  });
});

describe("Accounts detail navigation", () => {
  it("Save & next requests the next payment using the latest acknowledged cursor", async () => {
    let state = fixture();
    mocks.request.mockImplementation(async ({ method, action, query }: { method?: string; action?: AccountingAction; query: URLSearchParams }) => {
      if (method === "POST") { state = applyAccountingAction(state, action!, AT); return display(state); }
      return projectAccountsReadView({ state, availability: "ready", sourceVersion: SOURCE, rawTransactions: [] }, { currency: "GHS", section: "movement", page: 0, movementId: query.get("movementId")! });
    });
    const root = screen(), editor = root.openMovement();
    const child = new Screen(() => (editor.type as (props: Record<string, unknown>) => ReactNode)(editor.props)).render();
    const field = nodes(child.tree).find(node => node.type === Field && node.props.label === "Assigned account")!;
    const select = nodes(field.props.children as ReactNode).find(node => node.type === Select)!;
    (select.props.onChange as (event: unknown) => void)({ target: { value: "fictional-cash" } }); child.render();
    (nodes(child.tree).find(node => node.type === "form")!.props.onSubmit as (event: unknown) => void)({ preventDefault: vi.fn() }); child.render();
    child.click("Save & next"); await flush(); root.render();
    expect(mocks.request.mock.calls.map(([input]) => input.method ?? "GET")).toEqual(["POST", "POST", "GET"]);
    const next = mocks.request.mock.calls[2][0];
    expect(new URLSearchParams(next.query).get("expectedRevision")).toBe("2");
    expect(new URLSearchParams(next.query).get("expectedSourceVersion")).toBe(SOURCE);
    expect(root.componentNamed("ReadMovementEditor").props.base).toMatchObject({ revision: 2 });
    expect(root.componentNamed("ReadMovementEditor").props.movement).toMatchObject({ id: "fictional-movement:1" });
  });

  it.each(["owner", "source"])("discards an obsolete disclosure response when its %s key changes", async changed => {
    const first = deferred<AccountsReadView>(), second = deferred<AccountsReadView>(); mocks.request.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    let base = display(fixture()), panel!: ReturnType<typeof useAccountsPanel>;
    const hook = new Screen(() => { panel = useAccountsPanel(base, { section: "activity" }); return null; }, true).render();
    const next = fixture();
    if (changed === "owner") { next.ownerId = "fictional-next-owner"; next.movements = next.movements.map(row => ({ ...row, ownerId: next.ownerId })); }
    base = display(next, changed === "source" ? "fictional-source:1" : SOURCE); hook.render();
    second.resolve(base); await flush(); hook.render(); expect(panel.view).toMatchObject({ ownerId: base.ownerId, sourceVersion: base.sourceVersion });
    first.resolve(display(fixture())); await flush(); hook.render();
    expect(panel.view).toMatchObject({ ownerId: base.ownerId, sourceVersion: base.sourceVersion }); hook.unmount();
  });
});
