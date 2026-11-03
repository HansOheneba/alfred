import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { useOwnedSettingsData } from "@/app/settings/lazy-settings-data";

type Setter<T> = (next: T | ((previous: T) => T)) => void;
type Dispatcher = {
  state<T>(initial: T | (() => T)): [T, Setter<T>];
  effect(effect: () => void | (() => void), dependencies?: readonly unknown[]): void;
};
const runtime = vi.hoisted(() => ({ current: null as Dispatcher | null }));
vi.mock("react", () => ({
  useState: <T>(initial: T | (() => T)) => runtime.current!.state(initial),
  useEffect: (effect: () => void | (() => void), dependencies?: readonly unknown[]) => runtime.current!.effect(effect, dependencies),
}));

/** A dependency-free state/effect lifecycle runner. The real hook and its async
 * loader run unchanged; only React's dispatcher is controlled by the test. */
class Lifecycle<Props, Result> implements Dispatcher {
  private states: unknown[] = [];
  private effects: { dependencies?: readonly unknown[]; cleanup?: () => void }[] = [];
  private pending: (() => void)[] = [];
  private stateIndex = 0;
  private effectIndex = 0;
  private props!: Props;
  private mounted = true;
  private dirty = false;
  value!: Result;
  constructor(private component: (props: Props) => Result) {}
  state<T>(initial: T | (() => T)): [T, Setter<T>] {
    const index = this.stateIndex++;
    if (!(index in this.states)) this.states[index] = typeof initial === "function" ? (initial as () => T)() : initial;
    return [this.states[index] as T, (next) => {
      if (!this.mounted) return;
      const value = typeof next === "function" ? (next as (previous: T) => T)(this.states[index] as T) : next;
      if (!Object.is(value, this.states[index])) { this.states[index] = value; this.dirty = true; }
    }];
  }
  effect(effect: () => void | (() => void), dependencies?: readonly unknown[]) {
    const index = this.effectIndex++, previous = this.effects[index];
    if (previous && dependencies && previous.dependencies?.length === dependencies.length && dependencies.every((value, position) => Object.is(value, previous.dependencies![position]))) return;
    this.pending.push(() => {
      previous?.cleanup?.();
      const cleanup = effect();
      this.effects[index] = { dependencies, cleanup: typeof cleanup === "function" ? cleanup : undefined };
    });
  }
  render(props: Props) {
    this.props = props; this.dirty = false; this.stateIndex = 0; this.effectIndex = 0;
    const previous = runtime.current;
    runtime.current = this;
    try { this.value = this.component(props); }
    finally { runtime.current = previous; }
    for (const commit of this.pending.splice(0)) commit();
    return this.value;
  }
  async settle() {
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (this.dirty) this.render(this.props);
    return this.value;
  }
  unmount() { this.mounted = false; for (const effect of this.effects) effect?.cleanup?.(); }
}

type Ledger = { rows: unknown[]; budgets: unknown[]; goals: unknown[]; currency: string; label: string };
type Props = { owner: string; stamp: string; enabled: boolean; endpoint: string; initial?: Ledger };
const props: Props = { owner: "fictional-owner-a", stamp: "read-1", enabled: true, endpoint: "/api/settings/ledger" };
const ledger = (label: string): Ledger => ({ rows: [], budgets: [], goals: [], currency: "GHS", label });
type Request = { signal: AbortSignal; resolve: (response: Response) => void; reject: (error: Error) => void };
let requests: Request[];
const active: { unmount: () => void }[] = [];
function screen() {
  const value = new Lifecycle((input: Props) => useOwnedSettingsData<Ledger>(input.endpoint, "ledger", input.enabled, input.initial, input.owner, input.stamp));
  active.push(value); return value;
}
function answer(index: number, value: Ledger, ownerId = props.owner) {
  requests[index].resolve(Response.json({ ok: true, ownerId, ledger: value }));
}
beforeEach(() => {
  requests = [];
  vi.stubGlobal("fetch", vi.fn((_endpoint: string, options: { signal: AbortSignal }) => new Promise<Response>((resolve, reject) => requests.push({ signal: options.signal, resolve, reject }))));
});
afterEach(() => { for (const item of active.splice(0)) item.unmount(); runtime.current = null; vi.unstubAllGlobals(); });

describe("Settings refresh hook lifecycle", () => {
  it("preserves the loaded section, Saved notice and a subsequent draft across a successful refresh", async () => {
    const view = screen(), first = ledger("before save"), next = ledger("after save");
    view.render(props); answer(0, first); await view.settle();
    const loaded = view.value.value;
    // SettingsView renders the same section type while value remains defined.
    // Its component-local states must survive both the pending and settled read.
    const section = new Lifecycle((value: Ledger) => {
      const [identity] = useState(() => Symbol("mounted section"));
      const [notice, setNotice] = useState("");
      const [draft, setDraft] = useState("");
      return { identity, notice, draft, setNotice, setDraft, ledgerLabel: value.label };
    });
    active.push(section);
    const child = section.render(view.value.value!);
    child.setNotice("Saved ✓"); child.setDraft("Another edit still being typed");
    await section.settle();
    const refreshed = { ...props, stamp: "read-2" };
    expect(view.render(refreshed).value).toBe(loaded);
    expect(view.value.refreshing).toBe(true);
    expect(section.render(view.value.value!)).toMatchObject({ identity: child.identity, notice: "Saved ✓", draft: "Another edit still being typed", ledgerLabel: "before save" });
    answer(1, next); await view.settle();
    expect(view.value.value).toEqual(next);
    expect(view.value.refreshing).toBe(false);
    expect(section.render(view.value.value!)).toMatchObject({ identity: child.identity, notice: "Saved ✓", draft: "Another edit still being typed", ledgerLabel: "after save" });
    expect(requests).toHaveLength(2);
  });

  it("replaces stale data with a failed-reload error and recovers through an explicit retry", async () => {
    const view = screen(); view.render(props); answer(0, ledger("original")); await view.settle();
    view.render({ ...props, stamp: "read-2" });
    expect(view.value.value?.label).toBe("original");
    requests[1].reject(new Error("Synthetic read failed")); await view.settle();
    expect(view.value).toMatchObject({ value: undefined, error: "Synthetic read failed", refreshing: false });
    view.value.retry(); await view.settle();
    expect(view.value.value).toBeUndefined(); expect(view.value.error).toBeUndefined();
    answer(2, ledger("recovered")); await view.settle();
    expect(view.value.value?.label).toBe("recovered"); expect(view.value.error).toBeUndefined();
    view.render({ ...props, stamp: "read-2" }); expect(requests).toHaveLength(3);
  });

  it("keeps a populated form available during a manual retry without duplicate reads", async () => {
    const view = screen(); view.render(props); answer(0, ledger("original")); await view.settle();
    view.value.retry(); await view.settle();
    expect(view.value.value?.label).toBe("original");
    view.render(props); expect(requests).toHaveLength(2);
    answer(1, ledger("new value")); await view.settle();
    expect(view.value.value?.label).toBe("new value");
  });

  it("ignores superseded responses even when the fetch transport ignores abort", async () => {
    const view = screen(); view.render(props);
    view.render({ ...props, stamp: "read-2" });
    expect(requests[0].signal.aborted).toBe(true);
    answer(1, ledger("newest")); await view.settle();
    answer(0, ledger("obsolete")); await view.settle();
    expect(view.value.value?.label).toBe("newest");
  });

  it("does not show an old owner's value or skip the new owner's read when its read stamp is unchanged", async () => {
    const view = screen(); view.render(props); answer(0, ledger("owner A")); await view.settle();
    const other = { ...props, owner: "fictional-owner-b" };
    expect(view.render(other).value).toBeUndefined();
    expect(requests).toHaveLength(2);
    answer(1, ledger("owner B"), other.owner); await view.settle();
    expect(view.value.value?.label).toBe("owner B");
  });

  it("rejects a changed session response and does not retain an older successful value", async () => {
    const view = screen(); view.render(props); answer(0, ledger("owner A")); await view.settle();
    view.render({ ...props, stamp: "read-2" });
    answer(1, ledger("other session"), "fictional-owner-b"); await view.settle();
    expect(view.value.value).toBeUndefined(); expect(view.value.error).toMatch(/session changed/);
  });

  it("aborts disabled or unmounted reads and starts a fresh request on re-enabling", async () => {
    const view = screen(); view.render({ ...props, enabled: false }); expect(requests).toHaveLength(0);
    view.render(props); view.render({ ...props, enabled: false });
    expect(requests[0].signal.aborted).toBe(true);
    answer(0, ledger("obsolete")); await view.settle(); expect(view.value.value).toBeUndefined();
    view.render(props); expect(requests).toHaveLength(2);
    view.unmount(); expect(requests[1].signal.aborted).toBe(true);
    answer(1, ledger("unmounted")); await view.settle(); expect(view.value.value).toBeUndefined();
  });

  it("does not reuse another resource's retained value or completed read key", async () => {
    const view = screen(); view.render(props); answer(0, ledger("first endpoint")); await view.settle();
    expect(view.render({ ...props, endpoint: "/api/settings/other-ledger" }).value).toBeUndefined();
    answer(1, ledger("second endpoint")); await view.settle();
    expect(view.value.value?.label).toBe("second endpoint");
  });

  it("uses an explicitly provided initial value without requesting it again", () => {
    const view = screen(), initial = ledger("provided");
    expect(view.render({ ...props, initial }).value).toBe(initial);
    expect(requests).toHaveLength(0);
  });
});
