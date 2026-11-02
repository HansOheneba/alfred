import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseSettings } from "@/lib/config";
import { resetSchemaReadyCache, schemaReady } from "@/lib/supabase/finance-capabilities";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/supabase/connection", () => ({ query: mocks.query }));

// Only the mocked query transport is used; these settings cannot reach a real project.
const settings = {
  host: "synthetic.invalid", projectRef: "synthetic-project", user: "synthetic-role",
  database: "synthetic-db", password: "",
} as unknown as SupabaseSettings;
const sql = "select true as ready /* synthetic capability A */";
beforeEach(() => mocks.query.mockReset());

describe("positive schema readiness cache", () => {
  it("reuses a positive check briefly and rechecks at expiry before accepting a changed schema", async () => {
    mocks.query.mockResolvedValueOnce([{ ready: true }]).mockResolvedValueOnce([{ ready: false }]);
    expect(await schemaReady(settings, sql, 100)).toBe(true);
    expect(await schemaReady({ ...settings }, sql, 300_099)).toBe(true);
    expect(mocks.query).toHaveBeenCalledOnce();
    expect(await schemaReady(settings, sql, 300_100)).toBe(false);
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });

  it("does not cache unavailable schemas, so a completed setup is visible on the next request", async () => {
    mocks.query.mockResolvedValueOnce([{ ready: false }]).mockResolvedValueOnce([{ ready: true }]);
    expect(await schemaReady(settings, sql, 100)).toBe(false);
    expect(await schemaReady(settings, sql, 100)).toBe(true);
    expect(await schemaReady(settings, sql, 101)).toBe(true);
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });

  it("does not cache missing or malformed readiness results", async () => {
    mocks.query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ ready: "true" }]).mockResolvedValueOnce([{ ready: true }]);
    expect(await schemaReady(settings, sql, 100)).toBe(false);
    expect(await schemaReady(settings, sql, 100)).toBe(false);
    expect(await schemaReady(settings, sql, 100)).toBe(true);
    expect(mocks.query).toHaveBeenCalledTimes(3);
  });

  it("does not turn an interrupted check into a positive result", async () => {
    mocks.query.mockRejectedValueOnce(new Error("Synthetic catalog interruption")).mockResolvedValueOnce([{ ready: true }]);
    await expect(schemaReady(settings, sql, 100)).rejects.toThrow("Synthetic catalog interruption");
    expect(await schemaReady(settings, sql, 100)).toBe(true);
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });

  it("separates capabilities by SQL, host, project, database and database role", async () => {
    mocks.query.mockResolvedValue([{ ready: true }]);
    expect(await schemaReady(settings, sql, 100)).toBe(true);
    for (const change of [
      { host: "other.synthetic.invalid" }, { projectRef: "other-synthetic-project" },
      { database: "other-synthetic-db" }, { user: "other-synthetic-role" },
    ]) expect(await schemaReady({ ...settings, ...change } as unknown as SupabaseSettings, sql, 100)).toBe(true);
    expect(await schemaReady(settings, "select true as ready /* synthetic capability B */", 100)).toBe(true);
    expect(mocks.query).toHaveBeenCalledTimes(6);
    expect(await schemaReady({ ...settings }, sql, 100)).toBe(true);
    expect(mocks.query).toHaveBeenCalledTimes(6);
  });

  it("can clear readiness between independent test or configuration lifetimes", async () => {
    mocks.query.mockResolvedValueOnce([{ ready: true }]).mockResolvedValueOnce([{ ready: false }]);
    expect(await schemaReady(settings, sql, 100)).toBe(true);
    resetSchemaReadyCache();
    expect(await schemaReady(settings, sql, 101)).toBe(false);
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });
});
