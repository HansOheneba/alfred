import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const auth = vi.hoisted(() => ({ getUser: vi.fn(async () => ({ data: { user: null } })), create: vi.fn() }));
vi.mock("@supabase/ssr", () => ({ createServerClient: auth.create }));
import { AUTOMATION_PREVIEW_PATHS, automationPreviewAllowed, automationPreviewBypassesAuth } from "@/lib/preview/access";
import { proxy } from "../proxy";

beforeEach(() => {
  auth.create.mockImplementation(() => ({ auth: { getUser: auth.getUser } }));
});
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });

describe("fictional automation preview access", () => {
  it.each([
    { NODE_ENV: "production", VERCEL_ENV: "production", ALFRED_LOCAL_PREVIEW: "1" },
    { NODE_ENV: "development", VERCEL_ENV: "production", ALFRED_LOCAL_PREVIEW: "1" },
    { NODE_ENV: "production", ALFRED_LOCAL_PREVIEW: "1" },
    { NODE_ENV: "production" },
    { NODE_ENV: "development" },
    { NODE_ENV: "development", VERCEL_ENV: "unknown", ALFRED_LOCAL_PREVIEW: "1" },
    { NODE_ENV: "development", VERCEL_ENV: "", ALFRED_LOCAL_PREVIEW: "1" },
    { NODE_ENV: "unknown", ALFRED_LOCAL_PREVIEW: "1" },
    { ALFRED_LOCAL_PREVIEW: "1" },
  ])("fails closed for production or unrecognized environment %j", environment => {
    expect(automationPreviewAllowed(environment)).toBe(false);
  });
  it.each([
    { NODE_ENV: "development", ALFRED_LOCAL_PREVIEW: "1" },
    { NODE_ENV: "test", ALFRED_LOCAL_PREVIEW: "1" },
    { NODE_ENV: "development", VERCEL_ENV: "development", ALFRED_LOCAL_PREVIEW: "1" },
    { NODE_ENV: "production", VERCEL_ENV: "preview" },
  ])("permits explicitly local or Vercel preview fixtures %j", environment => {
    expect(automationPreviewAllowed(environment)).toBe(true);
  });
  it("limits the exemption to exact read-only fixture paths", () => {
    const environment = { NODE_ENV: "production", VERCEL_ENV: "preview" };
    for (const path of AUTOMATION_PREVIEW_PATHS) {
      expect(automationPreviewBypassesAuth(path, "GET", environment)).toBe(true);
      expect(automationPreviewBypassesAuth(path, "HEAD", environment)).toBe(true);
      expect(automationPreviewBypassesAuth(path, "POST", environment)).toBe(false);
    }
    for (const path of ["/settings", "/chat", "/api/notifications", "/api/ingest/sms", "/preview", "/preview/other", "/preview/automations/", "/preview/automations/private", "/preview/automations?target=/settings", "/preview/%61utomations"]) {
      expect(automationPreviewBypassesAuth(path, "GET", environment)).toBe(false);
    }
  });
});

describe("preview proxy keeps real auth untouched", () => {
  function environment(kind = "preview") {
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("VERCEL_ENV", kind);
    vi.stubEnv("ALFRED_LOCAL_PREVIEW", "1");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://fixture.example.invalid");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "fixture-public-key");
  }
  function fixtureRequest(path: string, method = "GET"): NextRequest {
    // Throwing accessors prove the early return never reads credentials or
    // constructs a client, even if a browser happens to have session cookies.
    return {
      nextUrl: new URL(`https://fixture.example.invalid${path}`), method,
      get headers() { throw Error("Fixture auth bypass must not inspect headers"); },
      get cookies() { throw Error("Fixture auth bypass must not inspect cookies"); },
    } as unknown as NextRequest;
  }
  it.each([...AUTOMATION_PREVIEW_PATHS])("bypasses all auth/session work for %s", async path => {
    environment();
    const response = await proxy(fixtureRequest(path));
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(auth.create).not.toHaveBeenCalled(); expect(auth.getUser).not.toHaveBeenCalled();
  });
  it("ignores routing-like query values on the fixed fictional page", async () => {
    environment();
    await proxy(fixtureRequest("/preview/automations?next=/api/notifications&ownerId=fixture"));
    expect(auth.create).not.toHaveBeenCalled();
  });
  it.each([
    ["preview", "/settings", "GET"], ["preview", "/api/notifications", "GET"],
    ["preview", "/preview/other", "GET"], ["preview", "/preview/automations", "POST"],
    ["production", "/preview/automations", "GET"], ["unknown", "/preview/automations", "GET"],
  ])("retains normal auth for %s %s %s", async (kind, path, method) => {
    environment(kind);
    const { NextRequest } = await import("next/server");
    const request = new NextRequest(`https://fixture.example.invalid${path}`, { method });
    await proxy(request);
    expect(auth.create).toHaveBeenCalledTimes(1); expect(auth.getUser).toHaveBeenCalledTimes(1);
  });
});
