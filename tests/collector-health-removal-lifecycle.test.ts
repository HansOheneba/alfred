import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button, ConfirmDialog } from "@/app/components/ui";
import { CollectorHealthSection, parseCollectorHealth } from "@/app/settings/collector-health-section";

type Setter<T> = (next: T | ((previous: T) => T)) => void;
type Dispatcher = {
  state<T>(initial: T | (() => T)): [T, Setter<T>];
  ref<T>(initial: T): { current: T };
  effect(effect: () => void | (() => void), dependencies?: readonly unknown[]): void;
};
const runtime = vi.hoisted(() => ({ current: null as Dispatcher | null }));
vi.mock("react", async load => {
  const react = await load<typeof import("react")>();
  return { ...react,
    useState: <T>(initial: T | (() => T)) => runtime.current ? runtime.current.state(initial) : react.useState(initial),
    useRef: <T>(initial: T) => runtime.current ? runtime.current.ref(initial) : react.useRef(initial),
    useEffect: (effect: () => void | (() => void), dependencies?: readonly unknown[]) => runtime.current ? runtime.current.effect(effect, dependencies) : react.useEffect(effect, dependencies),
  };
});

/** The existing component's real effects and handlers, with controlled fixture
 * fetches. This is not a browser rendering or native application test. */
class Lifecycle implements Dispatcher {
  private states: unknown[] = [];
  private refs: { current: unknown }[] = [];
  private effects: { dependencies?: readonly unknown[]; cleanup?: () => void }[] = [];
  private pending: (() => void)[] = [];
  private stateIndex = 0;
  private refIndex = 0;
  private effectIndex = 0;
  private props!: Parameters<typeof CollectorHealthSection>[0];
  value!: ReactNode;
  state<T>(initial: T | (() => T)): [T, Setter<T>] {
    const index = this.stateIndex++;
    if (!(index in this.states)) this.states[index] = typeof initial === "function" ? (initial as () => T)() : initial;
    return [this.states[index] as T, next => { this.states[index] = typeof next === "function" ? (next as (previous: T) => T)(this.states[index] as T) : next; }];
  }
  ref<T>(initial: T): { current: T } { const index = this.refIndex++; return (this.refs[index] ??= { current: initial }) as { current: T }; }
  effect(effect: () => void | (() => void), dependencies?: readonly unknown[]) {
    const index = this.effectIndex++, previous = this.effects[index];
    if (previous && dependencies && dependencies.length === previous.dependencies?.length && dependencies.every((value, position) => Object.is(value, previous.dependencies![position]))) return;
    this.pending.push(() => { previous?.cleanup?.(); const cleanup = effect(); this.effects[index] = { dependencies, cleanup: typeof cleanup === "function" ? cleanup : undefined }; });
  }
  render(props = this.props) {
    this.props = props; this.stateIndex = 0; this.refIndex = 0; this.effectIndex = 0;
    const previous = runtime.current; runtime.current = this;
    try { this.value = CollectorHealthSection(props); } finally { runtime.current = previous; }
    for (const commit of this.pending.splice(0)) commit();
    return this.value;
  }
  async settle() { await new Promise<void>(resolve => setImmediate(resolve)); return this.render(); }
  unmount() { for (const effect of this.effects) effect?.cleanup?.(); }
}
type Element = ReactElement<Record<string, unknown>>;
function nodes(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  return isValidElement<Record<string, unknown>>(node) ? [node, ...nodes(node.props.children as ReactNode)] : [];
}
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return isValidElement<Record<string, unknown>>(node) ? text(node.props.children as ReactNode) : "";
}
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", device = "11111111-1111-4111-8111-111111111111";
const fixture = (id = owner) => ({ ok: true, ownerId: id, checkedAt: "2026-11-03T14:30:00Z", devices: [{ deviceId: id === owner ? device : "22222222-2222-4222-8222-222222222222", state: "needs_review", counts: { sourceQuarantine: 0, unreadable: 0, incomplete: 0, heldForReview: 0, pending: id === owner ? 1 : 4 }, lastSeenAt: "2026-11-03T14:29:00Z", lastSuccessfulCaptureAt: "2026-11-03T14:28:00Z", lastAcceptedAt: null }] });
const mounted: Lifecycle[] = [];
function view(props: Parameters<typeof CollectorHealthSection>[0] = { ownerId: owner }) {
  const instance = new Lifecycle(); mounted.push(instance); instance.render(props);
  const dialog = () => nodes(instance.value).find(node => node.type === ConfirmDialog)!.props;
  const remove = () => nodes(instance.value).find(node => node.type === Button && text(node.props.children as ReactNode) === "Remove saved status");
  const clickRemove = async () => { expect(remove()).toBeDefined(); (remove()!.props.onClick as () => void)(); await instance.settle(); };
  return { instance, dialog, remove, clickRemove };
}
afterEach(() => { for (const instance of mounted.splice(0)) instance.unmount(); runtime.current = null; vi.unstubAllGlobals(); });

describe("saved Mac status confirmation lifecycle", () => {
  it("requires confirmation; cancellation preserves the list and preview confirmation stays local", async () => {
    const fetcher = vi.fn(() => { throw Error("No preview network permitted"); }); vi.stubGlobal("fetch", fetcher);
    const screen = view({ preview: true, initial: parseCollectorHealth(fixture()) }); await screen.instance.settle();
    await screen.clickRemove(); expect(screen.dialog().open).toBe(true);
    expect(text(screen.dialog().body as ReactNode)).toContain("active Mac may appear again");
    (screen.dialog().onClose as () => void)(); await screen.instance.settle();
    expect(screen.dialog().open).toBe(false); expect(screen.remove()).toBeDefined();
    await screen.clickRemove(); (screen.dialog().onConfirm as () => void)(); await screen.instance.settle();
    expect(screen.dialog().open).toBe(false); expect(screen.remove()).toBeUndefined();
    expect(text(screen.instance.value)).toContain("Sample status removed for this visit"); expect(fetcher).not.toHaveBeenCalled();
  });
  it("leaves the selected status and dialog available after a failed removal", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => init?.method === "DELETE" ? Response.json({ text: "private-fixture" }, { status: 503 }) : Response.json(fixture())));
    const screen = view(); await screen.instance.settle(); await screen.clickRemove();
    (screen.dialog().onConfirm as () => void)(); await screen.instance.settle();
    expect(screen.dialog().open).toBe(true); expect(screen.dialog().busy).toBe(false); expect(screen.remove()).toBeDefined();
    expect(text(screen.dialog().body as ReactNode)).toContain("could not be removed");
    expect(text(screen.dialog().body as ReactNode)).not.toContain("private-fixture");
    expect(text(screen.instance.value)).not.toContain("Saved status removed");
  });
  it("ignores a late removal reply after the displayed account changes", async () => {
    let resolveRemoval!: (value: Response) => void;
    let deletionSignal: AbortSignal | undefined;
    let account = owner;
    const fetcher = vi.fn((_url: unknown, init?: RequestInit) => {
      if (init?.method === "DELETE") { deletionSignal = init.signal ?? undefined; return new Promise<Response>(resolve => { resolveRemoval = resolve; }); }
      return Promise.resolve(Response.json(fixture(account)));
    }); vi.stubGlobal("fetch", fetcher);
    const screen = view(); await screen.instance.settle(); await screen.clickRemove();
    const confirm = screen.dialog().onConfirm as () => void;
    confirm(); confirm(); await screen.instance.settle(); expect(screen.dialog().busy).toBe(true);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
    account = other; screen.instance.render({ ownerId: other });
    expect(screen.dialog().open).toBe(false); expect(screen.remove()).toBeUndefined(); expect(deletionSignal?.aborted).toBe(true);
    await screen.instance.settle(); expect(text(screen.instance.value)).toContain("4 alerts are waiting");
    resolveRemoval(Response.json({ ok: true, ownerId: owner, deviceId: device, removed: true })); await screen.instance.settle();
    expect(text(screen.instance.value)).toContain("4 alerts are waiting"); expect(text(screen.instance.value)).not.toContain("Saved status removed");
    expect(screen.remove()).toBeDefined(); expect(screen.dialog().open).toBe(false);
  });
  it("refuses an old dialog handler after an account switch or unmount", async () => {
    let account = owner;
    const fetcher = vi.fn(async () => Response.json(fixture(account))); vi.stubGlobal("fetch", fetcher);
    const screen = view(); await screen.instance.settle(); await screen.clickRemove();
    const previousConfirm = screen.dialog().onConfirm as () => void;
    account = other; screen.instance.render({ ownerId: other }); await screen.instance.settle();
    const before = fetcher.mock.calls.length; previousConfirm(); await screen.instance.settle();
    expect(fetcher).toHaveBeenCalledTimes(before); expect(text(screen.instance.value)).toContain("4 alerts are waiting");
    await screen.clickRemove(); const unmountedConfirm = screen.dialog().onConfirm as () => void;
    screen.instance.unmount(); unmountedConfirm(); await screen.instance.settle(); expect(fetcher).toHaveBeenCalledTimes(before);
  });
});
