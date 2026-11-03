import { beforeEach, describe, expect, it, vi } from "vitest";
import { ALFRED_SUPABASE_HOST, ALFRED_SUPABASE_PROJECT_REF, ALFRED_SUPABASE_USER, type SupabaseSettings } from "@/lib/config";

const mocks = vi.hoisted(() => ({ connect: vi.fn(), normalQuery: vi.fn(), resolve4: vi.fn(), configs: [] as Record<string, unknown>[] }));
vi.mock("node:dns/promises", () => ({ resolve4: mocks.resolve4 }));
vi.mock("pg", () => ({
  types: { setTypeParser: vi.fn() },
  Pool: class {
    constructor(readonly config: Record<string, unknown>) { mocks.configs.push(config); }
    on() {}
    async end() {}
    connect() { return mocks.connect(this.config); }
    query(sql: string, values: unknown[]) { return mocks.normalQuery(this.config, sql, values); }
  },
}));

const settings: SupabaseSettings = { projectRef: ALFRED_SUPABASE_PROJECT_REF, host: ALFRED_SUPABASE_HOST, user: ALFRED_SUPABASE_USER, database: "postgres", password: "synthetic-only-not-a-credential" };
const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ownerB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function client(label = "client-a") {
  type Query = (sql: string, values?: unknown[]) => Promise<{ rows: { label: string }[] }>;
  return { query: vi.fn<Query>(async () => ({ rows: [{ label }] })), release: vi.fn() };
}
let api: typeof import("@/lib/supabase/connection"), connection: ReturnType<typeof client>;
beforeEach(async () => {
  vi.resetModules();
  mocks.connect.mockReset(); mocks.normalQuery.mockReset(); mocks.resolve4.mockReset(); mocks.configs.length = 0;
  connection = client();
  mocks.connect.mockResolvedValue(connection);
  mocks.normalQuery.mockResolvedValue({ rows: [{ label: "ordinary-pool" }] });
  mocks.resolve4.mockResolvedValue(["192.0.2.10"]);
  api = await import("@/lib/supabase/connection");
});

describe("request-scoped bank ingestion transactions", () => {
  it("runs the batch on one exact client with an owner lock and commits once", async () => {
    const result = await api.withBankIngestTransaction(settings, ownerA, async () => api.query({ ...settings }, "select fixture", [ownerA]));
    expect(result).toEqual([{ label: "client-a" }]);
    expect(connection.query.mock.calls.map(([sql]) => sql)).toEqual([
      "begin", "set local lock_timeout = '5s'", "set local statement_timeout = '15s'",
      "set local idle_in_transaction_session_timeout = '30s'",
      "select pg_advisory_xact_lock(hashtextextended('bank-ingest:' || $1::text, 0))", "select fixture", "commit",
    ]);
    expect(connection.query.mock.calls.find(([sql]) => sql.includes("pg_advisory_xact_lock"))?.[1]).toEqual([ownerA]);
    expect(connection.release).toHaveBeenCalledExactlyOnceWith(false);
    expect(mocks.normalQuery).not.toHaveBeenCalled();
  });

  it("normalizes an uppercase UUID so the same owner always uses one advisory lock", async () => {
    await api.withBankIngestTransaction(settings, ownerA.toUpperCase(), async () => "done");
    expect(connection.query.mock.calls.find(([sql]) => sql.includes("pg_advisory_xact_lock"))?.[1]).toEqual([ownerA]);
  });

  it("rolls back callback failure and never retries the callback on another connection", async () => {
    const failure = Object.assign(new Error("synthetic interrupted batch"), { code: "ETIMEDOUT" });
    const work = vi.fn(async () => { await api.query(settings, "insert fixture"); throw failure; });
    await expect(api.withBankIngestTransaction(settings, ownerA, work)).rejects.toBe(failure);
    expect(work).toHaveBeenCalledOnce(); expect(mocks.connect).toHaveBeenCalledOnce();
    expect(connection.query.mock.calls.map(([sql]) => sql)).toContain("rollback");
    expect(connection.query.mock.calls.map(([sql]) => sql)).not.toContain("commit");
    expect(connection.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("does not replay an ambiguous COMMIT and discards that client", async () => {
    const uncertain = Object.assign(new Error("synthetic commit response lost"), { code: "ETIMEDOUT" });
    connection.query.mockImplementation(async (sql) => { if (sql === "commit") throw uncertain; return { rows: [] }; });
    const work = vi.fn(async () => { await api.query(settings, "insert fixture"); return "result"; });
    await expect(api.withBankIngestTransaction(settings, ownerA, work)).rejects.toBe(uncertain);
    expect(work).toHaveBeenCalledOnce(); expect(mocks.connect).toHaveBeenCalledOnce();
    expect(connection.query.mock.calls.filter(([sql]) => sql === "commit")).toHaveLength(1);
    expect(connection.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("preserves the original failure when rollback also fails and releases the client", async () => {
    const failure = new Error("synthetic business failure");
    connection.query.mockImplementation(async (sql) => { if (sql === "rollback") throw new Error("synthetic lost connection"); return { rows: [] }; });
    await expect(api.withBankIngestTransaction(settings, ownerA, async () => { throw failure; })).rejects.toBe(failure);
    expect(connection.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it.each(["ETIMEDOUT", "ECONNREFUSED", "ENETUNREACH"])("can fall back from %s only while acquiring the client", async (code) => {
    mocks.connect.mockRejectedValueOnce(Object.assign(new Error("synthetic unavailable client"), { code }));
    const work = vi.fn(async () => "done");
    expect(await api.withBankIngestTransaction(settings, ownerA, work)).toBe("done");
    expect(mocks.connect).toHaveBeenCalledTimes(2); expect(work).toHaveBeenCalledOnce();
    expect(mocks.configs.map((config) => config.port)).toEqual([6543, 5432]);
  });

  it("does not replay a failed BEGIN after acquiring a client", async () => {
    connection.query.mockRejectedValueOnce(Object.assign(new Error("synthetic interrupted begin"), { code: "ETIMEDOUT" }));
    const work = vi.fn();
    await expect(api.withBankIngestTransaction(settings, ownerA, work)).rejects.toThrow("synthetic interrupted begin");
    expect(work).not.toHaveBeenCalled(); expect(mocks.connect).toHaveBeenCalledOnce();
    expect(connection.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("can fall back when the first pool has no free clients before any batch starts", async () => {
    mocks.connect.mockRejectedValueOnce(new Error("synthetic max clients reached"));
    const work = vi.fn(async () => "done");
    expect(await api.withBankIngestTransaction(settings, ownerA, work)).toBe("done");
    expect(work).toHaveBeenCalledOnce(); expect(mocks.connect).toHaveBeenCalledTimes(2);
  });

  it("rolls back a rejected scoped query without replaying the statement or callback", async () => {
    connection.query.mockImplementation(async (sql) => {
      if (sql === "insert interrupted") throw Object.assign(new Error("synthetic interrupted query"), { code: "ETIMEDOUT" });
      return { rows: [] };
    });
    const work = vi.fn(async () => api.query(settings, "insert interrupted"));
    await expect(api.withBankIngestTransaction(settings, ownerA, work)).rejects.toThrow("synthetic interrupted query");
    expect(work).toHaveBeenCalledOnce(); expect(mocks.connect).toHaveBeenCalledOnce();
    expect(connection.query.mock.calls.filter(([sql]) => sql === "insert interrupted")).toHaveLength(1);
    expect(connection.query.mock.calls.map(([sql]) => sql)).toContain("rollback");
  });

  it.each([
    ["password", "different-synthetic-password"], ["user", "different-synthetic-user"],
    ["database", "different-synthetic-database"], ["projectRef", "different-synthetic-project"],
  ])("refuses a different %s in the active transaction", async (key, value) => {
    await expect(api.withBankIngestTransaction(settings, ownerA, async () => api.query({ ...settings, [key]: value } as SupabaseSettings, "select forbidden")))
      .rejects.toThrow("transaction scope");
    expect(connection.query.mock.calls.map(([sql]) => sql)).not.toContain("select forbidden");
    expect(mocks.normalQuery).not.toHaveBeenCalled();
  });

  it("rejects invalid hosts/owners before any connection and rejects nested transactions", async () => {
    const work = vi.fn();
    await expect(api.withBankIngestTransaction({ ...settings, host: "unapproved.invalid" } as unknown as SupabaseSettings, ownerA, work)).rejects.toThrow("invalid");
    await expect(api.withBankIngestTransaction(settings, "not-an-owner", work)).rejects.toThrow("invalid");
    expect(mocks.connect).not.toHaveBeenCalled();
    await expect(api.withBankIngestTransaction(settings, ownerA, async () => api.withBankIngestTransaction(settings, ownerB, work))).rejects.toThrow("already active");
    expect(work).not.toHaveBeenCalled(); expect(mocks.connect).toHaveBeenCalledOnce();
  });

  it("keeps simultaneous owners on their own exact clients and ordinary queries outside both scopes", async () => {
    const other = client("client-b"), enteredA = deferred(), enteredB = deferred(), proceed = deferred();
    mocks.connect.mockResolvedValueOnce(connection).mockResolvedValueOnce(other);
    const a = api.withBankIngestTransaction(settings, ownerA, async () => {
      enteredA.resolve(); await proceed.promise; return api.query(settings, "select owner-a", [ownerA]);
    });
    const b = api.withBankIngestTransaction(settings, ownerB, async () => {
      enteredB.resolve(); await proceed.promise; return api.query(settings, "select owner-b", [ownerB]);
    });
    await Promise.all([enteredA.promise, enteredB.promise]);
    expect(await api.query(settings, "select ordinary")).toEqual([{ label: "ordinary-pool" }]);
    proceed.resolve();
    expect(await a).toEqual([{ label: "client-a" }]); expect(await b).toEqual([{ label: "client-b" }]);
    expect(connection.query.mock.calls.map(([sql]) => sql)).not.toContain("select owner-b");
    expect(other.query.mock.calls.map(([sql]) => sql)).not.toContain("select owner-a");
    expect(connection.query.mock.calls.find(([sql]) => sql.includes("pg_advisory_xact_lock"))?.[1]).toEqual([ownerA]);
    expect(other.query.mock.calls.find(([sql]) => sql.includes("pg_advisory_xact_lock"))?.[1]).toEqual([ownerB]);
    expect(mocks.normalQuery).toHaveBeenCalledExactlyOnceWith(expect.any(Object), "select ordinary", []);
  });

  it("rejects detached work after completion instead of sending it through an ordinary pool", async () => {
    const proceed = deferred();
    let delayed!: Promise<unknown>;
    await api.withBankIngestTransaction(settings, ownerA, async () => {
      delayed = proceed.promise.then(() => api.query(settings, "select detached"));
    });
    const rejected = expect(delayed).rejects.toThrow("transaction scope");
    proceed.resolve(); await rejected;
    expect(connection.query.mock.calls.map(([sql]) => sql)).not.toContain("select detached");
    expect(mocks.normalQuery).not.toHaveBeenCalled();
  });

  it("closes the async scope before COMMIT finishes so detached work cannot escape the transaction", async () => {
    const committing = deferred(), finishCommit = deferred(), proceed = deferred();
    connection.query.mockImplementation(async (sql) => {
      if (sql === "commit") { committing.resolve(); await finishCommit.promise; }
      return { rows: [] };
    });
    let delayed!: Promise<unknown>;
    const batch = api.withBankIngestTransaction(settings, ownerA, async () => {
      delayed = proceed.promise.then(() => api.query(settings, "select during-commit"));
    });
    await committing.promise;
    const rejected = expect(delayed).rejects.toThrow("transaction scope");
    proceed.resolve(); await rejected;
    expect(connection.release).not.toHaveBeenCalled();
    expect(connection.query.mock.calls.map(([sql]) => sql)).not.toContain("select during-commit");
    finishCommit.resolve(); await batch;
    expect(connection.release).toHaveBeenCalledExactlyOnceWith(false);
  });
});
