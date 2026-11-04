import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button, ConfirmDialog, Dialog } from "@/app/components/ui";

type Cleanup = () => void;
type Effect = { dependencies?: readonly unknown[]; cleanup?: Cleanup };
const hooks = vi.hoisted(() => ({ active: false, cursor: 0, effectCursor: 0, refs: [] as { current: unknown }[], effects: [] as Effect[], pending: [] as Cleanup[] }));
vi.mock("react", async load => {
  const react = await load<typeof import("react")>();
  return { ...react,
    useId: () => hooks.active ? "synthetic-dialog-heading" : react.useId(),
    useRef: <T>(initial: T) => hooks.active ? (hooks.refs[hooks.cursor++] ??= { current: initial }) : react.useRef(initial),
    useEffect: (effect: () => void | Cleanup, dependencies?: readonly unknown[]) => {
      if (!hooks.active) return react.useEffect(effect, dependencies);
      const index = hooks.effectCursor++, previous = hooks.effects[index];
      if (previous && dependencies?.every((value, position) => Object.is(value, previous.dependencies?.[position]))) return;
      hooks.pending.push(() => { previous?.cleanup?.(); const cleanup = effect(); hooks.effects[index] = { dependencies, cleanup: typeof cleanup === "function" ? cleanup : undefined }; });
    },
  };
});
type Element = ReactElement<Record<string, unknown>>;
const nodes = (value: ReactNode): Element[] => Array.isArray(value) ? value.flatMap(nodes) : isValidElement<Record<string, unknown>>(value) ? [value, ...nodes(value.props.children as ReactNode)] : [];
class FocusTarget { isConnected = true; focus = vi.fn(); }
function mounted(dismissible = true) {
  const trigger = new FocusTarget(), body = { style: { overflow: "auto" } };
  vi.stubGlobal("HTMLElement", FocusTarget);
  vi.stubGlobal("document", { activeElement: trigger, body });
  const native = { open: false, showModal: vi.fn(() => { native.open = true; }), close: vi.fn(() => { native.open = false; }), getBoundingClientRect: () => ({ left: 0, right: 390, top: 100, bottom: 844 }) };
  const onClose = vi.fn();
  let tree: ReactNode;
  function render(open: boolean) {
    hooks.cursor = 0; hooks.effectCursor = 0; hooks.active = true;
    try { tree = Dialog({ open, onClose, dismissible, title: "Review a synthetic change", children: "Synthetic content" }); } finally { hooks.active = false; }
    hooks.refs[0].current = native;
    for (const effect of hooks.pending.splice(0)) effect();
    return tree as Element;
  }
  return { trigger, body, native, onClose, render, get tree() { return tree; } };
}
afterEach(() => {
  for (const effect of hooks.effects) effect.cleanup?.();
  hooks.active = false; hooks.cursor = 0; hooks.effectCursor = 0; hooks.refs = []; hooks.effects = []; hooks.pending = [];
  vi.unstubAllGlobals();
});

describe("shared dialog accessibility and dismissal", () => {
  it("uses the visible heading as its accessible name, opens natively and restores focus and body scrolling", () => {
    const screen = mounted(), opened = screen.render(true);
    const heading = nodes(opened).find(node => node.type === "h2")!;
    expect(opened.props["aria-labelledby"]).toBe(heading.props.id);
    expect(heading.props.children).toBe("Review a synthetic change");
    expect(screen.native.showModal).toHaveBeenCalledOnce();
    expect(screen.body.style.overflow).toBe("hidden");
    screen.render(false);
    expect(screen.native.close).toHaveBeenCalledOnce();
    expect(screen.body.style.overflow).toBe("auto");
    expect(screen.trigger.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("requests controlled Escape dismissal and closes only outside the dialog bounds", () => {
    const screen = mounted(), dialog = screen.render(true);
    const preventDefault = vi.fn();
    (dialog.props.onCancel as (event: unknown) => void)({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce(); expect(screen.onClose).toHaveBeenCalledOnce();
    screen.onClose.mockClear();
    const click = dialog.props.onClick as (event: unknown) => void;
    click({ target: screen.native, currentTarget: screen.native, clientX: 20, clientY: 200 });
    click({ target: {}, currentTarget: screen.native, clientX: 20, clientY: 20 });
    expect(screen.onClose).not.toHaveBeenCalled();
    click({ target: screen.native, currentTarget: screen.native, clientX: 20, clientY: 20 });
    expect(screen.onClose).toHaveBeenCalledOnce();
  });

  it("blocks close, Escape and backdrop dismissal while a confirmation is busy", () => {
    const screen = mounted(false), dialog = screen.render(true);
    (dialog.props.onCancel as (event: unknown) => void)({ preventDefault: vi.fn() });
    (dialog.props.onClick as (event: unknown) => void)({ target: screen.native, currentTarget: screen.native, clientX: 20, clientY: 20 });
    const close = nodes(dialog).find(node => node.type === Button)!;
    expect(close.props.disabled).toBe(true);
    (close.props.onClick as () => void)();
    expect(screen.onClose).not.toHaveBeenCalled();
    const confirmation = ConfirmDialog({ open: true, title: "Confirm", body: "Synthetic only", confirmLabel: "Save", busy: true, onConfirm: vi.fn(), onClose: vi.fn() });
    expect(confirmation.props.dismissible).toBe(false);
    expect(nodes(confirmation).filter(node => node.type === Button).every(node => node.props.disabled)).toBe(true);
  });

  it("restores scrolling on unmount without focusing a removed trigger", () => {
    const screen = mounted(); screen.render(true); screen.trigger.isConnected = false;
    for (const effect of hooks.effects) effect.cleanup?.(); hooks.effects = [];
    expect(screen.body.style.overflow).toBe("auto");
    expect(screen.trigger.focus).not.toHaveBeenCalled();
  });
});
