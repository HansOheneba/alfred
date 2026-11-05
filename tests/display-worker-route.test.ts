import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ enabled: vi.fn(), run: vi.fn(), status: vi.fn(), settings: vi.fn() }));
vi.mock("@/lib/finance/accounting/display-worker", () => ({ displayWorkerEnabled: mocks.enabled, runDisplayWorker: mocks.run, readDisplayWorkerStatus: mocks.status }));
vi.mock("@/lib/env", () => ({ getDatabaseSettings: mocks.settings }));
import { GET } from "@/app/api/cron/display/route";

beforeEach(() => { vi.stubEnv("CRON_SECRET", "fictional-cron-secret"); mocks.enabled.mockReset().mockReturnValue(true); mocks.run.mockReset().mockResolvedValue({ claimed: 0, published: 0, stale: 0, failed: 0, idle: true }); mocks.status.mockReset().mockResolvedValue({ ready: true }); mocks.settings.mockReset().mockReturnValue({ fictional: true }); });
afterEach(() => { vi.unstubAllEnvs(); });
const request = (authorization = "Bearer fictional-cron-secret") => new Request("https://example.test/api/cron/display", { headers: { authorization } });
describe("authenticated display worker endpoint", () => {
  it("rejects missing/wrong secrets before database access", async () => {
    expect((await GET(request("Bearer wrong"))).status).toBe(401);
    vi.stubEnv("CRON_SECRET", ""); expect((await GET(request())).status).toBe(401);
    expect(mocks.settings).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled();
  });
  it("keeps the worker disabled until explicitly configured", async () => {
    mocks.enabled.mockReturnValue(false); expect((await GET(request())).status).toBe(503);
    expect(mocks.settings).not.toHaveBeenCalled();
  });
  it("awaits one bounded owner cycle and reports database health without caching", async () => {
    const response = await GET(request()); expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.run).toHaveBeenCalledWith({ fictional: true }, { maxOwners: 1 });
    expect(await response.json()).toMatchObject({ ok: true, idle: true, status: { ready: true } });
  });
  it("reports failed or schema-unready cycles as unavailable", async () => {
    mocks.run.mockResolvedValue({ failed: 1 }); expect((await GET(request())).status).toBe(503);
    mocks.run.mockResolvedValue({ failed: 0 }); mocks.status.mockResolvedValue({ ready: false }); expect((await GET(request())).status).toBe(503);
  });
  it("does not return database/source error details or trigger a second cycle", async () => {
    mocks.run.mockRejectedValue(new Error("Sensitive fictional ledger error")); const response = await GET(request());
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ ok: false, code: "worker_unavailable" }); expect(mocks.run).toHaveBeenCalledOnce();
  });
});
