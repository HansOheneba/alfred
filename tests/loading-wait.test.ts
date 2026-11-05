import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoadingWait, PAGE_LOADING_NOTICE_MS } from "@/app/components/loading-wait";

const hooks = vi.hoisted(() => ({ slow: false, mounted: false, cleanup: undefined as undefined | (() => void) }));
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: () => [hooks.slow, (value: boolean) => { hooks.slow = value; }],
    useEffect: (effect: () => void | (() => void)) => { if (!hooks.mounted) { hooks.mounted = true; hooks.cleanup = effect() || undefined; } },
  };
});
const screen = () => renderToStaticMarkup(LoadingWait({ label: "Loading your account records", className: "sample", children: createElement("div", null, "Sample skeleton") }));
beforeEach(() => { vi.useFakeTimers(); hooks.slow = false; hooks.mounted = false; hooks.cleanup = undefined; });
afterEach(() => { hooks.cleanup?.(); vi.useRealTimers(); });

describe("stalled page reads", () => {
  it("offers a page reload after the loading deadline without inventing empty records", async () => {
    expect(screen()).toContain('aria-busy="true"');
    await vi.advanceTimersByTimeAsync(PAGE_LOADING_NOTICE_MS - 1);
    expect(screen()).toContain("Sample skeleton");
    await vi.advanceTimersByTimeAsync(1);
    const result = screen();
    expect(result).toContain('role="alert"'); expect(result).toContain("Reload page");
    expect(result).not.toContain("Sample skeleton"); expect(result).not.toContain("No accounts");
  });
  it("cancels the notice when the real page arrives and unmounts its fallback", async () => {
    screen(); hooks.cleanup?.(); await vi.advanceTimersByTimeAsync(PAGE_LOADING_NOTICE_MS);
    expect(hooks.slow).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });
});
