import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SupabaseSettings, UserProfile } from "@/lib/config";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  loadOwner: vi.fn(),
  loadOwnerWithReadiness: vi.fn(),
  updateTelegramId: vi.fn(),
  getClaims: vi.fn(),
  cookies: vi.fn(),
}));
vi.mock("@/lib/supabase/connection", () => ({ query: mocks.query }));
vi.mock("@/lib/accounts/supabase-directory", () => ({
  createSupabaseAccountDirectory: () => ({ loadOwner: mocks.loadOwner, loadOwnerWithReadiness: mocks.loadOwnerWithReadiness, updateTelegramId: mocks.updateTelegramId }),
}));
vi.mock("@supabase/ssr", () => ({ createServerClient: () => ({ auth: { getClaims: mocks.getClaims } }) }));
vi.mock("next/cache", () => ({ io: async () => undefined }));
vi.mock("next/headers", () => ({ cookies: mocks.cookies }));

import { openOwnerProfile } from "@/lib/accounts/settings-store";
import { getAuthUser } from "@/lib/supabase/session";
import { proxy } from "../proxy";

// Configuration, identities and rows are synthetic; every external call is intercepted above.
const settings = {} as SupabaseSettings;
const OWNER = "00000000-0000-4000-8000-000000000001";
const user = { id: OWNER, email: "fictional@example.invalid" };
const profile = { id: OWNER, preferredName: "Fictional reviewer" } as unknown as UserProfile;

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://fixture.example.invalid");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "fixture-public-key");
  vi.stubEnv("ALFRED_INVITES", "");
  mocks.cookies.mockResolvedValue({ getAll: () => [], set: vi.fn() });
});
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });

describe("installed app launch at /", () => {
  async function launch(cookie?: string) {
    const { NextRequest } = await import("next/server");
    return proxy(new NextRequest("https://fixture.example.invalid/", { headers: cookie ? { cookie } : {} }));
  }

  it("redirects a signed-in person straight to Chat without rendering the sign-in gate", async () => {
    mocks.getClaims.mockResolvedValue({ data: { claims: { sub: OWNER } } });
    const response = await launch();
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/chat");
  });

  it("honours Overview as the chosen home screen", async () => {
    mocks.getClaims.mockResolvedValue({ data: { claims: { sub: OWNER } } });
    const response = await launch("alfred-home=overview");
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/dashboard");
  });

  it("lets a signed-out visitor reach the sign-in form", async () => {
    mocks.getClaims.mockResolvedValue({ data: null });
    const response = await launch();
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});

describe("signed-in reads", () => {
  it("verifies the session from its claims without an Auth server round trip", async () => {
    mocks.getClaims.mockResolvedValue({ data: { claims: { sub: OWNER, email: user.email } } });
    expect(await getAuthUser()).toEqual(user);
    mocks.getClaims.mockResolvedValue({ data: null });
    expect(await getAuthUser()).toBeNull();
  });

  it("loads an established owner's profile and readiness together without provisioning", async () => {
    mocks.loadOwnerWithReadiness.mockResolvedValue({ profile, ready: true });
    expect(await openOwnerProfile(settings, user)).toBe(profile);
    expect(mocks.loadOwnerWithReadiness).toHaveBeenCalledExactlyOnceWith(user.id);
    expect(mocks.loadOwner).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("reads the profile again after a new invited account is created", async () => {
    vi.stubEnv("ALFRED_INVITES", user.email);
    mocks.query.mockResolvedValue([]);
    mocks.loadOwnerWithReadiness.mockResolvedValue(null);
    mocks.loadOwner.mockResolvedValue(profile);

    expect(await openOwnerProfile(settings, user)).toBe(profile);
    expect(mocks.loadOwner).toHaveBeenCalledExactlyOnceWith(user.id);
  });

  it("keeps uninvited people out", async () => {
    mocks.query.mockResolvedValue([]);
    mocks.loadOwnerWithReadiness.mockResolvedValue(null);
    expect(await openOwnerProfile(settings, user)).toBe("not_invited");
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.loadOwner).not.toHaveBeenCalled();
  });

  it.each(["updated", "locked", "taken"])("preserves invited Telegram linking when the binding result is %s", async (outcome) => {
    vi.stubEnv("ALFRED_INVITES", `${user.email}:123456789`);
    mocks.loadOwnerWithReadiness.mockResolvedValue(null);
    mocks.loadOwner.mockResolvedValue(profile);
    mocks.query.mockResolvedValue([]);
    mocks.updateTelegramId.mockResolvedValue(outcome);
    expect(await openOwnerProfile(settings, user)).toBe(profile);
    expect(mocks.updateTelegramId).toHaveBeenCalledExactlyOnceWith(OWNER, 123456789);
    expect(mocks.query).toHaveBeenCalledTimes(4);
    expect(mocks.query.mock.calls.every(([, , values]) => values[0] === OWNER)).toBe(true);
  });

  it("does not mistake a failed owner read for a new account", async () => {
    const failure = new Error("Synthetic owner read failure");
    mocks.loadOwnerWithReadiness.mockRejectedValue(failure);
    await expect(openOwnerProfile(settings, user)).rejects.toBe(failure);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.loadOwner).not.toHaveBeenCalled();
  });
});
