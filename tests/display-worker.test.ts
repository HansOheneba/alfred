import { describe, expect, it, vi } from "vitest";
import { ALFRED_SUPABASE_HOST, ALFRED_SUPABASE_PROJECT_REF, ALFRED_SUPABASE_USER, type SupabaseSettings } from "@/lib/config";
import { ensureFreshDisplay, runDisplayWorker, type DisplayWorkerDependencies } from "@/lib/finance/accounting/display-worker";
import { buildAccountingDisplayModel } from "@/lib/finance/accounting/display-builder";
import { ACCOUNTING_DISPLAY_DEFINITION } from "@/lib/finance/accounting/display-model";
import { emptyAccountingState } from "@/lib/finance/accounting/types";
import type { AccountingResult } from "@/lib/finance/accounting/persisted-store";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", LEASE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const settings: SupabaseSettings = { host: ALFRED_SUPABASE_HOST, projectRef: ALFRED_SUPABASE_PROJECT_REF, user: ALFRED_SUPABASE_USER, database: "postgres", password: "fictional-only" };
const baseline = { token: "9007199254740993", publishRevision: "9007199254740994", epoch: "0", events: ["9007199254740995"] };
function harness(overrides: { source?: AccountingResult; publish?: string; clock?: () => number } = {}) {
  const source: AccountingResult = overrides.source ?? { state: emptyAccountingState(OWNER), availability: "ready", sourceVersion: "fictional-source-version", rawTransactions: [] };
  const load = vi.fn(async () => source), build = vi.fn(buildAccountingDisplayModel);
  const execute = vi.fn(async (_settings: SupabaseSettings, sql: string) => {
    if (sql.includes("readiness")) return [{ ready: true }];
    if (sql.includes(".claim")) return [{ result: { ownerId: OWNER, definition: ACCOUNTING_DISPLAY_DEFINITION, leaseToken: LEASE } }];
    if (sql.includes(".capture")) return [{ result: baseline }];
    if (sql.includes(".publish")) return [{ result: { status: overrides.publish ?? "saved" } }];
    if (sql.includes(".fail")) return [{ result: { status: "released" } }];
    throw new Error("Unexpected worker query");
  });
  const deps: Partial<DisplayWorkerDependencies> = { execute: execute as DisplayWorkerDependencies["execute"], load, build, leaseToken: () => LEASE, now: overrides.clock ?? (() => 0) };
  return { deps, execute, load, build };
}
function calls(h: ReturnType<typeof harness>, fragment: string) { return h.execute.mock.calls.filter(call => call[1].includes(fragment)); }

describe("durable display worker orchestration", () => {
  it("publishes one complete canonical model, keeping opaque bigint tokens exact", async () => {
    const h = harness();
    expect(await runDisplayWorker(settings, {}, h.deps)).toEqual({ claimed: 1, published: 1, stale: 0, failed: 0, idle: false });
    expect(h.load).toHaveBeenCalledExactlyOnceWith(settings, OWNER);
    const publication = calls(h, ".publish")[0] as unknown[];
    const values = publication[2] as unknown[];
    expect(JSON.parse(values[3] as string)).toEqual(baseline);
    expect(JSON.parse(values[4] as string)).toMatchObject({ ownerId: OWNER, sourceVersion: "fictional-source-version", revision: 0 });
    expect(calls(h, ".fail")).toHaveLength(0);
    expect(h.execute.mock.calls.every(call => !/alfred_write|commit|rollback/i.test(call[1]))).toBe(true);
  });

  it("claims only the requested owner for a lazy page rebuild", async () => {
    const h = harness();
    expect((await runDisplayWorker(settings, { ownerId: OWNER }, h.deps)).published).toBe(1);
    expect((calls(h, ".claim_owner")[0] as unknown[])[2]).toEqual([OWNER, ACCOUNTING_DISPLAY_DEFINITION, LEASE, 120]);
    expect(h.load).toHaveBeenCalledExactlyOnceWith(settings, OWNER);
  });

  it("rejects a valid lease belonging to another owner on an inline rebuild", async () => {
    const h = harness(), original = h.execute.getMockImplementation()!;
    h.execute.mockImplementation(async (cfg, sql) => sql.includes(".claim") ? [{ result: { ownerId: OTHER, definition: ACCOUNTING_DISPLAY_DEFINITION, leaseToken: LEASE } }] as unknown as Awaited<ReturnType<typeof original>> : original(cfg, sql));
    await expect(runDisplayWorker(settings, { ownerId: OWNER }, h.deps)).rejects.toThrow("lease could not be verified");
    expect(h.load).not.toHaveBeenCalled(); expect(calls(h, ".fail")).toHaveLength(0);
  });

  it("finishes capture before invoking the canonical loader", async () => {
    const h = harness();
    let resolve!: (value: unknown[]) => void;
    const pending = new Promise<unknown[]>(yes => { resolve = yes; });
    const original = h.execute.getMockImplementation()!;
    h.execute.mockImplementation((cfg, sql) => sql.includes(".capture") ? pending as ReturnType<typeof original> : original(cfg, sql));
    const result = runDisplayWorker(settings, {}, h.deps);
    await vi.waitFor(() => expect(calls(h, ".capture")).toHaveLength(1));
    expect(h.load).not.toHaveBeenCalled();
    resolve([{ result: baseline }]);
    expect((await result).published).toBe(1);
  });

  it("does not report an uninstalled or drifting schema as an idle successful worker", async () => {
    const h = harness(); h.execute.mockResolvedValue([{ ready: false }]);
    await expect(runDisplayWorker(settings, {}, h.deps)).rejects.toThrow("not ready");
    expect(h.load).not.toHaveBeenCalled();
  });

  it("leaves an idle queue alone without reading any financial history", async () => {
    const h = harness(), original = h.execute.getMockImplementation()!;
    h.execute.mockImplementation(async (cfg, sql) => sql.includes(".claim") ? [{ result: null }] as unknown as Awaited<ReturnType<typeof original>> : original(cfg, sql));
    expect(await runDisplayWorker(settings, {}, h.deps)).toEqual({ claimed: 0, published: 0, stale: 0, failed: 0, idle: true });
    expect(h.load).not.toHaveBeenCalled();
  });

  it("does not use an unverified owner/lease acknowledgement", async () => {
    const h = harness(), original = h.execute.getMockImplementation()!;
    h.execute.mockImplementation(async (cfg, sql) => sql.includes(".claim") ? [{ result: { ownerId: OWNER, definition: ACCOUNTING_DISPLAY_DEFINITION, leaseToken: OTHER } }] as unknown as Awaited<ReturnType<typeof original>> : original(cfg, sql));
    await expect(runDisplayWorker(settings, {}, h.deps)).rejects.toThrow("lease could not be verified");
    expect(h.load).not.toHaveBeenCalled(); expect(calls(h, ".fail")).toHaveLength(0);
  });

  it("refuses wrong-owner canonical data and records only a generic failure code", async () => {
    const h = harness({ source: { state: emptyAccountingState(OTHER), availability: "ready", sourceVersion: "other", rawTransactions: [] } });
    expect((await runDisplayWorker(settings, {}, h.deps)).failed).toBe(1);
    expect(h.build).not.toHaveBeenCalled(); expect(calls(h, ".publish")).toHaveLength(0);
    expect((calls(h, ".fail")[0] as unknown[])[2]).toEqual([OWNER, LEASE, "build_failed"]);
  });

  it("releases a stale cohort for later rebuilding without retrying publication", async () => {
    const h = harness({ publish: "stale" });
    expect((await runDisplayWorker(settings, {}, h.deps)).stale).toBe(1);
    expect(calls(h, ".publish")).toHaveLength(1);
    expect((calls(h, ".fail")[0] as unknown[])[2]).toEqual([OWNER, LEASE, "changed"]);
  });

  it("does not replay an uncertain publication or include source/error details in failure metadata", async () => {
    const h = harness(), original = h.execute.getMockImplementation()!;
    h.execute.mockImplementation(async (cfg, sql) => { if (sql.includes(".publish")) throw new Error("Sensitive fictional financial error"); return original(cfg, sql); });
    expect((await runDisplayWorker(settings, {}, h.deps)).failed).toBe(1);
    expect(calls(h, ".publish")).toHaveLength(1);
    expect((calls(h, ".fail")[0] as unknown[])[2]).toEqual([OWNER, LEASE, "publication_failed"]);
  });

  it("does not publish a result once its invocation budget is exhausted", async () => {
    let tick = 0; const h = harness({ clock: () => tick });
    h.load.mockImplementation(async () => { tick = 50_001; return { state: emptyAccountingState(OWNER), availability: "ready", sourceVersion: "source", rawTransactions: [] }; });
    expect((await runDisplayWorker(settings, {}, h.deps)).stale).toBe(1);
    expect(calls(h, ".publish")).toHaveLength(0);
  });
});

describe("lazy durable display freshness", () => {
  it("rebuilds once with an owner lease and lets the reader requery its own fresh snapshot", async () => {
    const run = vi.fn(async () => ({ claimed: 1, published: 1, stale: 0, failed: 0, idle: false })), execute = vi.fn();
    expect(await ensureFreshDisplay(settings, OWNER, { run, execute })).toBe(true);
    expect(run).toHaveBeenCalledExactlyOnceWith(settings, { ownerId: OWNER, maxOwners: 1, budgetMs: 15_000 });
    expect(execute).not.toHaveBeenCalled();
  });

  it("awaits another owner's worker only through cheap owner-scoped manifest checks", async () => {
    const run = vi.fn(async () => ({ claimed: 0, published: 0, stale: 0, failed: 0, idle: true }));
    const execute = vi.fn().mockResolvedValueOnce([{ result: null }]).mockResolvedValueOnce([{ result: { token: "1" } }]);
    const pause = vi.fn(async () => undefined);
    expect(await ensureFreshDisplay(settings, OWNER, { run, execute, pause, now: () => 0 })).toBe(true);
    expect(run).toHaveBeenCalledOnce(); expect(pause).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenLastCalledWith(settings, "select alfred_display.manifest($1::uuid,$2::text) as result", [OWNER, ACCOUNTING_DISPLAY_DEFINITION]);
  });

  it("bounds busy-lease waits and never treats a failed publication as current", async () => {
    const run = vi.fn(async () => ({ claimed: 0, published: 0, stale: 0, failed: 0, idle: true }));
    const execute = vi.fn().mockResolvedValue([{ result: null }]), pause = vi.fn(async () => undefined);
    expect(await ensureFreshDisplay(settings, OWNER, { run, execute, pause, now: () => 0 })).toBe(false);
    expect(execute).toHaveBeenCalledTimes(20);
    run.mockResolvedValueOnce({ claimed: 1, published: 0, stale: 0, failed: 1, idle: false });
    execute.mockClear();
    expect(await ensureFreshDisplay(settings, OWNER, { run, execute, pause })).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });
});
