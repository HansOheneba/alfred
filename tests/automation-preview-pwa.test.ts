import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const browser = vi.hoisted(() => ({ path: "/settings" as string | null, effects: [] as (() => void)[] }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useEffect: (setup: () => void) => { browser.effects.push(setup); } }));
vi.mock("next/navigation", () => ({ usePathname: () => browser.path }));
import { PwaRegister } from "@/app/components/pwa";
import { AUTOMATION_PREVIEW_PATHS } from "@/lib/preview/access";

beforeEach(() => { browser.effects = []; vi.stubEnv("NODE_ENV", "production"); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function mount(path: string | null) {
  browser.path = path;
  const register = vi.fn(async () => ({})), unregister = vi.fn();
  vi.stubGlobal("navigator", { serviceWorker: { register, unregister } });
  expect(renderToStaticMarkup(createElement(PwaRegister))).not.toContain("script");
  for (const setup of browser.effects) setup();
  return { register, unregister };
}

describe("fictional previews never initiate PWA registration", () => {
  it.each([...AUTOMATION_PREVIEW_PATHS])("leaves browser workers untouched on %s", path => {
    const { register, unregister } = mount(path);
    expect(register).not.toHaveBeenCalled(); expect(unregister).not.toHaveBeenCalled();
  });
  it("waits for a known pathname without changing browser state", () => {
    const { register, unregister } = mount(null);
    expect(register).not.toHaveBeenCalled(); expect(unregister).not.toHaveBeenCalled();
  });
  it.each(["/", "/settings", "/chat", "/preview/other", "/preview/automations/private"])("retains existing production registration on %s", path => {
    const { register, unregister } = mount(path);
    expect(register).toHaveBeenCalledExactlyOnceWith("/sw.js", { scope: "/", updateViaCache: "none" });
    expect(unregister).not.toHaveBeenCalled();
  });
  it("retains the existing nonproduction no-registration behavior", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(mount("/settings").register).not.toHaveBeenCalled();
  });
});
