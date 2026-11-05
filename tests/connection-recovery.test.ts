import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALFRED_SUPABASE_HOST, ALFRED_SUPABASE_PROJECT_REF, ALFRED_SUPABASE_USER, type SupabaseSettings } from "@/lib/config";

const fixture = vi.hoisted(() => ({ connect: vi.fn(), resolve4: vi.fn(), pools: [] as unknown[] }));
vi.mock("node:dns/promises", () => ({ resolve4: fixture.resolve4 }));
vi.mock("pg", async (importOriginal) => {
  const actual = await importOriginal<typeof import("pg")>();
  const { EventEmitter } = await import("node:events");
  class Pool extends EventEmitter {
    end = vi.fn(async () => undefined);
    constructor(readonly config: Record<string, unknown>) { super(); fixture.pools.push(this); }
    connect() { return fixture.connect(this.config, this); }
    async query(sql: string, values: unknown[]) {
      const client = await this.connect();
      try { return await client.query(sql, values); } finally { client.release(); }
    }
  }
  return { ...actual, Pool };
});

const settings: SupabaseSettings = { projectRef: ALFRED_SUPABASE_PROJECT_REF, host: ALFRED_SUPABASE_HOST, user: ALFRED_SUPABASE_USER, database: "postgres", password: "fictional-test-password" };
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function client(label = "fictional-row") {
  type Query = (sql: string, values?: unknown[]) => Promise<{ rows: { label: string }[] }>;
  return Object.assign(new EventEmitter(), { query: vi.fn<Query>(async () => ({ rows: [{ label }] })), release: vi.fn() });
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
let api: typeof import("@/lib/supabase/connection");
beforeEach(async () => {
  vi.resetModules(); fixture.connect.mockReset(); fixture.resolve4.mockReset(); fixture.pools.length = 0;
  fixture.resolve4.mockResolvedValue(["192.0.2.10"]);
  fixture.connect.mockImplementation(async () => client());
  api = await import("@/lib/supabase/connection");
});
afterEach(() => { vi.useRealTimers(); });

describe("connection acquisition recovery", () => {
  it("lets a healthy saturated pool wait beyond the connection-attempt timeout", async () => {
    vi.useFakeTimers();
    await api.query(settings, "select warm");
    const pool = fixture.pools[0] as { totalCount: number; idleCount: number; end: ReturnType<typeof vi.fn>; config: Record<string, unknown> };
    Object.assign(pool, { totalCount: 3, idleCount: 0 });
    const available = client("after-existing-work");
    fixture.connect.mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(available), 3_000)));
    const result = api.query(settings, "select queued");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(pool.end).not.toHaveBeenCalled();
    expect(fixture.pools).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toEqual([{ label: "after-existing-work" }]);
    expect(available.query).toHaveBeenCalledExactlyOnceWith("select queued", []);
    expect(fixture.resolve4).toHaveBeenCalledOnce();
    expect(pool.config.connectionTimeoutMillis).toBe(8_000);
  });

  it("bounds a busy queue without retiring its pool or losing the next healthy checkout", async () => {
    vi.useFakeTimers();
    await api.query(settings, "select warm");
    const pool = fixture.pools[0] as { totalCount: number; idleCount: number; end: ReturnType<typeof vi.fn> };
    Object.assign(pool, { totalCount: 3, idleCount: 0 });
    const waiting = deferred<ReturnType<typeof client>>(), late = client("late-unused");
    fixture.connect.mockReturnValueOnce(waiting.promise);
    const result = api.query(settings, "select must-not-run").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await result).toMatchObject({ message: expect.stringContaining("timeout exceeded") });
    expect(pool.end).not.toHaveBeenCalled();
    expect(fixture.pools).toHaveLength(1);
    waiting.resolve(late);
    await vi.advanceTimersByTimeAsync(0);
    expect(late.query).not.toHaveBeenCalled();
    expect(late.release).toHaveBeenCalledExactlyOnceWith(false);
    pool.idleCount = 1;
    expect(await api.query(settings, "select recovered")).toEqual([{ label: "fictional-row" }]);
    expect(fixture.resolve4).toHaveBeenCalledOnce();
    expect(fixture.pools).toHaveLength(1);
  });

  it("preserves other active clients when one additional connection attempt times out", async () => {
    vi.useFakeTimers();
    await api.query(settings, "select warm");
    const pool = fixture.pools[0] as { totalCount: number; idleCount: number; end: ReturnType<typeof vi.fn> };
    Object.assign(pool, { totalCount: 2, idleCount: 0 });
    const waiting = deferred<ReturnType<typeof client>>(), recovered = client("fallback"), late = client("late-unused");
    fixture.connect.mockReturnValueOnce(waiting.promise).mockResolvedValueOnce(recovered);
    const result = api.query(settings, "select safe-fallback");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await result).toEqual([{ label: "fallback" }]);
    expect(pool.end).not.toHaveBeenCalled();
    waiting.resolve(late);
    await vi.advanceTimersByTimeAsync(0);
    expect(late.release).toHaveBeenCalledExactlyOnceWith(false);
    expect(late.query).not.toHaveBeenCalled();
    expect(fixture.resolve4).toHaveBeenCalledOnce();
  });

  it("recovers the exact uncoded pg-pool checkout timeout before executing SQL", async () => {
    vi.useFakeTimers();
    const recovered = client();
    fixture.connect.mockImplementationOnce(() => new Promise((_, reject) => {
      setTimeout(() => reject(new Error("timeout exceeded when trying to connect")), 8_000);
    })).mockResolvedValueOnce(recovered);
    const start = Date.now();
    const result = api.query(settings, "select fictional", [owner]).then((rows) => ({ rows, elapsed: Date.now() - start }));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await result).toEqual({ rows: [{ label: "fictional-row" }], elapsed: 2_000 });
    expect(fixture.connect).toHaveBeenCalledTimes(2);
    expect(recovered.query).toHaveBeenCalledExactlyOnceWith("select fictional", [owner]);
    expect(recovered.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("reproduces pg-pool's real uncoded 8-second saturated checkout error without a database", async () => {
    vi.useFakeTimers();
    const { Pool } = await vi.importActual<typeof import("pg")>("pg");
    class SyntheticClient extends EventEmitter {
      _queryable = true;
      _ending = false;
      connect(callback: (error?: Error) => void) { callback(); }
      end(callback?: () => void) { callback?.(); }
    }
    const pool = new Pool({ max: 1, connectionTimeoutMillis: 8_000, idleTimeoutMillis: 0, Client: SyntheticClient } as never);
    const held = await pool.connect();
    const start = Date.now();
    const attempt = pool.connect();
    const rejection = expect(attempt).rejects.toMatchObject({ message: "timeout exceeded when trying to connect" });
    await vi.advanceTimersByTimeAsync(8_000);
    await rejection;
    const error = await attempt.catch((value: unknown) => value);
    expect(error).not.toHaveProperty("code");
    expect(Date.now() - start).toBe(8_000);
    held.release(); await pool.end();
  });

  it.each([
    new Error("timeout exceeded when trying to connect"),
    new Error("Connection terminated due to connection timeout"),
    new Error("Connection terminated unexpectedly"),
    Object.assign(new Error("fictional pooler restart"), { code: "08006" }),
    Object.assign(new Error("fictional refused connection"), { code: "ECONNREFUSED" }),
    new Error("max clients reached"),
  ])("tries a healthy fallback only after acquisition fails: %s", async (error) => {
    const recovered = client();
    fixture.connect.mockRejectedValueOnce(error).mockResolvedValueOnce(recovered);
    expect(await api.query(settings, "insert fictional returning id")).toEqual([{ label: "fictional-row" }]);
    expect(fixture.connect).toHaveBeenCalledTimes(2);
    expect(recovered.query).toHaveBeenCalledExactlyOnceWith("insert fictional returning id", []);
    expect((fixture.pools[0] as { end: ReturnType<typeof vi.fn> }).end).toHaveBeenCalledOnce();
  });

  it.each([
    ["ETIMEDOUT", "fictional lost write response"],
    ["ECONNRESET", "fictional reset after SQL"],
    ["08006", "fictional unknown commit outcome"],
    [undefined, "timeout exceeded when trying to connect"],
    [undefined, "max clients reached"],
    ["23505", "fictional duplicate"],
  ])("never replays SQL after execution starts, including %s", async (code, message) => {
    const checked = client();
    checked.query.mockRejectedValueOnce(Object.assign(new Error(message), code ? { code } : {}));
    fixture.connect.mockResolvedValue(checked);
    await expect(api.query(settings, "insert fictional returning id", [owner])).rejects.toThrow(message);
    expect(fixture.connect).toHaveBeenCalledOnce();
    expect(checked.query).toHaveBeenCalledExactlyOnceWith("insert fictional returning id", [owner]);
    expect(checked.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(checked.listenerCount("error")).toBe(0);
  });

  it("evicts an unusable pool after uncertain SQL for the next request, without replaying the failed write", async () => {
    const failed = client(), fresh = client("next-request");
    failed.query.mockRejectedValueOnce(Object.assign(new Error("fictional disconnected write"), { code: "ECONNRESET" }));
    fixture.connect.mockResolvedValueOnce(failed).mockResolvedValueOnce(fresh);
    await expect(api.query(settings, "insert fictional")).rejects.toThrow("disconnected write");
    expect(await api.query(settings, "select fresh")).toEqual([{ label: "next-request" }]);
    expect(fixture.pools).toHaveLength(2);
    expect(fixture.resolve4).toHaveBeenCalledTimes(2);
    expect(failed.query).toHaveBeenCalledOnce();
    expect(fresh.query).toHaveBeenCalledExactlyOnceWith("select fresh", []);
  });

  it("handles a checked-out client's asynchronous error without retrying its SQL", async () => {
    const checked = client(), entered = deferred<void>();
    checked.query.mockImplementationOnce(() => { entered.resolve(); return new Promise(() => undefined); });
    fixture.connect.mockResolvedValueOnce(checked);
    const attempt = api.query(settings, "insert fictional").catch((error: unknown) => error);
    await entered.promise;
    checked.emit("error", Object.assign(new Error("fictional lost response"), { code: "ECONNRESET" }));
    expect(await attempt).toMatchObject({ message: expect.stringContaining("fictional lost response") });
    expect(fixture.connect).toHaveBeenCalledOnce();
    expect(checked.query).toHaveBeenCalledOnce();
    expect(checked.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("bounds all acquisition attempts, including DNS, to 8 seconds and never sends SQL on timeout", async () => {
    vi.useFakeTimers();
    fixture.resolve4.mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve(["192.0.2.1", "192.0.2.2", "192.0.2.3", "192.0.2.4"]), 1_000)));
    fixture.connect.mockImplementation(() => new Promise(() => undefined));
    const start = Date.now();
    const attempt = api.query(settings, "insert forbidden").catch((error: unknown) => ({ error, elapsed: Date.now() - start }));
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await attempt).toMatchObject({ error: { message: expect.stringContaining("timeout exceeded") }, elapsed: 8_000 });
    expect(fixture.connect).toHaveBeenCalledTimes(4);
    for (const pool of fixture.pools as { end: ReturnType<typeof vi.fn> }[]) expect(pool.end).toHaveBeenCalledOnce();
  });

  it("destroys a client that arrives after its checkout timed out, without SQL or leaking a slot", async () => {
    vi.useFakeTimers();
    const late = client("late"), recovered = client("recovered"), delayed = deferred<ReturnType<typeof client>>();
    fixture.connect.mockReturnValueOnce(delayed.promise).mockResolvedValueOnce(recovered);
    const attempt = api.query(settings, "select fictional");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await attempt).toEqual([{ label: "recovered" }]);
    delayed.resolve(late);
    await vi.advanceTimersByTimeAsync(0);
    expect(late.query).not.toHaveBeenCalled();
    expect(late.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(recovered.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("does not let a late DNS lookup replace a newer healthy answer", async () => {
    vi.useFakeTimers();
    const oldDns = deferred<string[]>();
    fixture.resolve4.mockReturnValueOnce(oldDns.promise).mockResolvedValue(["192.0.2.10"]);
    const attempt = api.query(settings, "select first").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await attempt).toMatchObject({ message: expect.stringContaining("timeout exceeded") });
    await api.query(settings, "select recovered");
    await vi.advanceTimersByTimeAsync(1_000);
    oldDns.resolve(["192.0.2.99"]);
    await vi.advanceTimersByTimeAsync(0);
    await api.query(settings, "select still healthy");
    expect(fixture.resolve4).toHaveBeenCalledTimes(2);
    expect(fixture.pools).toHaveLength(1);
    expect((fixture.pools[0] as { config: Record<string, unknown> }).config.host).toBe("192.0.2.10");
  });

  it("keeps a replacement pool and fresh DNS when an overlapping old checkout later fails", async () => {
    await api.query(settings, "select warm");
    const oldPool = fixture.pools[0] as EventEmitter;
    const pending = deferred<ReturnType<typeof client>>();
    fixture.connect.mockReturnValueOnce(pending.promise);
    const oldRequest = api.query(settings, "select old request");
    // Wait until the old request has actually started checkout on the old pool.
    await vi.waitFor(() => expect(fixture.connect).toHaveBeenCalledTimes(2));
    const rotated = { ...settings, password: "rotated-fictional-password" };
    await api.query(rotated, "select rotated");
    const replacement = fixture.pools[1];
    await api.query(rotated, "select refresh dns");
    expect(fixture.resolve4).toHaveBeenCalledTimes(2);
    pending.reject(Object.assign(new Error("old connection refused"), { code: "ECONNREFUSED" }));
    await oldRequest;
    oldPool.emit("error", new Error("late idle error"));
    await api.query(rotated, "select replacement survives");
    expect(fixture.resolve4).toHaveBeenCalledTimes(2);
    expect(fixture.pools).toHaveLength(3);
    expect(fixture.connect.mock.calls.at(-1)?.[1]).toBe(replacement);
  });

  it("refuses unapproved hosts and fails credential errors without fallback or leaking credentials", async () => {
    await expect(api.query({ ...settings, host: "unapproved.invalid" } as unknown as SupabaseSettings, "select forbidden")).rejects.toThrow("Refusing");
    expect(fixture.resolve4).not.toHaveBeenCalled();
    fixture.connect.mockRejectedValueOnce(Object.assign(new Error("password authentication failed for fictional account"), { code: "28P01" }));
    await expect(api.query(settings, "select forbidden")).rejects.toMatchObject({ message: "The ledger query failed.", sqlState: "28P01" });
    expect(fixture.connect).toHaveBeenCalledOnce();
  });

  it.each(["begin", "work", "commit"])("does not continue or replay a bank batch after an asynchronous client error during %s", async (phase) => {
    const checked = client();
    const failure = Object.assign(new Error(`fictional socket error during ${phase}`), { code: "ECONNRESET" });
    fixture.connect.mockResolvedValueOnce(checked);
    checked.query.mockImplementation(async (sql) => {
      if (sql === phase) checked.emit("error", failure);
      return { rows: [] };
    });
    const work = vi.fn(async () => {
      if (phase === "work") {
        checked.emit("error", failure);
        await expect(api.query(settings, "insert forbidden after error")).rejects.toThrow(failure.message);
      }
      return "fictional result";
    });
    await expect(api.withBankIngestTransaction(settings, owner, work)).rejects.toBe(failure);
    expect(fixture.connect).toHaveBeenCalledOnce();
    expect(work).toHaveBeenCalledTimes(phase === "begin" ? 0 : 1);
    const statements = checked.query.mock.calls.map(([sql]) => sql);
    expect(statements).not.toContain("insert forbidden after error");
    expect(statements.filter((sql) => sql === "commit")).toHaveLength(phase === "commit" ? 1 : 0);
    if (phase === "begin") expect(statements).toEqual(["begin", "rollback"]);
    expect(checked.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(checked.listenerCount("error")).toBe(0);
  });
});
