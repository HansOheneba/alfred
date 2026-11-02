import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ owner: vi.fn(), cookieStore: vi.fn(), get: vi.fn(), set: vi.fn(), exportArchive: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: mocks.cookieStore }));
vi.mock("@/lib/web/api", () => ({ requireOwner: mocks.owner }));
vi.mock("@/lib/portability/service", () => ({ exportFinanceArchive: mocks.exportArchive, PortabilityUnavailable: class extends Error {} }));
import { GET, POST } from "@/app/api/portability/browser-preferences/route";
import { GET as EXPORT } from "@/app/api/portability/export/route";

const request = (body: unknown, origin = "https://app.test") => new Request("https://app.test/api/portability/browser-preferences", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
beforeEach(() => {
  vi.clearAllMocks(); mocks.owner.mockResolvedValue({ settings: { supabase: { synthetic: true } }, profile: { profileId: "synthetic-owner" } });
  mocks.get.mockReturnValue({ value: "chat" }); mocks.cookieStore.mockResolvedValue({ get: mocks.get, set: mocks.set }); mocks.exportArchive.mockResolvedValue(new Uint8Array([1, 2]));
});
describe("authenticated browser preference routes", () => {
  it("requires a signed-in owner and does not read or change cookies before authentication", async () => {
    mocks.owner.mockResolvedValue(Response.json({ ok: false }, { status: 401 }));
    expect((await GET()).status).toBe(401); expect((await POST(request({ home: "overview", expectedHome: "chat" }))).status).toBe(401); expect(mocks.cookieStore).not.toHaveBeenCalled();
  });
  it("returns only the allowlisted home value and disables caching", async () => {
    mocks.get.mockReturnValue({ value: "overview" }); const result = await GET();
    expect(await result.json()).toEqual({ ok: true, home: "overview" }); expect(result.headers.get("cache-control")).toBe("no-store"); expect(mocks.get).toHaveBeenCalledWith("alfred-home");
  });
  it("checks expected home before setting one safe, HTTP-only preference", async () => {
    const result = await POST(request({ home: "overview", expectedHome: "chat" })); expect(result.status).toBe(200);
    expect(mocks.set).toHaveBeenCalledWith("alfred-home", "overview", expect.objectContaining({ path: "/", httpOnly: true, sameSite: "lax" }));
    mocks.set.mockClear(); mocks.get.mockReturnValue({ value: "overview" });
    const stale = await POST(request({ home: "chat", expectedHome: "chat" })); expect(stale.status).toBe(409); expect(mocks.set).not.toHaveBeenCalled();
  });
  it("rejects cross-origin writes before authentication or cookie access", async () => {
    expect((await POST(request({ home: "overview", expectedHome: "chat" }, "https://other.test"))).status).toBe(403); expect(mocks.owner).not.toHaveBeenCalled();
  });
  it("rejects arbitrary fields, malformed types and oversized requests", async () => {
    for (const body of [{ home: "overview", expectedHome: "chat", token: "no" }, { home: ["overview"], expectedHome: "chat" }, { home: "https://other.test", expectedHome: "chat" }, { home: "overview" }, null, []]) expect((await POST(request(body))).status).toBe(400);
    expect((await POST(request({ home: "x".repeat(1100), expectedHome: "chat" }))).status).toBe(400); expect(mocks.set).not.toHaveBeenCalled();
  });
  it("exports validated local presentation settings with the server's HTTP-only home preference", async () => {
    mocks.get.mockReturnValue({ value: "overview" });
    const response = await EXPORT(new Request("https://app.test/api/portability/export?appearance=dark&privacy=masked")); expect(response.status).toBe(200);
    expect(mocks.exportArchive).toHaveBeenCalledWith({ synthetic: true }, "synthetic-owner", { schema: 1, appearance: "dark", privacy: "masked", home: "overview" });
  });
  it("allows direct finance export without claiming unavailable local settings and rejects malformed settings", async () => {
    await EXPORT(new Request("https://app.test/api/portability/export")); expect(mocks.exportArchive).toHaveBeenCalledWith({ synthetic: true }, "synthetic-owner", undefined);
    mocks.exportArchive.mockClear();
    for (const query of ["appearance=dark", "appearance=dark&privacy=masked&appearance=light", "appearance=javascript&privacy=visible"]) expect((await EXPORT(new Request(`https://app.test/api/portability/export?${query}`))).status).toBe(400);
    expect(mocks.exportArchive).not.toHaveBeenCalled();
  });
});
