import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CategoryCombobox } from "@/app/components/category-combobox";

const runtime = vi.hoisted(() => ({ active: false, index: 0, refIndex: 0, state: [] as unknown[], refs: [] as { current: unknown }[] }));
vi.mock("react", async load => {
  const react = await load<typeof import("react")>();
  return { ...react,
    useId: () => runtime.active ? "synthetic-category" : react.useId(),
    useRef: <T>(initial: T) => runtime.active ? (runtime.refs[runtime.refIndex++] ??= { current: initial }) : react.useRef(initial),
    useEffect: (...args: Parameters<typeof react.useEffect>) => { if (!runtime.active) react.useEffect(...args); },
    useState: <T>(initial: T) => {
      if (!runtime.active) return react.useState(initial);
      const index = runtime.index++; if (!(index in runtime.state)) runtime.state[index] = initial;
      return [runtime.state[index], (next: T | ((old: T) => T)) => { runtime.state[index] = typeof next === "function" ? (next as (old: T) => T)(runtime.state[index] as T) : next; }];
    },
  };
});
type Element = ReactElement<Record<string, unknown>>;
function nodes(value: ReactNode): Element[] { return Array.isArray(value) ? value.flatMap(nodes) : isValidElement<Record<string, unknown>>(value) ? [value, ...nodes(value.props.children as ReactNode)] : []; }
function screen(disabled = false) {
  let value = "", tree: ReactNode;
  const changes = vi.fn((next: string) => { value = next; });
  function render() {
    runtime.active = true; runtime.index = 0; runtime.refIndex = 0;
    try { tree = CategoryCombobox({ "aria-label": "Category", required: true, name: "category", maxLength: 120, value, options: ["Food", "Transport", "Food", "Business"], onValueChange: changes, disabled }); }
    finally { runtime.active = false; }
    return result;
  }
  const result = {
    render, changes,
    get tree() { return tree as Element; },
    get input() { return nodes(tree).find(node => node.type === "input")!; },
    get options() { return nodes(tree).filter(node => node.props.role === "option"); },
    key(key: string, isComposing = false) {
      const event = { key, nativeEvent: { isComposing }, defaultPrevented: false, preventDefault: vi.fn(() => { event.defaultPrevented = true; }), stopPropagation: vi.fn() };
      (result.input.props.onKeyDown as (event: unknown) => void)(event); render(); return event;
    },
    focus() { (result.input.props.onFocus as (event: unknown) => void)({}); return render(); },
    type(next: string) { (result.input.props.onChange as (event: unknown) => void)({ target: { value: next } }); return render(); },
  };
  return render();
}
afterEach(() => { runtime.active = false; runtime.index = 0; runtime.refIndex = 0; runtime.state = []; runtime.refs = []; });

describe("free-entry category suggestions", () => {
  it("preserves the native form control and opens deduplicated, custom-rendered suggestions", () => {
    const view = screen(); expect(view.input.props.role).toBe("combobox"); expect(view.input.props["aria-label"]).toBe("Category");
    expect(view.input.props.name).toBe("category"); expect(view.input.props.required).toBe(true); expect(view.input.props.maxLength).toBe(120);
    expect(view.input.props.list).toBeUndefined(); expect(nodes(view.tree).some(node => node.type === "datalist")).toBe(false);
    view.focus(); expect(view.options.map(option => option.props.children)).toEqual(["Food", "Transport", "Business"]);
    expect(view.input.props["aria-expanded"]).toBe(true);
  });

  it("keeps custom text and filters suggestions without requiring a match", () => {
    const view = screen().type("trans"); expect(view.options.map(option => option.props.children)).toEqual(["Transport"]);
    view.type("My custom category"); expect(view.options).toHaveLength(0); expect(view.input.props.value).toBe("My custom category");
    expect(view.key("Enter").preventDefault).not.toHaveBeenCalled();
    expect(view.changes).toHaveBeenLastCalledWith("My custom category");
  });

  it("selects with arrows and Enter, and exposes the active option for assistive technology", () => {
    const view = screen(); view.key("ArrowUp"); expect(view.options[2].props["aria-selected"]).toBe(true);
    expect(view.input.props["aria-activedescendant"]).toBe(view.options[2].props.id);
    view.key("ArrowDown"); expect(view.options[0].props["aria-selected"]).toBe(true);
    expect(view.key("Enter").preventDefault).toHaveBeenCalledOnce(); expect(view.changes).toHaveBeenLastCalledWith("Food");
    expect(view.input.props["aria-expanded"]).toBe(false);
  });

  it("leaves IME composition keys untouched without opening, navigating or selecting suggestions", () => {
    const view = screen();
    const closedArrow = view.key("ArrowDown", true);
    expect(closedArrow.preventDefault).not.toHaveBeenCalled();
    expect(view.input.props["aria-expanded"]).toBe(false);
    expect(view.options).toHaveLength(0);

    view.key("ArrowDown");
    const activeId = view.input.props["aria-activedescendant"];
    const composingArrow = view.key("ArrowDown", true), composingEnter = view.key("Enter", true);
    for (const event of [composingArrow, composingEnter]) {
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(event.stopPropagation).not.toHaveBeenCalled();
    }
    expect(view.input.props["aria-activedescendant"]).toBe(activeId);
    expect(view.input.props["aria-expanded"]).toBe(true);
    expect(view.changes).not.toHaveBeenCalled();

    view.key("Enter");
    expect(view.changes).toHaveBeenLastCalledWith("Food");
    expect(view.input.props["aria-expanded"]).toBe(false);
  });

  it("closes on Escape or outside blur and keeps pointer selection from losing input focus", () => {
    const view = screen().focus(); const escape = view.key("Escape"); expect(escape.stopPropagation).toHaveBeenCalledOnce();
    expect(view.input.props["aria-expanded"]).toBe(false);
    view.focus(); const preventDefault = vi.fn(); (view.options[1].props.onPointerDown as (event: unknown) => void)({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce(); (view.options[1].props.onClick as () => void)(); view.render();
    expect(view.changes).toHaveBeenLastCalledWith("Transport");
    view.focus(); (view.tree.props.onBlur as (event: unknown) => void)({ currentTarget: { contains: () => false }, relatedTarget: null }); view.render();
    expect(view.input.props["aria-expanded"]).toBe(false);
  });

  it("does not open or change values while disabled", () => {
    const view = screen(true).focus().type("Food"); view.key("ArrowDown");
    expect(view.input.props.disabled).toBe(true); expect(view.input.props["aria-expanded"]).toBe(false); expect(view.options).toHaveLength(0);
    expect(view.changes).not.toHaveBeenCalled();
  });
});
