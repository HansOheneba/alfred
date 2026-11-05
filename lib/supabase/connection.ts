import { resolve4 } from "node:dns/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, types, type PoolClient, type QueryResultRow } from "pg";

import { ALFRED_SUPABASE_HOST, type SupabaseSettings } from "@/lib/config";
import { DatabaseError } from "@/lib/errors";

types.setTypeParser(1082, (value) => value);

type Candidate = { address: string; port: number };
type PoolEntry = Candidate & { pool: Pool; settings: SupabaseSettings; retired: boolean; acquiredClients: Set<PoolClient> };
const pools = new Map<string, PoolEntry>();
let preferred: PoolEntry | null = null;
type TransactionScope = { client: PoolClient; settings: SupabaseSettings; active: boolean; connectionFailed: boolean; failure?: DatabaseError };
const transactions = new AsyncLocalStorage<TransactionScope>();
// resolve4 skips the OS cache, so an uncached lookup adds a DNS round trip to every
// query. The pooler's addresses rarely change; unreachable ones are retried below.
const DNS_TTL_MS = 60_000;
// These bounds apply only before SQL is sent. A timed-out query can have committed;
// never race query execution against a timer or replay it on another connection.
const ACQUISITION_BUDGET_MS = 8_000;
const ACQUISITION_ATTEMPT_MS = 2_000;
const POOL_MAX_CLIENTS = 3;
let resolved: { host: string; addresses: string[]; at: number } | null = null;
let dnsGeneration = 0;

async function poolerAddresses(host: string, deadline: number): Promise<string[]> {
  if (resolved?.host === host && Date.now() - resolved.at < DNS_TTL_MS) return resolved.addresses;
  const generation = dnsGeneration;
  const addresses = await resolve4(host);
  // A late DNS response must not repopulate a cache invalidated by another request.
  if (generation === dnsGeneration && Date.now() < deadline) resolved = { host, addresses, at: Date.now() };
  return addresses;
}

function sameDatabase(left: SupabaseSettings, right: SupabaseSettings): boolean {
  return left.host === right.host && left.user === right.user && left.database === right.database
    && left.projectRef === right.projectRef && left.password === right.password;
}

function invalidatePool(entry: PoolEntry): void {
  if (entry.retired) return;
  entry.retired = true;
  const key = `${entry.address}:${entry.port}`;
  // An error from an old pool must not evict its healthy replacement.
  if (pools.get(key) === entry) {
    pools.delete(key);
    if (resolved?.host === entry.settings.host) resolved = null;
    dnsGeneration += 1;
  }
  if (preferred === entry) preferred = null;
  // end() drains checked-out clients; it does not interrupt other requests' SQL.
  void entry.pool.end().catch(() => undefined);
}

function poolFor(settings: SupabaseSettings, address: string, port: number): PoolEntry {
  const key = `${address}:${port}`;
  const existing = pools.get(key);
  if (existing && sameDatabase(existing.settings, settings)) return existing;
  if (existing) invalidatePool(existing);
  const pool = new Pool({
    host: address,
    port,
    user: settings.user,
    password: settings.password,
    database: settings.database,
    max: POOL_MAX_CLIENTS,
    idleTimeoutMillis: 10_000,
    // pg-pool applies this to both connection creation and its FIFO checkout
    // queue. The outer bound below keeps new connection attempts at two seconds,
    // while a healthy saturated pool can use the full acquisition budget.
    connectionTimeoutMillis: ACQUISITION_BUDGET_MS,
    ssl: { rejectUnauthorized: false, servername: settings.host },
  });
  const entry: PoolEntry = { pool, settings: { ...settings }, address, port, retired: false, acquiredClients: new Set() };
  // totalCount includes clients whose handshake has not finished. Only acquire
  // proves a connected client is doing work; release/remove ends that checkout.
  pool.on("acquire", (client: PoolClient) => entry.acquiredClients.add(client));
  pool.on("release", (_error: Error | undefined, client: PoolClient) => entry.acquiredClients.delete(client));
  pool.on("remove", (client: PoolClient) => entry.acquiredClients.delete(client));
  pool.on("error", () => invalidatePool(entry));
  pools.set(key, entry);
  return entry;
}

function unreachable(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : "";
  return ["ENETUNREACH", "EHOSTUNREACH", "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "EPIPE", "08000", "08001", "08003", "08006", "57P01", "57P02", "57P03"].includes(code)
    || /^(?:timeout exceeded when trying to connect|Connection terminated due to connection timeout|Connection terminated unexpectedly|Connection terminated|timeout expired|Cannot use a pool after calling end on the pool)$/i.test(message);
}

function checkoutTimeout(error: unknown): boolean {
  return error instanceof Error && /^(?:timeout exceeded when trying to connect|Connection terminated due to connection timeout)$/i.test(error.message);
}
function activeClients(entry: PoolEntry): number {
  return entry.acquiredClients.size;
}

function boundedAcquisition<T>(operation: Promise<T>, milliseconds: number, late?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      reject(new Error("timeout exceeded when trying to connect"));
    }, milliseconds);
    operation.then((value) => {
      if (expired) { late?.(value); return; }
      clearTimeout(timer);
      resolve(value);
    }, (error: unknown) => {
      if (expired) return;
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** The pooler has no room for another client right now; the other port may. */
function full(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return /EMAXCONN|max clients reached|too many clients|remaining connection slots/i.test(message);
}

function failedQuery(error: unknown): DatabaseError {
  const detail = error instanceof Error ? error.message : "unknown";
  const rawCode = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  // Preserve only PostgreSQL's fixed-format classification, never arbitrary driver fields or values.
  // Known SQLSTATE classes only: five-letter Node codes such as EPIPE/EPERM are not SQL errors.
  const sqlState = /^(?:[0-5][0-9A-Z]|F0|HV|P0|XX)[0-9A-Z]{3}$/.test(rawCode) ? rawCode : undefined;
  if (/password|SUPABASE_DB/i.test(detail)) return new DatabaseError("The ledger query failed.", sqlState);
  return new DatabaseError(`The ledger query failed: ${detail}`, sqlState);
}

async function acquireClient(settings: SupabaseSettings): Promise<{ client: PoolClient; entry: PoolEntry }> {
  const deadline = Date.now() + ACQUISITION_BUDGET_MS;
  let addresses: string[];
  try {
    addresses = await boundedAcquisition(poolerAddresses(settings.host, Date.now() + ACQUISITION_ATTEMPT_MS), ACQUISITION_ATTEMPT_MS);
  } catch (error) { throw failedQuery(error); }
  const candidates: Candidate[] = [];
  const first = preferred && !preferred.retired && sameDatabase(preferred.settings, settings) && addresses.includes(preferred.address) ? preferred : null;
  if (first) candidates.push(first);
  // Transaction mode shares server connections; session mode is the fallback.
  for (const port of [6543, 5432]) for (const address of addresses) {
    if (first?.address !== address || first.port !== port) candidates.push({ address, port });
  }
  let lastError: unknown = new DatabaseError("The ledger database is unreachable.");
  for (const candidate of candidates) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const entry = poolFor(settings, candidate.address, candidate.port);
    const queued = entry.pool.totalCount >= POOL_MAX_CLIENTS && entry.pool.idleCount === 0 && activeClients(entry) > 0;
    try {
      const client = await boundedAcquisition(entry.pool.connect(), queued ? remaining : Math.min(remaining, ACQUISITION_ATTEMPT_MS), (lateClient) => {
        // pg's public API cannot cancel a checkout. Return a late unused client
        // to a healthy pool, or destroy it when that pool has been retired.
        lateClient.release(entry.retired);
      });
      if (entry.retired) {
        client.release(true);
        lastError = new Error("Connection terminated");
        continue;
      }
      preferred = entry;
      return { client, entry };
    } catch (error) {
      lastError = error;
      // Queue pressure is not proof that this address or its healthy active
      // clients are unreachable. Preserve the pool, preference and DNS cache.
      if (checkoutTimeout(error) && (queued || activeClients(entry) > 0)) {
        if (queued) throw failedQuery(error);
        continue;
      }
      if (!full(error) && !unreachable(error)) throw failedQuery(error);
      invalidatePool(entry);
    }
  }
  throw failedQuery(lastError);
}

export async function query<T extends QueryResultRow>(
  settings: SupabaseSettings,
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  if (settings.host !== ALFRED_SUPABASE_HOST) {
    throw new DatabaseError("Refusing a database host that is not the Alfred project.");
  }
  const transaction = transactions.getStore();
  if (transaction) {
    if (!sameDatabase(transaction.settings, settings)) {
      throw new DatabaseError("The ledger transaction scope is no longer valid.");
    }
    if (!transaction.active) {
      if (transaction.connectionFailed && transaction.failure) throw transaction.failure;
      throw new DatabaseError("The ledger transaction scope is no longer valid.");
    }
    try { return (await transaction.client.query<T>(text, values)).rows; }
    catch (error) {
      const failure = failedQuery(error);
      if (unreachable(error)) {
        transaction.connectionFailed = true;
        transaction.active = false;
        transaction.failure = failure;
      }
      throw failure;
    }
  }
  const { client, entry } = await acquireClient(settings);
  let failed = false;
  let onError!: (error: Error) => void;
  try {
    // Match pool.query's checked-out client error handling, with no retry after
    // client.query is called, even when the response to a write is lost.
    const result = await new Promise<{ rows: T[] }>((resolve, reject) => {
      onError = reject;
      client.on("error", onError);
      client.query<T>(text, values).then(resolve, reject);
    });
    return result.rows;
  } catch (error) {
    failed = true;
    if (unreachable(error)) invalidatePool(entry);
    throw failedQuery(error);
  } finally {
    client.removeListener("error", onError);
    client.release(failed);
  }
}

/**
 * One parsed ingest batch commits its evidence and financial effects together.
 * Parsing/model calls must finish before entering. Existing stores keep using
 * query(), scoped to this exact checked-out client and database configuration.
 * Only connection acquisition may fall back; work/COMMIT are never replayed.
 */
export async function withBankIngestTransaction<T>(
  settings: SupabaseSettings, ownerId: string, work: () => Promise<T>,
): Promise<T> {
  if (settings.host !== ALFRED_SUPABASE_HOST || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ownerId)) {
    throw new DatabaseError("The ledger transaction owner or database is invalid.");
  }
  if (transactions.getStore()) throw new DatabaseError("A ledger transaction is already active.");
  const { client, entry } = await acquireClient(settings);
  const scope: TransactionScope = { client, settings: { ...settings }, active: true, connectionFailed: false };
  let connectionFailed = false;
  let committing = false;
  let clientError: Error | undefined;
  const connectionError = () => clientError ?? scope.failure ?? new DatabaseError("The ledger transaction connection is no longer available.");
  const onError = (error: Error) => {
    clientError = error;
    scope.connectionFailed = true;
    scope.failure = failedQuery(error);
    scope.active = false;
    invalidatePool(entry);
  };
  const transactionQuery = async (text: string, values?: unknown[]) => {
    if (scope.connectionFailed) throw connectionError();
    await client.query(text, values);
    if (scope.connectionFailed) throw connectionError();
  };
  client.on("error", onError);
  try {
    await transactionQuery("begin");
    await transactionQuery("set local lock_timeout = '5s'");
    await transactionQuery("set local statement_timeout = '15s'");
    await transactionQuery("set local idle_in_transaction_session_timeout = '30s'");
    // Serializes only automatic ingestion for this owner. Other financial
    // actions retain their existing validation/locking contracts.
    await transactionQuery("select pg_advisory_xact_lock(hashtextextended('bank-ingest:' || $1::text, 0))", [ownerId.toLowerCase()]);
    const result = await transactions.run(scope, work);
    scope.active = false;
    if (scope.connectionFailed) throw connectionError();
    committing = true;
    await transactionQuery("commit");
    return result;
  } catch (error) {
    scope.active = false;
    connectionFailed = committing || scope.connectionFailed || unreachable(error);
    try { await client.query("rollback"); }
    catch { connectionFailed = true; }
    if (connectionFailed) invalidatePool(entry);
    throw error;
  } finally {
    scope.active = false;
    client.removeListener("error", onError);
    client.release(connectionFailed);
  }
}
