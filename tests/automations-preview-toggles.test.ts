import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationsSection, EMPTY_NOTIFICATION_PREFERENCES, type NotificationSettingsData } from "@/app/settings/notifications-section";
import { AutomationsSettingsPreview } from "@/app/preview/automations/preview";
import { AutomationsSection } from "@/app/settings/automations-section";
import { SettingsNavigation } from "@/app/settings/settings-navigation";

type Setter<T> = (next: T | ((previous: T) => T)) => void;
type Dispatcher = {
  state<T>(initial: T | (() => T)): [T, Setter<T>];
  effect(effect: () => void | (() => void), dependencies?: readonly unknown[]): void;
};
const runtime = vi.hoisted(() => ({ current: null as Dispatcher | null }));
vi.mock("react", async (load) => {
  const react = await load<typeof import("react")>();
  return {
    ...react,
    useState: <T>(initial: T | (() => T)) => runtime.current ? runtime.current.state(initial) : react.useState(initial),
    useEffect: (effect: () => void | (() => void), dependencies?: readonly unknown[]) => runtime.current ? runtime.current.effect(effect, dependencies) : react.useEffect(effect, dependencies),
  };
});

/** Execute the actual component's state, effects and click handlers without a
 * browser, permissions, network transport or extra rendering dependencies. */
class Lifecycle<Props> implements Dispatcher {
  private states: unknown[] = [];
  private effects: { dependencies?: readonly unknown[]; cleanup?: () => void }[] = [];
  private pending: (() => void)[] = [];
  private stateIndex = 0;
  private effectIndex = 0;
  private props!: Props;
  value!: ReactNode;
  constructor(private component: (props: Props) => ReactNode) {}
  state<T>(initial: T | (() => T)): [T, Setter<T>] {
    const index = this.stateIndex++;
    if (!(index in this.states)) this.states[index] = typeof initial === "function" ? (initial as () => T)() : initial;
    return [this.states[index] as T, (next) => { this.states[index] = typeof next === "function" ? (next as (previous: T) => T)(this.states[index] as T) : next; }];
  }
  effect(effect: () => void | (() => void), dependencies?: readonly unknown[]) {
    const index = this.effectIndex++, previous = this.effects[index];
    if (previous && dependencies && dependencies.length === previous.dependencies?.length && dependencies.every((value, position) => Object.is(value, previous.dependencies![position]))) return;
    this.pending.push(() => {
      previous?.cleanup?.();
      const cleanup = effect();
      this.effects[index] = { dependencies, cleanup: typeof cleanup === "function" ? cleanup : undefined };
    });
  }
  render(props: Props) {
    this.props = props; this.stateIndex = 0; this.effectIndex = 0;
    const previous = runtime.current; runtime.current = this;
    try { this.value = this.component(props); } finally { runtime.current = previous; }
    for (const commit of this.pending.splice(0)) commit();
    return this.value;
  }
  async settle() { await new Promise<void>((resolve) => setImmediate(resolve)); return this.render(this.props); }
  unmount() { for (const effect of this.effects) effect?.cleanup?.(); }
}
type Element = ReactElement<Record<string, unknown>>;
function descendants(node: ReactNode, resolveComponents = true): Element[] {
  if (Array.isArray(node)) return node.flatMap((item) => descendants(item, resolveComponents));
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  if (resolveComponents && typeof node.type === "function") return descendants((node.type as (props: Record<string, unknown>) => ReactNode)(node.props), resolveComponents);
  return [node, ...descendants(node.props.children as ReactNode, resolveComponents)];
}
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (!isValidElement<Record<string, unknown>>(node)) return "";
  return text(node.props.children as ReactNode);
}
function sample(): NotificationSettingsData {
  return { ownerId: "00000000-0000-4000-8000-000000000001", preferences: { ...EMPTY_NOTIFICATION_PREFERENCES }, push: { configured: false, publicKey: null, deliveryEnabled: false, schedulesEnabled: false, recoveryReady: false }, devices: [] };
}
const choiceIds = ["payment-mentions", "payment-push", "bill-reminders", "weekly-overview"];
const mounted: { unmount(): void }[] = [];
let fetcher: ReturnType<typeof vi.fn>, permission: ReturnType<typeof vi.fn>, register: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetcher = vi.fn(() => { throw new Error("Unexpected preview network"); });
  permission = vi.fn(() => { throw new Error("Unexpected preview permission"); });
  register = vi.fn(() => { throw new Error("Unexpected preview registration"); });
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("Notification", { requestPermission: permission });
  vi.stubGlobal("navigator", { serviceWorker: { register, getRegistration: register } });
});
afterEach(() => { for (const instance of mounted.splice(0)) instance.unmount(); runtime.current = null; vi.unstubAllGlobals(); });
function view() {
  const instance = new Lifecycle(NotificationsSection); mounted.push(instance);
  instance.render({ preview: true, initial: sample() });
  const nodes = () => descendants(instance.value);
  const choice = (id: string) => nodes().find((node) => node.props.role === "switch" && node.props["aria-labelledby"] === `${id}-title`)!;
  const button = (label: string) => nodes().find((node) => node.type === "button" && text(node.props.children as ReactNode) === label)!;
  const click = async (node: Element) => { expect(node.props.disabled).not.toBe(true); (node.props.onClick as () => void)(); await instance.settle(); };
  return { instance, choice, button, click, checked: () => choiceIds.map((id) => choice(id).props["aria-checked"]) };
}

describe("fictional Automations preview controls", () => {
  it.each(choiceIds)("independently toggles %s on and off while infrastructure remains unavailable", async (id) => {
    const screen = view();
    expect(screen.checked()).toEqual([false, false, false, false]);
    expect(screen.button("Save preview choices").props.disabled).toBe(true);
    await screen.click(screen.choice(id));
    expect(screen.checked()).toEqual(choiceIds.map((key) => key === id));
    expect(screen.button("Save preview choices").props.disabled).toBe(false);
    await screen.click(screen.choice(id));
    expect(screen.checked()).toEqual([false, false, false, false]);
    expect(screen.button("Save preview choices").props.disabled).toBe(true);
    expect(fetcher).not.toHaveBeenCalled(); expect(permission).not.toHaveBeenCalled(); expect(register).not.toHaveBeenCalled();
  });
  it("saves all four in memory, retains saved state through re-renders, and resets saved and draft choices", async () => {
    const screen = view();
    for (const id of choiceIds) await screen.click(screen.choice(id));
    await screen.click(screen.button("Save preview choices"));
    expect(screen.checked()).toEqual([true, true, true, true]);
    expect(screen.button("Save preview choices").props.disabled).toBe(true);
    expect(text(screen.instance.value)).toContain("No account settings were saved and nothing will be sent");
    await screen.instance.settle();
    expect(screen.checked()).toEqual([true, true, true, true]);
    await screen.click(screen.choice("payment-push"));
    expect(screen.button("Save preview choices").props.disabled).toBe(false);
    await screen.click(screen.button("Reset preview choices"));
    expect(screen.checked()).toEqual([false, false, false, false]);
    expect(screen.button("Save preview choices").props.disabled).toBe(true);
    expect(text(screen.instance.value)).toContain("Preview reset. All four choices are off");
    expect(fetcher).not.toHaveBeenCalled(); expect(permission).not.toHaveBeenCalled(); expect(register).not.toHaveBeenCalled();
    const freshVisit = view();
    expect(freshVisit.checked()).toEqual([false, false, false, false]);
  });
  it("keeps the same mounted Automations subtree while navigating away and back", async () => {
    vi.stubGlobal("window", { location: { hash: "" }, addEventListener: vi.fn(), removeEventListener: vi.fn(), history: { replaceState: vi.fn() } });
    vi.stubGlobal("document", { querySelector: vi.fn(() => null) });
    const screen = new Lifecycle(AutomationsSettingsPreview); mounted.push(screen); screen.render({});
    function automationWrapper() {
      return descendants(screen.value, false).find((node) => (Array.isArray(node.props.children) ? node.props.children : [node.props.children]).some((child) => isValidElement(child) && child.type === AutomationsSection))!;
    }
    const first = automationWrapper();
    expect(first.props.hidden).toBe(false);
    const navigation = () => descendants(screen.value, false).find((node) => node.type === SettingsNavigation)!;
    (navigation().props.onChoose as (id: string) => void)("profile"); await screen.settle();
    const away = automationWrapper();
    expect(away.type).toBe(first.type); expect(away.key).toBe(first.key); expect(away.props.hidden).toBe(true);
    (navigation().props.onChoose as (id: string) => void)("automations"); await screen.settle();
    expect(automationWrapper().props.hidden).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("production boundaries and responsive preview markup", () => {
  it.each([{}, { configured: true }, { configured: true, deliveryEnabled: true }, { configured: true, deliveryEnabled: true, recoveryReady: false }])("keeps new production device choices disabled when readiness is incomplete: %j", (push) => {
    const initial = sample(); initial.push = { ...initial.push, ...push };
    const html = renderToStaticMarkup(createElement(NotificationsSection, { initial, ownerId: initial.ownerId }));
    const switches = html.match(/<button[^>]*role="switch"[^>]*>/g)!;
    expect(switches).toHaveLength(4); expect(switches[0]).not.toMatch(/\sdisabled(?:=|\s|>)/);
    expect(switches.slice(1).every((button) => /\sdisabled(?:=|\s|>)/.test(button))).toBe(true);
    expect(html).not.toContain("Reset preview choices"); expect(html).not.toContain("Save preview choices");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("still allows existing production device choices to be turned off without recovery", () => {
    const initial = sample(); initial.preferences = { ...initial.preferences, paymentPush: true, billReminders: true, weeklyOverview: true };
    const html = renderToStaticMarkup(createElement(NotificationsSection, { initial }));
    expect(html.match(/<button[^>]*role="switch"[^>]*>/g)!.some((button) => /\sdisabled(?:=|\s|>)/.test(button))).toBe(false);
  });
  it("renders four operable demo switches with touch targets and wrapping mobile/desktop layout", () => {
    const html = renderToStaticMarkup(createElement(AutomationsSettingsPreview));
    const switches = html.match(/<button[^>]*role="switch"[^>]*>/g)!;
    expect(switches).toHaveLength(4); expect(switches.every((button) => !/\sdisabled(?:=|\s|>)/.test(button) && /min-h-11 min-w-11 shrink-0/.test(button))).toBe(true);
    expect(html).toContain("flex flex-col gap-6 md:flex-row md:items-start");
    expect(html).toContain("min-w-0 flex-1"); expect(html).toContain("flex flex-wrap items-center justify-end gap-3");
    expect(html).toContain("w-full sm:w-64"); expect(html).toContain("reset when you reload");
    expect(html).toContain("Push delivery is currently off");
    expect(html).not.toContain("Scheduled recovery has recently checked in");
    expect(fetcher).not.toHaveBeenCalled(); expect(permission).not.toHaveBeenCalled(); expect(register).not.toHaveBeenCalled();
  });
});
