import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ query: vi.fn(), allow: vi.fn() }));
vi.mock("@/lib/supabase/connection", () => ({ query: mocks.query }));
vi.mock("@/lib/env", () => ({ getDatabaseSettings: () => ({ projectRef: "fixture" }) }));
vi.mock("@/lib/bank/collector-requests", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/bank/collector-requests")>(), collectorRequestAllowed: mocks.allow,
}));
import { GET } from "@/app/api/collector/account/route";
import { collectorAccount } from "@/lib/bank/collector-account";
import { hashIngestToken } from "@/lib/bank/store";
import type { SupabaseSettings } from "@/lib/config";

const ownerId = "11111111-1111-4111-8111-111111111111";
const token = "alf_" + "x".repeat(24);
const settings = { projectRef: "fixture" } as unknown as SupabaseSettings;
const account = () => ({ owner_id: ownerId, preferred_name: "Fictional reviewer", email: "reviewer@example.invalid" });
const request = (header = `Bearer ${token}`, suffix = "") => new Request("https://alfred.test/api/collector/account" + suffix, { headers: { authorization: header } });
beforeEach(() => { mocks.query.mockResolvedValue([account()]); mocks.allow.mockResolvedValue(true); vi.spyOn(console, "info").mockImplementation(() => {}); });
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

describe("private collector account connection check", () => {
  it("returns just the key owner's recognizable identity without changing delivery metadata", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, identityProtocol: 1, account: { ownerId, preferredName: "Fictional reviewer", email: "reviewer@example.invalid" } });
    const [, sql, params] = mocks.query.mock.calls[0];
    expect(sql.trim().startsWith("select ")).toBe(true);
    expect(sql).not.toMatch(/\b(update|insert|delete|last_used_at|last_empty_at|transactions|bank_messages)\b/i);
    expect(params).toEqual([hashIngestToken(token)]);
    expect(JSON.stringify(mocks.query.mock.calls)).not.toContain(token);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Authorization");
  });
  it.each(["", "Bearer wrong", `Bearer ${token} extra`, `Basic ${token}`, `Bearer ${"alf_" + "x".repeat(65)}`])("rejects malformed authentication without a lookup", async (header) => {
    expect((await GET(request(header))).status).toBe(401);
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it("does not accept account IDs or credentials in URL parameters", async () => {
    const response = await GET(request(`Bearer ${token}`, "?ownerId=other"));
    expect(response.status).toBe(400); expect(mocks.query).not.toHaveBeenCalled();
  });
  it("does not use a signed-in cookie in place of the collector key", async () => {
    const response = await GET(new Request("https://alfred.test/api/collector/account", { headers: { cookie: "fictional-owner-session" } }));
    expect(response.status).toBe(401); expect(mocks.query).not.toHaveBeenCalled();
  });
  it("returns no identity for a revoked or unknown key", async () => {
    mocks.query.mockResolvedValue([]);
    const response = await GET(request());
    expect(response.status).toBe(401); expect(await response.text()).not.toContain("@example");
  });
  it("rejects ambiguous key ownership instead of choosing an account", async () => {
    mocks.query.mockResolvedValue([account(), { ...account(), owner_id: "22222222-2222-4222-8222-222222222222" }]);
    expect((await GET(request())).status).toBe(401);
  });
  it("keeps credential, database errors and account details out of errors and logs", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {}), error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.query.mockRejectedValue(new Error(`${token} private-database-detail reviewer@example.invalid`));
    const response = await GET(request());
    const body = await response.text();
    expect(response.status).toBe(503); expect(body).not.toMatch(/alf_|private-database|reviewer@example/);
    expect(info).toHaveBeenCalledWith(JSON.stringify({ level: "info", event: "collector_request_rejected", endpoint: "account", reason: "unavailable" }));
    expect(error).not.toHaveBeenCalled();
  });
  it("removes terminal-control and invisible formatting from the displayed name", async () => {
    mocks.query.mockResolvedValue([{ ...account(), preferred_name: "\u001bSample\u202ereviewer\n" }]);
    expect((await collectorAccount(settings, token))?.preferredName).toBe("Sample reviewer");
  });
  it.each([null, "invalid", "bad\n@example.invalid", "bad\u202e@example.invalid", "<script>@example.invalid"])("fails closed for an unusable email identity", async (email) => {
    mocks.query.mockResolvedValue([{ ...account(), email }]);
    expect((await GET(request())).status).toBe(401);
  });
  it("does not return accidental extra database fields", async () => {
    mocks.query.mockResolvedValue([{ ...account(), token_hash: "never-serialize", raw: "never-serialize" }]);
    expect(await (await GET(request())).text()).not.toContain("never-serialize");
  });
  it.each([`Bearer ${token}`, "Bearer wrong", ""])("throttles requests before identity lookup for %s", async header => {
    mocks.allow.mockResolvedValue(false);
    const response = await GET(request(header));
    expect(response.status).toBe(429);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(await response.text()).not.toMatch(/alf_|reviewer@example/);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it("fails closed when throttling storage is unavailable", async () => {
    mocks.allow.mockRejectedValue(Error(`${token} reviewer@example.invalid private-backend`));
    const response = await GET(request());
    expect(response.status).toBe(503); expect(mocks.query).not.toHaveBeenCalled();
    expect(await response.text()).not.toMatch(/alf_|reviewer@example|private-backend/);
  });
  it("records fixed reasons for rejected keys without identity or request metadata", async () => {
    const info = vi.spyOn(console, "info");
    await GET(request("Bearer wrong"));
    mocks.query.mockResolvedValue([]); await GET(request());
    expect(info.mock.calls.map(call => JSON.parse(call[0]))).toEqual([
      { level: "info", event: "collector_request_rejected", endpoint: "account", reason: "missing_or_malformed_key" },
      { level: "info", event: "collector_request_rejected", endpoint: "account", reason: "invalid_key" },
    ]);
  });
});
