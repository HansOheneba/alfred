import { createElement, Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Select, changeNativeSelect, collectSelectOptions, findSelectTypeahead, nextSelectOption, type SelectOption, type SelectProps } from "@/app/components/select";

type Cleanup = () => void;
type Effect = { dependencies?: readonly unknown[]; cleanup?: Cleanup };
const hooks = vi.hoisted(() => ({ active: false, stateIndex: 0, refIndex: 0, effectIndex: 0, states: [] as unknown[], refs: [] as { current: unknown }[], effects: [] as Effect[], pending: [] as Cleanup[] }));
vi.mock("react", async load => {
  const react = await load<typeof import("react")>();
  return { ...react,
    useId: () => hooks.active ? "synthetic-select" : react.useId(),
    useState: <T>(initial: T | (() => T)) => {
      if (!hooks.active) return react.useState(initial);
      const index = hooks.stateIndex++;
      if (!(index in hooks.states)) hooks.states[index] = typeof initial === "function" ? (initial as () => T)() : initial;
      return [hooks.states[index] as T, (value: T | ((current: T) => T)) => { hooks.states[index] = typeof value === "function" ? (value as (current: T) => T)(hooks.states[index] as T) : value; }];
    },
    useRef: <T>(initial: T) => hooks.active ? (hooks.refs[hooks.refIndex++] ??= { current: initial }) : react.useRef(initial),
    useMemo: <T>(read: () => T, dependencies: readonly unknown[]) => hooks.active ? read() : react.useMemo(read, dependencies),
    useCallback: <T extends (...args: never[]) => unknown>(callback: T, dependencies: readonly unknown[]) => hooks.active ? callback : react.useCallback(callback, dependencies),
    useEffect: (effect: () => void | Cleanup, dependencies?: readonly unknown[]) => {
      if (!hooks.active) return react.useEffect(effect, dependencies);
      const index = hooks.effectIndex++, previous = hooks.effects[index];
      if (previous && dependencies?.length === previous.dependencies?.length && dependencies?.every((value, position) => Object.is(value, previous.dependencies?.[position]))) return;
      hooks.pending.push(() => { previous?.cleanup?.(); const cleanup = effect(); hooks.effects[index] = { dependencies, cleanup: typeof cleanup === "function" ? cleanup : undefined }; });
    },
  };
});

type Element = ReactElement<Record<string, unknown>>;
const nodes = (value: ReactNode): Element[] => Array.isArray(value) ? value.flatMap(nodes) : isValidElement<Record<string, unknown>>(value) ? [value, ...nodes(value.props.children as ReactNode)] : value && typeof value === "object" && "children" in value ? nodes(value.children as ReactNode) : [];
const option = (value: string, label: ReactNode = value, props: Record<string, unknown> = {}) => createElement("option", { value, ...props }, label);
const choices = [option("wallet", "Everyday wallet"), option("cash", "Cash")];
function markup(props: Omit<SelectProps, "children"> = {}, children: ReactNode = choices) { return renderToStaticMarkup(createElement(Select, props, children)); }
function model(value: string, disabled = false, hidden = false): SelectOption { return { value, label: value, disabled, hidden }; }

class NativeSelect extends EventTarget {
  value = "wallet";
  disabled = false;
  options = ["wallet", "cash", "locked"].map(value => ({ value, hidden: false, disabled: value === "locked", closest: () => null as { disabled: boolean } | null }));
  labels: HTMLLabelElement[] = [];
  form = new EventTarget();
  validity = { valid: true };
  validationMessage = "";
  setCustomValidity = vi.fn((message: string) => { this.validationMessage = message; this.validity.valid = !message; });
}
function mount(props: Omit<SelectProps, "children"> = {}) {
  const native = new NativeSelect();
  const trigger = { focus: vi.fn(), isConnected: true, disabled: false, matches: () => false };
  const body = { nodeType: 1, style: { overflow: "auto" } };
  const viewport = Object.assign(new EventTarget(), { innerWidth: 390, innerHeight: 844, matchMedia: () => ({ matches: true }) });
  vi.stubGlobal("document", { body }); vi.stubGlobal("window", viewport);
  const popup = { open: false, showModal: vi.fn(() => { popup.open = true; }), close: vi.fn(() => { popup.open = false; }) };
  const list = { focus: vi.fn(), querySelector: () => null };
  const search = { focus: vi.fn() };
  let tree: Element;
  function render(next = props) {
    hooks.stateIndex = 0; hooks.refIndex = 0; hooks.effectIndex = 0; hooks.active = true;
    try { tree = Select({ ...next, children: choices }) as Element; } finally { hooks.active = false; }
    hooks.refs[0].current = native; hooks.refs[1].current = trigger; hooks.refs[2].current = popup; hooks.refs[3].current = list; hooks.refs[4].current = search;
    for (const effect of hooks.pending.splice(0)) effect();
    return tree;
  }
  return { native, trigger, body, viewport, popup, list, search, render, get tree() { return tree; } };
}
afterEach(async () => {
  for (const effect of hooks.effects) effect.cleanup?.();
  await Promise.resolve();
  hooks.active = false; hooks.states = []; hooks.refs = []; hooks.effects = []; hooks.pending = []; hooks.stateIndex = 0; hooks.refIndex = 0; hooks.effectIndex = 0;
  vi.unstubAllGlobals();
});

describe("custom select option model", () => {
  it("preserves values, dynamic text, arrays, fragments and disabled option groups", () => {
    const options = collectSelectOptions(createElement(Fragment, null,
      option("", "Choose an account", { disabled: true }),
      [option("wallet", ["Wallet · ", 42]), createElement("optgroup", { label: "Unavailable", disabled: true }, option("cash", "Cash"))],
      option("hidden", "Hidden", { hidden: true }),
    ));
    expect(options).toEqual([
      { value: "", label: "Choose an account", disabled: true, hidden: false, group: undefined },
      { value: "wallet", label: "Wallet · 42", disabled: false, hidden: false, group: undefined },
      { value: "cash", label: "Cash", disabled: true, hidden: false, group: "Unavailable" },
      { value: "hidden", label: "Hidden", disabled: false, hidden: true, group: undefined },
    ]);
  });

  it("moves through enabled visible options and wraps without selecting disabled or hidden rows", () => {
    const options = [model("locked", true), model("wallet"), model("hidden", false, true), model("cash")];
    expect(nextSelectOption(options, -1, 1)).toBe(1);
    expect(nextSelectOption(options, 1, 1)).toBe(3);
    expect(nextSelectOption(options, 3, 1)).toBe(1);
    expect(nextSelectOption(options, 1, -1)).toBe(3);
    expect(nextSelectOption([model("locked", true)], 0, 1)).toBe(-1);
    expect(nextSelectOption([], -1, 1)).toBe(-1);
  });

  it("typeahead finds the next matching label, respects case and skips disabled rows", () => {
    const options = [model("Card locked", true), model("Cash"), model("Card wallet"), model("Bank")];
    expect(findSelectTypeahead(options, 1, "ca")).toBe(2);
    expect(findSelectTypeahead(options, 2, "CA")).toBe(1);
    expect(findSelectTypeahead(options, 2, "bank")).toBe(3);
    expect(findSelectTypeahead(options, 1, "unknown")).toBe(-1);
  });
});

describe("native form compatibility", () => {
  it.each([{ value: "saved-custom" }, { defaultValue: "saved-custom" }])("preserves an unavailable saved value instead of selecting the first real option: %j", props => {
    const html = markup({ ...props, name: "status", required: true, "aria-label": "Status" });
    expect(html).toContain('<option value="saved-custom" hidden="" selected="">Unavailable selection</option>');
    expect(html).not.toContain('<option value="wallet" selected="">');
    expect(html).toContain('name="status" required=""');
    expect(html).toContain('aria-invalid="true"');
  });

  it.each([{ value: "" }, { defaultValue: "" }])("retains blank values with no blank child option, including required validation: %j", props => {
    const html = markup({ ...props, name: "category", required: true });
    expect(html).toContain('<option value="" hidden="" selected="">Choose an option</option>');
    expect(html).not.toContain('<option value="wallet" selected="">');
    expect(html).toContain("Choose an option");
  });

  it("keeps name, required, disabled, defaultValue, descriptions and a single accessible trigger", () => {
    const html = markup({ name: "status", defaultValue: "cash", required: true, disabled: true, "aria-label": "Status", "aria-describedby": "status-help" });
    expect(html).toContain('class="alfred-select-native"'); expect(html).toContain('tabindex="-1" aria-hidden="true"');
    expect(html).toContain('name="status" required=""'); expect(html).toContain('<option value="cash" selected="">Cash</option>');
    expect(html).toContain('role="combobox"'); expect(html).toContain('aria-label="Status"'); expect(html).toContain('aria-describedby="status-help"');
    expect((html.match(/ disabled=""/g) ?? []).length).toBe(2);
  });

  it("dispatches a real change event with the select as target and never emits for disabled, same or unavailable values", () => {
    const native = new NativeSelect(), listener = vi.fn((event: Event) => expect(event.target).toBe(native));
    native.addEventListener("change", listener);
    expect(changeNativeSelect(native as unknown as HTMLSelectElement, "cash")).toBe(true);
    expect(native.value).toBe("cash"); expect(listener).toHaveBeenCalledOnce();
    expect(changeNativeSelect(native as unknown as HTMLSelectElement, "cash")).toBe(false);
    expect(changeNativeSelect(native as unknown as HTMLSelectElement, "locked")).toBe(false);
    expect(changeNativeSelect(native as unknown as HTMLSelectElement, "missing")).toBe(false);
    native.disabled = true;
    expect(changeNativeSelect(native as unknown as HTMLSelectElement, "wallet")).toBe(false);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("shows required-field feedback and focuses the visible trigger while preserving caller onInvalid", () => {
    const onInvalid = vi.fn(), screen = mount({ defaultValue: "", required: true, onInvalid });
    screen.render();
    screen.native.validity.valid = false; screen.native.validationMessage = "Please select an item in the list.";
    const control = nodes(screen.tree).find(node => node.type === "select")!;
    const preventDefault = vi.fn();
    (control.props.onInvalid as (event: unknown) => void)({ currentTarget: screen.native, preventDefault });
    screen.render();
    expect(preventDefault).toHaveBeenCalledOnce(); expect(onInvalid).toHaveBeenCalledOnce(); expect(screen.trigger.focus).toHaveBeenCalledOnce();
    const trigger = nodes(screen.tree).find(node => node.props.role === "combobox")!;
    expect(trigger.props["aria-invalid"]).toBe(true);
    const message = nodes(screen.tree).find(node => node.props.role === "alert")!;
    expect(message.props.children).toBe("Please select an item in the list.");
    expect(trigger.props["aria-describedby"]).toBe(message.props.id);
  });

  it("restores an uncontrolled form's reset value without emitting a new change", async () => {
    const onChange = vi.fn(), screen = mount({ defaultValue: "wallet", onChange });
    screen.render(); screen.native.value = "cash";
    const control = nodes(screen.tree).find(node => node.type === "select")!;
    (control.props.onChange as (event: unknown) => void)({ currentTarget: screen.native }); screen.render();
    expect(nodes(screen.tree).find(node => node.props.role === "combobox")?.props.children).toBeDefined();
    screen.native.form.dispatchEvent(new Event("reset")); screen.native.value = "wallet";
    await new Promise(resolve => setTimeout(resolve, 0)); screen.render();
    expect(hooks.states[0]).toBe("wallet"); expect(onChange).toHaveBeenCalledOnce();
  });

  it.each(["", "unavailable-id"])("retains a missing reset baseline %j after a valid choice and restores it after native fallback", async baseline => {
    const onChange = vi.fn(), screen = mount({ defaultValue: baseline, onChange });
    screen.render(); screen.native.value = "cash";
    const control = nodes(screen.tree).find(node => node.type === "select")!;
    (control.props.onChange as (event: unknown) => void)({ currentTarget: screen.native });
    screen.render();
    const retained = nodes(screen.tree).find(node => node.type === "option" && node.props.hidden && node.props.value === baseline);
    expect(retained).toBeDefined();
    screen.native.form.dispatchEvent(new Event("reset"));
    // Browser reset may happen after a microtask and otherwise choose its first real option.
    await Promise.resolve(); screen.native.value = "wallet";
    await new Promise(resolve => setTimeout(resolve, 0)); screen.render();
    expect(screen.native.value).toBe(baseline); expect(hooks.states[0]).toBe(baseline);
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("restores the latest controlled native value after the browser reset without emitting another change", async () => {
    const onChange = vi.fn(), screen = mount({ value: "wallet", onChange });
    screen.render(); screen.native.value = "cash";
    (nodes(screen.tree).find(node => node.type === "select")!.props.onChange as (event: unknown) => void)({ currentTarget: screen.native });
    screen.render({ value: "cash", onChange });
    screen.native.form.dispatchEvent(new Event("reset"));
    await Promise.resolve(); screen.native.value = "wallet";
    await new Promise(resolve => setTimeout(resolve, 0)); screen.render({ value: "cash", onChange });
    expect(screen.native.value).toBe("cash"); expect(onChange).toHaveBeenCalledOnce();
  });

  it("respects a cancelled native reset", async () => {
    const screen = mount({ defaultValue: "wallet" });
    screen.render(); screen.native.value = "cash";
    (nodes(screen.tree).find(node => node.type === "select")!.props.onChange as (event: unknown) => void)({ currentTarget: screen.native }); screen.render();
    screen.native.form.addEventListener("reset", event => event.preventDefault());
    screen.native.form.dispatchEvent(new Event("reset", { cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0)); screen.render();
    expect(screen.native.value).toBe("cash"); expect(hooks.states[0]).toBe("cash");
  });
});

describe("picker lifecycle", () => {
  it("keeps the mobile picker open for height-only keyboard resizes and closes for a width change", () => {
    const screen = mount(); screen.render(); hooks.states[1] = true; screen.render();
    expect(screen.popup.showModal).toHaveBeenCalledOnce(); expect(screen.list.focus).toHaveBeenCalledOnce(); expect(screen.search.focus).not.toHaveBeenCalled();
    expect(screen.body.style.overflow).toBe("hidden");
    screen.viewport.innerHeight = 480; screen.viewport.dispatchEvent(new Event("resize"));
    expect(hooks.states[1]).toBe(true);
    screen.viewport.innerWidth = 430; screen.viewport.dispatchEvent(new Event("resize"));
    expect(hooks.states[1]).toBe(false); screen.render();
    expect(screen.popup.close).toHaveBeenCalledOnce(); expect(screen.body.style.overflow).toBe("auto"); expect(screen.trigger.focus).toHaveBeenCalled();
  });

  it("does not restore an enclosing editor's stale scroll lock after that editor closes", () => {
    const screen = mount(); screen.render(); screen.body.style.overflow = "hidden";
    hooks.states[1] = true; screen.render();
    screen.body.style.overflow = "auto";
    hooks.states[1] = false; screen.render();
    expect(screen.body.style.overflow).toBe("auto");
  });
});
