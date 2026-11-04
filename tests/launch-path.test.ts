import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SupabaseSettings, UserProfile } from "@/lib/config";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  loadOwner: vi.fn(),
  getClaims: vi.fn(),
  cookies: vi.fn(),
}));
vi.mock("@/lib/supabase/connection", () => ({ query: mocks.query }));
vi.mock("@/lib/accounts/supabase-directory", () => ({
  createSupabaseAccountDirectory: () => ({ loadOwner: mocks.loadOwner, updateTelegramId: vi.fn() }),
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
const completeAccount = { id: OWNER, telegram_ready: true, conversation_ready: true, reminders_ready: true };

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

  it("starts the account check and profile read together for an existing account", async () => {
    let releaseAccount: (rows: unknown[]) => void = () => undefined;
    mocks.query.mockReturnValueOnce(new Promise((resolve) => { releaseAccount = resolve; }));
    mocks.loadOwner.mockResolvedValue(profile);

    const opening = openOwnerProfile(settings, user);
    await Promise.resolve();
    expect(mocks.loadOwner).toHaveBeenCalledTimes(1);
    releaseAccount([completeAccount]);

    expect(await opening).toBe(profile);
    expect(mocks.loadOwner).toHaveBeenCalledTimes(1);
  });

  it("reads the profile again after a new invited account is created", async () => {
    vi.stubEnv("ALFRED_INVITES", user.email);
    mocks.query.mockResolvedValue([]);
    mocks.loadOwner.mockResolvedValueOnce(null).mockResolvedValueOnce(profile);

    expect(await openOwnerProfile(settings, user)).toBe(profile);
    expect(mocks.loadOwner).toHaveBeenCalledTimes(2);
  });

  it("keeps uninvited people out", async () => {
    mocks.query.mockResolvedValue([]);
    mocks.loadOwner.mockResolvedValue(null);
    expect(await openOwnerProfile(settings, user)).toBe("not_invited");
  });
});
