import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationsSection, EMPTY_NOTIFICATION_PREFERENCES, type NotificationSettingsData } from "@/app/settings/notifications-section";
import { AutomationsSettingsPreview } from "@/app/preview/automations/preview";
import { AutomationsSection } from "@/app/settings/automations-section";
import { SettingsNavigation } from "@/app/settings/settings-navigation";
import { SmsAutomationPreview } from "@/app/preview/sms-automation/preview";
import { paymentMentionPreviewCopies } from "@/app/preview/sms-automation/fixtures";

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
    useReducer: <S, A>(reducer: (state: S, action: A) => S, initial: S) => {
      if (!runtime.current) return react.useReducer(reducer, initial);
      const [state, setState] = runtime.current.state(initial);
      return [state, (action: A) => setState(previous => reducer(previous, action))];
    },
    useRef: <T>(initial: T) => runtime.current ? runtime.current.state({ current: initial })[0] : react.useRef(initial),
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
  // This harness owns NotificationsSection's hook state. The separate message
  // preferences component has its own state and dedicated behavioral coverage.
  if (resolveComponents && typeof node.type === "function" && node.type.name !== "MessageNotificationSettings") return descendants((node.type as (props: Record<string, unknown>) => ReactNode)(node.props), resolveComponents);
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
const choiceIds = ["payment-mentions", "outgoing-mentions", "payment-push", "bill-reminders", "weekly-overview"];
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
function view(props: Parameters<typeof NotificationsSection>[0] = { preview: true, initial: sample() }) {
  const instance = new Lifecycle(NotificationsSection); mounted.push(instance);
  instance.render(props);
  const nodes = () => descendants(instance.value);
  const choice = (id: string) => nodes().find((node) => node.props.role === "switch" && node.props["aria-labelledby"] === `${id}-title`)!;
  const button = (label: string) => nodes().find((node) => node.type === "button" && text(node.props.children as ReactNode) === label)!;
  const click = async (node: Element) => { expect(node.props.disabled).not.toBe(true); (node.props.onClick as () => void)(); await instance.settle(); };
  return { instance, choice, button, click, checked: () => choiceIds.map((id) => choice(id)?.props["aria-checked"] ?? false) };
}

describe("fictional Automations preview controls", () => {
  it("changes sample lock-screen amount consent separately without enabling a device or calling a server", async () => {
    const screen = view();
    expect(screen.choice("payment-preview").props["aria-checked"]).toBe(false);
    await screen.click(screen.choice("payment-preview"));
    expect(screen.choice("payment-preview").props["aria-checked"]).toBe(true);
    expect(screen.checked()).toEqual([false,false,false,false,false]);
    expect(screen.button("Send test")).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();expect(permission).not.toHaveBeenCalled();expect(register).not.toHaveBeenCalled();
  });
  it.each(["payment-mentions", "outgoing-mentions", "bill-reminders", "weekly-overview"])("autosaves sample %s independently without a permission or account request", async (id) => {
    const screen = view();
    expect(screen.checked()).toEqual([false, false, false, false, false]);
    expect(screen.button("Save preview choices")).toBeUndefined();
    await screen.click(screen.choice(id));
    expect(screen.checked()).toEqual(choiceIds.map((key) => key === id));
    expect(text(screen.instance.value)).toContain("Sample choice updated");
    await screen.click(screen.choice(id));
    expect(screen.checked()).toEqual([false, false, false, false, false]);
    expect(fetcher).not.toHaveBeenCalled(); expect(permission).not.toHaveBeenCalled(); expect(register).not.toHaveBeenCalled();
  });
  it("enables only sample payment notifications in one action, supports a sample test, and resets the visit", async () => {
    const screen = view();
    await screen.click(screen.button("Enable notifications"));
    expect(screen.checked()).toEqual([false, false, true, false, false]);
    await screen.click(screen.button("Send test"));
    expect(text(screen.instance.value)).toContain("Sample test only. No notification was sent");
    for (const id of choiceIds.filter(id => id !== "payment-push")) await screen.click(screen.choice(id));
    expect(screen.checked()).toEqual([true, true, true, true, true]);
    await screen.instance.settle();
    expect(screen.checked()).toEqual([true, true, true, true, true]);
    await screen.click(screen.button("Reset sample choices"));
    expect(screen.checked()).toEqual([false, false, false, false, false]);
    expect(screen.button("Send test")).toBeUndefined();
    expect(text(screen.instance.value)).toContain("Sample choices reset");
    expect(fetcher).not.toHaveBeenCalled(); expect(permission).not.toHaveBeenCalled(); expect(register).not.toHaveBeenCalled();
    expect(view().checked()).toEqual([false, false, false, false, false]);
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

const deviceId = "00000000-0000-4000-8000-000000000002";
function production(options: { linked?: boolean; preferences?: Partial<NotificationSettingsData["preferences"]>; recoveryReady?: boolean } = {}) {
  const initial = sample();
  initial.push = { configured: true, publicKey: "A".repeat(87), deliveryEnabled: true, schedulesEnabled: true, recoveryReady: options.recoveryReady ?? true };
  initial.preferences = { ...initial.preferences, ...options.preferences };
  const subscription = { options: { applicationServerKey: new Uint8Array(65).buffer }, toJSON: () => ({ endpoint: "https://example.invalid/fictional-current-device" }), unsubscribe: vi.fn(async () => true) };
  const manager = { getSubscription: vi.fn(async () => options.linked ? subscription : null), subscribe: vi.fn(async () => subscription) };
  const browserRegister = vi.fn(async () => ({ pushManager: manager }));
  const getRegistration = vi.fn(async () => ({ pushManager: manager }));
  const ask = vi.fn(async () => "granted" as NotificationPermission);
  vi.stubGlobal("window", { isSecureContext: true, Notification: { requestPermission: ask }, PushManager: function PushManager() {} });
  vi.stubGlobal("Notification", { requestPermission: ask });
  vi.stubGlobal("navigator", { serviceWorker: { getRegistration, register: browserRegister, ready: Promise.resolve({ pushManager: manager }) } });
  let saved = structuredClone(initial.preferences);
  const responder = async (path: string, init?: RequestInit) => {
    if (path === "/api/notifications" && !init?.method) return Response.json({ ok: true, ...initial, preferences: saved });
    if (path === "/api/notifications" && init?.method === "PATCH") {
      const patch = JSON.parse(init.body as string); saved = { ...saved, ...patch };
      return Response.json({ ok: true, preferences: saved });
    }
    if (path.endsWith("/subscriptions/status")) return Response.json({ ok: true, ownerId: initial.ownerId, device: options.linked ? { id: deviceId } : null });
    if (path.endsWith("/subscriptions") && init?.method === "POST") return Response.json({ ok: true, deviceId });
    if (path.endsWith("/subscriptions") && init?.method === "DELETE") return Response.json({ ok: true });
    if (path.endsWith("/test")) return Response.json({ ok: true, status: "accepted" });
    throw new Error("Unexpected fictional request");
  };
  fetcher.mockImplementation(responder);
  return { initial, responder, subscription, manager, browserRegister, ask, saved: () => saved };
}

describe("acknowledged notification actions", () => {
  it("requires acknowledgment for lock-screen amount consent and preserves unrelated choices and cutoffs", async () => {
    const fixture = production({preferences:{paymentMentions:true,paymentMentionsSince:"2026-11-03T10:00:00Z",paymentPush:true,billReminders:true}});
    const screen=view({ownerId:fixture.initial.ownerId});await screen.instance.settle();
    let resolve!:(response:Response)=>void;
    const pending=new Promise<Response>(done=>{resolve=done;});
    fetcher.mockImplementation((path,init)=>(init as RequestInit|undefined)?.method==="PATCH"?pending:fixture.responder(path as string,init as RequestInit));
    (screen.choice("payment-preview").props.onClick as ()=>void)();await screen.instance.settle();
    expect(screen.choice("payment-preview").props["aria-checked"]).toBe(false);
    expect(screen.choice("payment-preview").props.disabled).toBe(true);
    resolve(Response.json({ok:false},{status:503}));await screen.instance.settle();
    expect(screen.choice("payment-preview").props["aria-checked"]).toBe(false);
    fetcher.mockImplementation(fixture.responder);
    await screen.click(screen.choice("payment-preview"));
    expect(screen.choice("payment-preview").props["aria-checked"]).toBe(true);
    expect(fixture.saved()).toMatchObject({paymentPreview:true,paymentMentions:true,paymentMentionsSince:"2026-11-03T10:00:00Z",paymentPush:true,billReminders:true});
    const change=fetcher.mock.calls.filter(([,init])=>(init as RequestInit|undefined)?.method==="PATCH").at(-1)!;
    expect(JSON.parse((change[1] as RequestInit).body as string)).toEqual({paymentPreview:true});
    expect((change[1] as RequestInit).headers).toMatchObject({"x-alfred-owner":fixture.initial.ownerId});
    expect(fixture.ask).not.toHaveBeenCalled();expect(fixture.browserRegister).not.toHaveBeenCalled();
  });
  it("discards stale in-flight amount consent after switching accounts",async()=>{
    const fixture=production();const screen=view({ownerId:fixture.initial.ownerId});await screen.instance.settle();
    const other="00000000-0000-4000-8000-000000000003";let resolve!:(response:Response)=>void;
    const pending=new Promise<Response>(done=>{resolve=done;});
    fetcher.mockImplementation((_path,init)=>(init as RequestInit|undefined)?.method==="PATCH"?pending:Promise.resolve(Response.json({ok:true,...fixture.initial,ownerId:other})));
    (screen.choice("payment-preview").props.onClick as ()=>void)();screen.instance.render({ownerId:other});await screen.instance.settle();
    resolve(Response.json({ok:true,preferences:{...fixture.initial.preferences,paymentPreview:true}}));await screen.instance.settle();
    expect(screen.choice("payment-preview").props["aria-checked"]).toBe(false);expect(text(screen.instance.value)).not.toContain("Saved.");
  });
  it("does not request permission, register, save or send a test when Settings opens", async () => {
    const fixture = production(); const screen = view({ ownerId: fixture.initial.ownerId }); await screen.instance.settle();
    expect(fixture.ask).not.toHaveBeenCalled(); expect(fixture.browserRegister).not.toHaveBeenCalled();
    expect(fetcher.mock.calls.every(([, init]) => !(init as RequestInit | undefined)?.method)).toBe(true);
    expect(screen.checked()).toEqual([false, false, false, false, false]);
  });
  it("waits for server acknowledgment, ignores double clicks, and keeps the confirmed choice after failure", async () => {
    const fixture = production(); const screen = view({ ownerId: fixture.initial.ownerId }); await screen.instance.settle();
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>(done => { resolve = done; });
    fetcher.mockImplementation((path, init) => (init as RequestInit | undefined)?.method === "PATCH" ? pending : fixture.responder(path as string, init as RequestInit));
    const target = screen.choice("payment-mentions");
    (target.props.onClick as () => void)(); (target.props.onClick as () => void)(); await screen.instance.settle();
    expect(screen.choice("payment-mentions").props["aria-checked"]).toBe(false);
    expect(screen.choice("payment-mentions").props.disabled).toBe(true);
    expect(fetcher.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "PATCH")).toHaveLength(1);
    resolve(Response.json({ ok: false }, { status: 503 })); await screen.instance.settle();
    expect(screen.choice("payment-mentions").props["aria-checked"]).toBe(false);
    expect(text(screen.instance.value)).toContain("couldn’t be confirmed");
    fetcher.mockImplementation(fixture.responder);
    await screen.click(screen.choice("payment-mentions"));
    expect(screen.checked()).toEqual([true, false, false, false, false]);
    const patch = fetcher.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "PATCH").at(-1)!;
    expect(JSON.parse((patch[1] as RequestInit).body as string)).toEqual({ paymentMentions: true });
    expect((patch[1] as RequestInit).headers).toMatchObject({ "x-alfred-owner": fixture.initial.ownerId });
  });
  it("ignores an old account's in-flight save after switching owners", async () => {
    const fixture = production(); const screen = view({ ownerId: fixture.initial.ownerId }); await screen.instance.settle();
    const other = "00000000-0000-4000-8000-000000000003";
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>(done => { resolve = done; });
    fetcher.mockImplementation((path, init) => {
      if ((init as RequestInit | undefined)?.method === "PATCH") return pending;
      return Promise.resolve(Response.json({ ok: true, ...fixture.initial, ownerId: other }));
    });
    (screen.choice("payment-mentions").props.onClick as () => void)();
    screen.instance.render({ ownerId: other }); await screen.instance.settle();
    resolve(Response.json({ ok: true, preferences: { ...fixture.initial.preferences, paymentMentions: true } })); await screen.instance.settle();
    expect(screen.checked()).toEqual([false, false, false, false, false]);
    expect(text(screen.instance.value)).not.toContain("Saved.");
  });
  it("Enable links this device and explicitly enables only payment notifications", async () => {
    const fixture = production({ preferences: { paymentMentions: true, billReminders: true } });
    const screen = view({ ownerId: fixture.initial.ownerId }); await screen.instance.settle();
    await screen.click(screen.button("Enable notifications"));
    expect(fixture.ask).toHaveBeenCalledOnce(); expect(fixture.browserRegister).toHaveBeenCalledOnce();
    expect(screen.checked()).toEqual([true, false, true, true, false]);
    expect(fixture.saved()).toMatchObject({ paymentMentions: true, outgoingMentions: false, paymentPush: true, paymentPreview: false, billReminders: true, weeklyOverview: false });
    expect(text(screen.instance.value)).toContain("Payment notifications enabled on this device");
    expect(fetcher.mock.calls.some(([path]) => String(path).endsWith("/test"))).toBe(false);
  });
  it("keeps honest linked-but-not-enabled state when preference saving fails", async () => {
    const fixture = production();
    fetcher.mockImplementation((path, init) => (init as RequestInit | undefined)?.method === "PATCH" ? Promise.resolve(Response.json({ ok: false }, { status: 503 })) : fixture.responder(path as string, init as RequestInit));
    const screen = view({ ownerId: fixture.initial.ownerId }); await screen.instance.settle();
    await screen.click(screen.button("Enable notifications"));
    expect(screen.choice("payment-push").props["aria-checked"]).toBe(false);
    expect(text(screen.instance.value)).toContain("This device is connected. Payment notification settings couldn’t be confirmed");
    expect(screen.button("Send test")).toBeDefined();
    expect(fixture.subscription.unsubscribe).not.toHaveBeenCalled();
  });
  it.each(["accepted", "unconfirmed", "throttled"])("tests only the current owned device and reports %s without automatic retry", async status => {
    const fixture = production({ linked: true, recoveryReady: false });
    const screen = view({ ownerId: fixture.initial.ownerId }); await screen.instance.settle();
    fetcher.mockImplementation((path, init) => String(path).endsWith("/test") ? Promise.resolve(Response.json({ ok: status !== "throttled", status }, { status: status === "throttled" ? 429 : status === "unconfirmed" ? 202 : 200 })) : fixture.responder(path as string, init as RequestInit));
    await screen.click(screen.button("Send test")); await screen.instance.settle();
    const calls = fetcher.mock.calls.filter(([path]) => String(path).endsWith("/test"));
    expect(calls).toHaveLength(1);
    expect(JSON.parse((calls[0][1] as RequestInit).body as string)).toEqual({ deviceId });
    expect((calls[0][1] as RequestInit).headers).toMatchObject({ "x-alfred-owner": fixture.initial.ownerId });
    expect(text(screen.instance.value)).toContain(status === "accepted" ? "Test sent. Check this device" : status === "unconfirmed" ? "result couldn’t be confirmed" : "wait 30 seconds");
    expect(text(screen.instance.value)).not.toContain("notification was shown");
  });
  it("can use a host-provided push manager without registering a competing worker", async () => {
    const fixture = production();
    vi.stubGlobal("window", { isSecureContext: true, Notification: { requestPermission: fixture.ask }, pushManager: fixture.manager });
    vi.stubGlobal("navigator", {});
    const screen = view({ ownerId: fixture.initial.ownerId }); await screen.instance.settle();
    await screen.click(screen.button("Enable notifications"));
    expect(fixture.manager.subscribe).toHaveBeenCalledOnce(); expect(fixture.browserRegister).not.toHaveBeenCalled();
    expect(screen.choice("payment-push").props["aria-checked"]).toBe(true);
  });
});

describe("fictional money-in and money-out conversation", () => {
  it("switches actual generated copy and resets replies without registering or filing anything", async () => {
    const copies = paymentMentionPreviewCopies();
    const screen = new Lifecycle(SmsAutomationPreview); mounted.push(screen); screen.render(copies);
    const nodes = () => descendants(screen.value, false);
    const button = (label: string) => nodes().find(node => node.type === "button" && text(node.props.children as ReactNode) === label)!;
    const click = async (label: string) => { const target = button(label); expect(target).toBeDefined(); (target.props.onClick as () => void)(); await screen.settle(); };
    expect(text(screen.value)).toContain(copies.knownCopy);
    await click("Money out");
    expect(text(screen.value)).toContain(copies.outgoingKnownCopy); expect(text(screen.value)).not.toContain(copies.knownCopy);
    await click("Unknown purpose");
    expect(text(screen.value)).toContain(copies.outgoingUnknownCopy);
    expect(nodes().find(node => node.type === "input")?.props.placeholder).toBe("It was for lunch");
    await click("Use sample reply");
    const form = nodes().find(node => node.type === "form")!;
    (form.props.onSubmit as (event: { preventDefault(): void }) => void)({ preventDefault: vi.fn() }); await screen.settle();
    expect(text(screen.value)).toContain("No second expense was added"); expect(text(screen.value)).toContain("Food");
    await click("Money in");
    expect(text(screen.value)).toContain(copies.unknownCopy); expect(text(screen.value)).not.toContain("No second expense was added");
    expect(nodes().find(node => node.type === "input")?.props.value).toBe("");
    expect(button("Use birthday example")).toBeDefined();
    expect(fetcher).not.toHaveBeenCalled(); expect(permission).not.toHaveBeenCalled(); expect(register).not.toHaveBeenCalled();
  });
});

describe("production boundaries and responsive preview markup", () => {
  it.each([{}, { configured: true }, { configured: true, deliveryEnabled: true }, { configured: true, deliveryEnabled: true, recoveryReady: false }])("keeps new production device choices disabled when readiness is incomplete: %j", (push) => {
    const initial = sample(); initial.push = { ...initial.push, ...push };
    const html = renderToStaticMarkup(createElement(NotificationsSection, { initial, ownerId: initial.ownerId }));
    const switches = html.match(/<button[^>]*role="switch"[^>]*>/g)!;
    expect(switches).toHaveLength(5); expect(switches.slice(0, 3).every((button) => !/\sdisabled(?:=|\s|>)/.test(button))).toBe(true);
    expect(switches.slice(3).every((button) => /\sdisabled(?:=|\s|>)/.test(button))).toBe(true);
    expect(html).not.toContain("Reset preview choices"); expect(html).not.toContain("Save preview choices");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("still allows existing production device choices to be turned off without recovery", () => {
    const initial = sample(); initial.preferences = { ...initial.preferences, paymentPush: true, billReminders: true, weeklyOverview: true };
    const html = renderToStaticMarkup(createElement(NotificationsSection, { initial }));
    expect(html.match(/<button[^>]*role="switch"[^>]*>/g)!.some((button) => /\sdisabled(?:=|\s|>)/.test(button))).toBe(false);
  });
  it("renders compact demo controls with touch targets and wrapping mobile/desktop layout", () => {
    const html = renderToStaticMarkup(createElement(AutomationsSettingsPreview));
    const switches = html.match(/<button[^>]*role="switch"[^>]*>/g)!;
    expect(switches).toHaveLength(7); expect(switches.every((button) => !/\sdisabled(?:=|\s|>)/.test(button) && /min-h-11 min-w-11 shrink-0/.test(button))).toBe(true);
    expect(html).toContain("flex flex-col gap-6 md:flex-row md:items-start");
    expect(html).toContain("min-w-0 flex-1"); expect(html).toContain("flex flex-wrap items-center justify-between gap-3");
    expect(html).toContain("Demo · sample choices only");
    expect(html).toContain("Manage sync"); expect(html).toContain("Reminders");
    expect(html).not.toContain("Scheduled push recovery");
    expect(html).not.toContain("Push delivery is currently off");
    expect(html).not.toContain("Scheduled recovery has recently checked in");
    expect(fetcher).not.toHaveBeenCalled(); expect(permission).not.toHaveBeenCalled(); expect(register).not.toHaveBeenCalled();
  });
});
