import { resolve4 } from "node:dns/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, types, type PoolClient, type QueryResultRow } from "pg";

import { ALFRED_SUPABASE_HOST, type SupabaseSettings } from "@/lib/config";
import { DatabaseError } from "@/lib/errors";

types.setTypeParser(1082, (value) => value);

const pools = new Map<string, Pool>();
let preferred: { address: string; port: number } | null = null;
type TransactionScope = { client: PoolClient; settings: SupabaseSettings; active: boolean };
const transactions = new AsyncLocalStorage<TransactionScope>();
// resolve4 skips the OS cache, so an uncached lookup adds a DNS round trip to every
// query. The pooler's addresses rarely change; unreachable ones are retried below.
const DNS_TTL_MS = 60_000;
let resolved: { host: string; addresses: string[]; at: number } | null = null;

async function poolerAddresses(host: string): Promise<string[]> {
  if (resolved?.host === host && Date.now() - resolved.at < DNS_TTL_MS) return resolved.addresses;
  const addresses = await resolve4(host);
  resolved = { host, addresses, at: Date.now() };
  return addresses;
}

function sameDatabase(left: SupabaseSettings, right: SupabaseSettings): boolean {
  return left.host === right.host && left.user === right.user && left.database === right.database
    && left.projectRef === right.projectRef && left.password === right.password;
}

function poolFor(settings: SupabaseSettings, address: string, port: number): Pool {
  const key = `${address}:${port}`;
  const existing = pools.get(key);
  if (existing) return existing;
  const pool = new Pool({
    host: address,
    port,
    user: settings.user,
    password: settings.password,
    database: settings.database,
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
    ssl: { rejectUnauthorized: false, servername: settings.host },
  });
  pool.on("error", () => {
    pools.delete(key);
  });
  pools.set(key, pool);
  return pool;
}

function unreachable(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  return code === "ENETUNREACH" || code === "EHOSTUNREACH" || code === "ETIMEDOUT" || code === "ECONNREFUSED";
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
    if (!transaction.active || !sameDatabase(transaction.settings, settings)) {
      throw new DatabaseError("The ledger transaction scope is no longer valid.");
    }
    try { return (await transaction.client.query<T>(text, values)).rows; }
    catch (error) { throw failedQuery(error); }
  }
  const addresses = await poolerAddresses(settings.host);
  const candidates: { address: string; port: number }[] = [];
  if (preferred && addresses.includes(preferred.address)) candidates.push(preferred);
  // Transaction mode (6543) shares server connections between clients; session mode (5432) caps
  // clients at the pool size. Queries here are single statements or single-call functions with
  // transaction-scoped locks, so transaction mode is safe.
  for (const port of [6543, 5432]) {
    for (const address of addresses) {
      if (preferred?.address === address && preferred.port === port) continue;
      candidates.push({ address, port });
    }
  }
  let lastError: unknown = new DatabaseError("The ledger database is unreachable.");
  for (const candidate of candidates) {
    const pool = poolFor(settings, candidate.address, candidate.port);
    try {
      const result = await pool.query<T>(text, values);
      preferred = candidate;
      return result.rows;
    } catch (error) {
      lastError = error;
      // A bad query is not a bad connection: other requests share this pool, so only drop it when unreachable.
      if (full(error)) continue;
      if (!unreachable(error)) throw failedQuery(error);
      resolved = null;
      if (preferred?.address === candidate.address && preferred.port === candidate.port) preferred = null;
      const key = `${candidate.address}:${candidate.port}`;
      if (pools.get(key) === pool) pools.delete(key);
      void pool.end().catch(() => undefined);
    }
  }
  throw failedQuery(lastError);
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
  const addresses = await poolerAddresses(settings.host);
  const candidates: { address: string; port: number }[] = [];
  if (preferred && addresses.includes(preferred.address)) candidates.push(preferred);
  for (const port of [6543, 5432]) for (const address of addresses) {
    if (preferred?.address !== address || preferred.port !== port) candidates.push({ address, port });
  }
  let lastError: unknown = new DatabaseError("The ledger database is unreachable.");
  for (const candidate of candidates) {
    const pool = poolFor(settings, candidate.address, candidate.port);
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch (error) {
      lastError = error;
      if (unreachable(error)) resolved = null;
      if (full(error) || unreachable(error)) continue;
      throw failedQuery(error);
    }
    const scope: TransactionScope = { client, settings: { ...settings }, active: true };
    let connectionFailed = false;
    let committing = false;
    try {
      await client.query("begin");
      preferred = candidate;
      await client.query("set local lock_timeout = '5s'");
      await client.query("set local statement_timeout = '15s'");
      await client.query("set local idle_in_transaction_session_timeout = '30s'");
      // Serializes only automatic ingestion for this owner. Other financial
      // actions retain their existing validation/locking contracts.
      await client.query("select pg_advisory_xact_lock(hashtextextended('bank-ingest:' || $1::text, 0))", [ownerId.toLowerCase()]);
      const result = await transactions.run(scope, work);
      scope.active = false;
      committing = true;
      await client.query("commit");
      return result;
    } catch (error) {
      scope.active = false;
      connectionFailed = committing || unreachable(error);
      try { await client.query("rollback"); }
      catch { connectionFailed = true; }
      throw error;
    } finally {
      scope.active = false;
      client.release(connectionFailed);
    }
  }
  throw failedQuery(lastError);
}
