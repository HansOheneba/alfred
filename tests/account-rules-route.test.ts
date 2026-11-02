import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountRuleError, emptyAccountRuleState } from "@/lib/account-rules/types";

const mocks = vi.hoisted(() => ({ owner: vi.fn(), load: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/web/api", () => ({ requireOwner: mocks.owner }));
vi.mock("@/lib/account-rules/store", () => ({ loadAccountRules: mocks.load, saveAccountRuleCommand: mocks.save }));
import { GET, POST } from "@/app/api/account-rules/route";

const OWNER = "00000000-0000-4000-8000-000000000001";
const command = () => ({ type: "upsert_rule", expectedRevision: 0, requestId: "synthetic-request", rule: { id: "00000000-0000-4000-8000-000000000010", accountId: "owned-account", matchMode: "exact", merchantExact: "Synthetic Merchant", category: "Custom category" } });
const request = (body: unknown, origin?: string) => new Request("https://synthetic.invalid/api/account-rules", { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
describe("authenticated account rule API", () => {
  beforeEach(() => {
    mocks.owner.mockReset().mockResolvedValue({ profile: { profileId: OWNER }, settings: { supabase: { synthetic: true } } });
    mocks.load.mockReset().mockResolvedValue({ state: emptyAccountRuleState(OWNER), availability: "ready" });
    mocks.save.mockReset().mockResolvedValue({ state: { ...emptyAccountRuleState(OWNER), revision: 1 }, availability: "ready" });
  });
  it("reads/writes using the session owner and returns private uncached state", async () => {
    const read = await GET();
    expect(read.status).toBe(200); expect(read.headers.get("cache-control")).toBe("no-store");
    expect(mocks.load).toHaveBeenCalledWith({ synthetic: true }, OWNER);
    const saved = await POST(request(command()));
    expect(saved.status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith({ synthetic: true }, OWNER, command());
  });
  it("does not read/write data without authentication or for cross-origin requests", async () => {
    mocks.owner.mockResolvedValue(new Response("Sign in first", { status: 401 }));
    expect((await GET()).status).toBe(401);
    expect((await POST(request(command()))).status).toBe(401);
    expect(mocks.load).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
    mocks.owner.mockResolvedValue({ profile: { profileId: OWNER }, settings: { supabase: {} } });
    expect((await POST(request(command(), "https://other.invalid"))).status).toBe(403);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("rejects forged ownership, all-merchant scope without explicit confirmation, malformed JSON and oversized streams", async () => {
    expect((await POST(request({ ...command(), ownerId: "foreign" }))).status).toBe(400);
    expect((await POST(request({ ...command(), rule: { ...command().rule, matchMode: "all", merchantExact: null } }))).status).toBe(400);
    expect((await POST(new Request("https://synthetic.invalid/api/account-rules", { method: "POST", body: "{" }))).status).toBe(400);
    expect((await POST(new Request("https://synthetic.invalid/api/account-rules", { method: "POST", body: "x".repeat(16 * 1024 + 1) }))).status).toBe(413);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("reports stale/conflicting writes, missing migrations and generic failures without exposing records", async () => {
    mocks.save.mockRejectedValueOnce(new AccountRuleError("Refresh the rule revision.", "stale"));
    expect((await POST(request(command()))).status).toBe(409);
    mocks.save.mockResolvedValueOnce({ state: emptyAccountRuleState(OWNER), availability: "migration-required" });
    expect((await POST(request(command()))).status).toBe(503);
    mocks.save.mockRejectedValueOnce(new Error("private database details"));
    const result = await POST(request(command()));
    expect(result.status).toBe(500); expect(await result.text()).not.toContain("private database details");
  });
});
