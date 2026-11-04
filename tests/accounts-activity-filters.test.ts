import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountsWorkspace } from "@/app/accounts/accounts-workspace";
import { Button, Dialog } from "@/app/components/ui";
import { emptyAccountingState, type CashMovement } from "@/lib/finance/accounting/types";
type Setter<T> = (next: T | ((value: T) => T)) => void;
type HookState = { state<T>(initial: T | (() => T)): [T, Setter<T>] };
const hooks = vi.hoisted(() => ({ current: null as HookState | null }));
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  return { ...react,
    useState: <T>(initial: T | (() => T)) => hooks.current ? hooks.current.state(initial) : react.useState(initial),
    useEffect: () => undefined,
    useMemo: <T>(compute: () => T) => compute(),
    useSyncExternalStore: (_subscribe: unknown, _snapshot: unknown, serverSnapshot: () => unknown) => serverSnapshot(),
  };
});
vi.mock("@/app/components/app-shell", () => ({ usePrivacyMask: () => [false] }));
type Element = ReactElement<Record<string, unknown>>;
function nodes(node: ReactNode): Element[] { if (Array.isArray(node)) return node.flatMap(nodes); if (!isValidElement<Record<string, unknown>>(node)) return []; return [node, ...nodes(node.props.children as ReactNode)]; }
function text(node: ReactNode): string { if (typeof node === "string" || typeof node === "number") return String(node); if (Array.isArray(node)) return node.map(text).join(""); return isValidElement<Record<string, unknown>>(node) ? text(node.props.children as ReactNode) : ""; }
function sample() {
  const state = emptyAccountingState("fictional-owner");
  state.accounts = [{ id: "wallet", label: "Sample wallet", provider: "Fictional", currency: "GHS", includeInCash: true, createdAt: "2026-11-01T12:00:00Z" }];
  const row = (id: string, description: string, accountId: string | null, status: CashMovement["status"]): CashMovement => ({ id, ownerId: state.ownerId, accountId, direction: "out", status, amountMinor: 100, feeMinor: 0, currency: "GHS", date: "2026-11-01", occurredAt: "2026-11-01T12:00:00Z", description, category: "Other", sourceKind: "manual", sourceId: `source-${id}`, sourceFingerprint: `fingerprint-${id}`, legacyTransactionId: null, feeTransactionId: null, legacyClassification: null });
  state.movements = [row("market", "Market groceries", "wallet", "confirmed"), row("review", "Sample bus fare", null, "review")];
  return state;
}
class Screen implements HookState {
  private values: unknown[] = []; private index = 0;
  readonly source = sample(); value!: ReactNode;
  state<T>(initial: T | (() => T)): [T, Setter<T>] { const index = this.index++; if (!(index in this.values)) this.values[index] = typeof initial === "function" ? (initial as () => T)() : initial; return [this.values[index] as T, next => { this.values[index] = typeof next === "function" ? (next as (old: T) => T)(this.values[index] as T) : next; }]; }
  render() { this.index = 0; hooks.current = this; try { this.value = AccountsWorkspace({ state: this.source, mode: "live", dispatch: vi.fn() }); } finally { hooks.current = null; } return this; }
  get sheet() { return nodes(this.value).find(node => node.type === Dialog && node.props.title === "Filter activity")!; }
  get filters() { return nodes(this.value).find(node => node.type === Button && String(node.props["aria-label"] ?? "").startsWith("Filters"))!; }
  get rows() { return nodes(this.value).find(node => typeof node.type === "function" && node.type.name === "MovementList")!.props.rows as CashMovement[]; }
  open() { (this.filters.props.onClick as () => void)(); return this.render(); }
  field(label: string) { const field = nodes(this.sheet).find(node => node.props.label === label)!; return nodes(field.props.children as ReactNode)[0]; }
  change(label: string, value: string) { (this.field(label).props.onChange as (event: { target: { value: string } }) => void)({ target: { value } }); return this.render(); }
  apply() { const form = nodes(this.sheet).find(node => node.type === "form")!; (form.props.onSubmit as (event: { preventDefault(): void }) => void)({ preventDefault: vi.fn() }); return this.render(); }
  close() { (this.sheet.props.onClose as () => void)(); return this.render(); }
  reset() { const reset = nodes(this.sheet).find(node => node.type === Button && text(node.props.children as ReactNode) === "Reset filters")!; (reset.props.onClick as () => void)(); return this.render(); }
}
afterEach(() => { hooks.current = null; vi.unstubAllGlobals(); });
describe("Activity filter bottom sheet", () => {
  it("opens from the Activity header without applying draft edits", () => {
    const screen = new Screen().render(); expect(screen.sheet.props.open).toBe(false); expect(screen.filters.props["aria-haspopup"]).toBe("dialog");
    screen.open().change("Search", "Market").change("Account", "wallet").change("Status", "confirmed");
    expect(screen.sheet.props.open).toBe(true); expect(screen.rows).toHaveLength(2); expect(screen.filters.props["aria-label"]).toBe("Filters");
    screen.apply(); expect(screen.sheet.props.open).toBe(false); expect(screen.rows.map(row => row.id)).toEqual(["market"]); expect(screen.filters.props["aria-label"]).toBe("Filters, 3 active");
  });
  it("discards a cancelled draft and reopens with the last applied values", () => {
    const screen = new Screen().render().open().change("Status", "review").apply(); expect(screen.rows.map(row => row.id)).toEqual(["review"]);
    screen.open().change("Search", "Market").change("Status", "confirmed").close(); expect(screen.rows.map(row => row.id)).toEqual(["review"]);
    screen.open(); expect(screen.field("Search").props.value).toBe(""); expect(screen.field("Status").props.value).toBe("review");
  });
  it("resets the draft and restores all records only after Apply", () => {
    const screen = new Screen().render().open().change("Account", "wallet").apply(); expect(screen.rows).toHaveLength(1);
    screen.open().reset(); expect(screen.rows).toHaveLength(1); expect(screen.field("Account").props.value).toBe("");
    screen.apply(); expect(screen.rows).toHaveLength(2); expect(screen.filters.props["aria-label"]).toBe("Filters");
  });
  it("retains unassigned matching and trims the applied search without changing source records", () => {
    const screen = new Screen().render(), before = structuredClone(screen.source);
    screen.open().change("Search", "  BUS  ").change("Account", "unassigned").apply();
    expect(screen.rows.map(row => row.id)).toEqual(["review"]); expect(screen.source).toEqual(before);
    screen.open(); expect(screen.field("Search").props.value).toBe("BUS");
  });
  it("reflects the existing View movements account filter when reopening the sheet", () => {
    vi.stubGlobal("window", { location: { href: "https://example.invalid/accounts", pathname: "/accounts", search: "", hash: "" }, history: { state: null, pushState: vi.fn() } });
    const screen = new Screen().render(); const view = nodes(screen.value).find(node => node.type === "button" && text(node.props.children as ReactNode).startsWith("View movements"))!;
    (view.props.onClick as () => void)(); screen.render().open(); expect(screen.field("Account").props.value).toBe("wallet"); expect(screen.filters.props["aria-label"]).toBe("Filters, 1 active");
  });
});
