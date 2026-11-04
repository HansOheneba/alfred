import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountWorkspaceHref, resolveAccountWorkspaceTab } from "@/app/accounts/accounts-workspace";
import { SettingsView } from "@/app/settings/settings-view";
import { SettingsNavigation } from "@/app/settings/settings-navigation";
import type { AccountSettings } from "@/lib/accounts/settings-store";

type Setter<T> = (next: T | ((value: T) => T)) => void;
type Dispatch = { state<T>(initial: T | (() => T)): [T, Setter<T>]; effect(callback: () => void | (() => void), dependencies?: readonly unknown[]): void };
const runtime = vi.hoisted(() => ({ current: null as Dispatch | null }));
vi.mock("react", async load => {
  const react = await load<typeof import("react")>();
  return { ...react, useState: <T>(initial: T | (() => T)) => runtime.current ? runtime.current.state(initial) : react.useState(initial), useEffect: (callback: () => void | (() => void), dependencies?: readonly unknown[]) => runtime.current ? runtime.current.effect(callback, dependencies) : react.useEffect(callback, dependencies) };
});
vi.mock("@/app/settings/lazy-settings-data", () => ({ useOwnedSettingsData: () => ({ value: undefined, refreshing: false, retry: () => undefined }) }));

const initial: AccountSettings = { preferredName: "Fictional", currency: "GHS", timezone: "Africa/Accra", communicationPreference: "concise", financialGoals: "", telegramUserId: "", telegramLocked: false, morningEnabled: false, commuteEnabled: false, eveningEnabled: false, morningTime: "08:00", commuteTime: "09:00", eveningTime: "19:00" };
type Element = ReactElement<Record<string, unknown>>;
function nodes(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...nodes(node.props.children as ReactNode)];
}
function text(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(text).join("");
  return isValidElement<Record<string, unknown>>(node) ? text(node.props.children as ReactNode) : "";
}
class SettingsLifecycle implements Dispatch {
  private values: unknown[] = [];
  private effects: { dependencies?: readonly unknown[]; cleanup?: () => void }[] = [];
  private stateIndex = 0; private effectIndex = 0; private pending: (() => void)[] = [];
  value!: ReactNode;
  state<T>(initialValue: T | (() => T)): [T, Setter<T>] { const i = this.stateIndex++; if (!(i in this.values)) this.values[i] = typeof initialValue === "function" ? (initialValue as () => T)() : initialValue; return [this.values[i] as T, next => { this.values[i] = typeof next === "function" ? (next as (old: T) => T)(this.values[i] as T) : next; }]; }
  effect(callback: () => void | (() => void), dependencies?: readonly unknown[]) { const i = this.effectIndex++, old = this.effects[i]; if (old && dependencies && old.dependencies?.length === dependencies.length && dependencies.every((x, n) => Object.is(x, old.dependencies![n]))) return; this.pending.push(() => { old?.cleanup?.(); const cleanup = callback(); this.effects[i] = { dependencies, cleanup: typeof cleanup === "function" ? cleanup : undefined }; }); }
  render() { this.stateIndex = 0; this.effectIndex = 0; runtime.current = this; try { this.value = SettingsView({ initial, home: "chat" }); } finally { runtime.current = null; } for (const callback of this.pending.splice(0)) callback(); return this; }
  unmount() { for (const item of this.effects) item?.cleanup?.(); }
  get navigation() { return nodes(this.value).find(node => node.type === SettingsNavigation)!; }
  choose(section: string) { (this.navigation.props.onChoose as (id: string) => void)(section); this.render(); }
  get root() { return nodes(this.value)[0]; }
}
let location: { pathname: string; search: string; hash: string };
let listeners: Map<string, Set<() => void>>;
const mounted: SettingsLifecycle[] = [];
function screen(hash = "") { location.hash = hash; const value = new SettingsLifecycle(); mounted.push(value); return value.render().render(); }
beforeEach(() => {
  location = { pathname: "/settings", search: "", hash: "" }; listeners = new Map();
  const navigate = (_state: unknown, _title: string, href: string) => { const url = new URL(href, `https://example.invalid${location.pathname}${location.search}${location.hash}`); location.pathname = url.pathname; location.search = url.search; location.hash = url.hash; };
  vi.stubGlobal("window", { location, history: { state: { existing: true }, pushState: vi.fn(navigate), replaceState: vi.fn(navigate) }, addEventListener: (name: string, callback: () => void) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(callback); }, removeEventListener: (name: string, callback: () => void) => listeners.get(name)?.delete(callback) });
});
afterEach(() => { for (const value of mounted.splice(0)) value.unmount(); runtime.current = null; vi.unstubAllGlobals(); });

describe("mobile Settings section navigation", () => {
  it("starts with the section list and opens a chosen section through its existing hash", () => {
    const view = screen(); expect(view.root.props["data-mobile-section-open"]).toBe(false);
    view.choose("automations"); expect(location.hash).toBe("#automations"); expect(view.navigation.props.section).toBe("automations"); expect(view.root.props["data-mobile-section-open"]).toBe(true);
    expect(window.history.pushState).toHaveBeenCalledTimes(1);
  });
  it.each(["#data", "#bank", "#notifications", "#automations-notifications"])("opens a direct %s link without hiding it behind the section list", hash => {
    const view = screen(hash); expect(view.root.props["data-mobile-section-open"]).toBe(true); expect(view.navigation.props.section).toBe(hash.includes("notifications") ? "automations" : hash.slice(1));
  });
  it("supports browser Back to the section list and Forward to the selected section", () => {
    const view = screen(); view.choose("bank"); location.hash = ""; for (const callback of listeners.get("popstate") ?? []) callback(); view.render(); expect(view.root.props["data-mobile-section-open"]).toBe(false);
    location.hash = "#bank"; for (const callback of listeners.get("popstate") ?? []) callback(); view.render(); expect(view.root.props["data-mobile-section-open"]).toBe(true); expect(view.navigation.props.section).toBe("bank");
  });
  it("keeps a typed profile draft while returning to the list or another section", () => {
    const view = screen("#profile"); const input = nodes(view.value).find(node => node.type === "input" && node.props.autoComplete === "nickname")!;
    (input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "Unsaved fictional name" } }); view.render();
    const back = nodes(view.value).find(node => text(node.props.children as ReactNode) === "Back to settings")!; (back.props.onClick as () => void)(); view.render(); expect(location.hash).toBe(""); expect(view.root.props["data-mobile-section-open"]).toBe(false);
    view.choose("automations"); view.choose("profile"); expect(nodes(view.value).find(node => node.type === "input" && node.props.autoComplete === "nickname")?.props.value).toBe("Unsaved fictional name");
  });
  it("names the shared detail panel for the selected section on desktop and mobile", () => {
    const view = screen("#profile");
    const region = () => nodes(view.value).find(node => node.props.id === "alfred-settings-detail")!;
    expect(region().props.role).toBe("region");
    expect(region().props["aria-label"]).toBe("Profile");
    expect(nodes(view.value).find(node => node.props.className === "alfred-settings-context")?.props.children).toBe("Your name, currency and preferences");
    view.choose("goals");
    expect(region().props["aria-label"]).toBe("Savings goals");
    expect(nodes(view.value).find(node => node.props.className === "alfred-settings-context")?.props.children).toBe("What you’re saving towards");
    expect(location.hash).toBe("#goals");
    location.hash = "#profile"; for (const callback of listeners.get("popstate") ?? []) callback(); view.render();
    expect(region().props["aria-label"]).toBe("Profile");
  });
});

describe("Accounts section destinations", () => {
  it.each(["activity", "settlements", "subscriptions", "needs-attention"] as const)("retains the %s destination and other query context", tab => {
    const href = accountWorkspaceHref("https://example.invalid/accounts?payment=fictional&tab=accounts#source", tab); const url = new URL(href, "https://example.invalid"); expect(url.pathname).toBe("/accounts"); expect(url.searchParams.get("tab")).toBe(tab); expect(url.searchParams.get("payment")).toBe("fictional"); expect(url.hash).toBe("#source"); expect(resolveAccountWorkspaceTab(tab)).toBe(tab);
  });
  it("returns to Accounts without losing other query context and safely defaults unknown tabs", () => {
    expect(accountWorkspaceHref("/accounts?tab=activity&payment=fictional", "accounts")).toBe("/accounts?payment=fictional");
    for (const value of [null, "", "unknown", "ACTIVITY"]) expect(resolveAccountWorkspaceTab(value)).toBe("accounts");
  });
});
