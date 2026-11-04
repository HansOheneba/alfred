import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell, AppearanceToggle, PrivacyToggle } from "@/app/components/app-shell";
import { BROWSER_PREFERENCES_LOCK } from "@/lib/portability/browser-preferences-lock";

const runtime = vi.hoisted(() => ({ direct: false }));
vi.mock("react", async load => {
  const react = await load<typeof import("react")>();
  return { ...react, useSyncExternalStore: <T>(subscribe: (callback: () => void) => () => void, read: () => T, server?: () => T) => runtime.direct ? read() : react.useSyncExternalStore(subscribe, read, server) };
});
type Control = ReactElement<{ onClick: () => void; "aria-label": string; "aria-pressed": boolean }>;
function control(render: () => ReactElement) { runtime.direct = true; try { return render() as Control; } finally { runtime.direct = false; } }
let dataset: Record<string, string>;
let storage: Map<string, string>;
let request: ReturnType<typeof vi.fn>;
beforeEach(() => {
  dataset = {}; storage = new Map();
  request = vi.fn(async (_name: string, operation: () => unknown) => await operation());
  vi.stubGlobal("document", { documentElement: { dataset } });
  vi.stubGlobal("navigator", { locks: { request } });
  vi.stubGlobal("localStorage", { setItem: vi.fn((key: string, value: string) => storage.set(key, value)), removeItem: vi.fn((key: string) => storage.delete(key)) });
});
afterEach(() => { runtime.direct = false; vi.unstubAllGlobals(); });

describe("compact header display controls", () => {
  it.each(["dashboard", "chat", "settings"] as const)("removes the profile avatar on %s while keeping both navigations and labelled icon controls", current => {
    const props: Parameters<typeof AppShell>[0] = { current, name: "Fictional reviewer", children: "Sample content" };
    const markup = renderToStaticMarkup(createElement(AppShell, props));
    expect(markup).not.toContain("alfred-app-profile");
    expect(markup).not.toContain('href="/settings#profile"');
    expect(markup).toContain('role="group" aria-label="Display controls"');
    expect(markup).toContain('aria-label="Hide amounts"');
    expect(markup).toContain('aria-label="Switch to dark appearance"');
    expect(markup).toContain('aria-label="Main"');
    expect(markup).toContain('aria-label="Main (mobile)"');
    expect(markup).not.toContain("alfred-ui-themeButton");
  });

  it("masks and reveals amounts using the same persisted, coordinated preference", async () => {
    let button = control(PrivacyToggle); expect(button.props["aria-pressed"]).toBe(false);
    button.props.onClick(); await Promise.resolve();
    expect(dataset.privacy).toBe("masked"); expect(storage.get("alfred-privacy")).toBe("masked");
    button = control(PrivacyToggle); expect(button.props["aria-pressed"]).toBe(true); expect(button.props["aria-label"]).toBe("Reveal amounts");
    button.props.onClick(); await Promise.resolve();
    expect(dataset.privacy).toBeUndefined(); expect(storage.has("alfred-privacy")).toBe(false);
    expect(request).toHaveBeenCalledWith(BROWSER_PREFERENCES_LOCK, expect.any(Function));
  });

  it("switches appearance with the same persisted setting and accurate pressed/action state", async () => {
    let button = control(AppearanceToggle); expect(button.props["aria-pressed"]).toBe(false);
    button.props.onClick(); await Promise.resolve();
    expect(dataset.theme).toBe("dark"); expect(storage.get("alfred-appearance")).toBe("dark");
    button = control(AppearanceToggle); expect(button.props["aria-pressed"]).toBe(true); expect(button.props["aria-label"]).toBe("Switch to light appearance");
    button.props.onClick(); await Promise.resolve();
    expect(dataset.theme).toBeUndefined(); expect(storage.get("alfred-appearance")).toBe("light");
  });

  it("keeps the current-visit choice usable when browser storage is blocked", async () => {
    vi.stubGlobal("localStorage", { setItem: () => { throw new Error("Synthetic storage denied"); } });
    control(AppearanceToggle).props.onClick(); await Promise.resolve();
    expect(dataset.theme).toBe("dark");
  });

  it("does not change preferences when their coordination lock is rejected", async () => {
    request.mockRejectedValue(new Error("Synthetic coordination unavailable"));
    control(PrivacyToggle).props.onClick(); await Promise.resolve(); await Promise.resolve();
    expect(dataset.privacy).toBeUndefined(); expect(storage.size).toBe(0);
  });
});
