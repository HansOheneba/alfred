import { resolve4 } from "node:dns/promises";
import { Pool, types, type QueryResultRow } from "pg";

import { ALFRED_SUPABASE_HOST, type SupabaseSettings } from "@/lib/config";
import { DatabaseError } from "@/lib/errors";

types.setTypeParser(1082, (value) => value);

const pools = new Map<string, Pool>();
let preferred: { address: string; port: number } | null = null;

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

function failedQuery(error: unknown): DatabaseError {
  const detail = error instanceof Error ? error.message : "unknown";
  if (/password|SUPABASE_DB/i.test(detail)) return new DatabaseError("The ledger query failed.");
  return new DatabaseError(`The ledger query failed: ${detail}`);
}

export async function query<T extends QueryResultRow>(
  settings: SupabaseSettings,
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  if (settings.host !== ALFRED_SUPABASE_HOST) {
    throw new DatabaseError("Refusing a database host that is not the Alfred project.");
  }
  const addresses = await resolve4(settings.host);
  const candidates: { address: string; port: number }[] = [];
  if (preferred && addresses.includes(preferred.address)) candidates.push(preferred);
  for (const port of [5432, 6543]) {
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
      if (preferred?.address === candidate.address && preferred.port === candidate.port) preferred = null;
      await pool.end().catch(() => undefined);
      pools.delete(`${candidate.address}:${candidate.port}`);
      if (!unreachable(error)) throw failedQuery(error);
    }
  }
  throw failedQuery(lastError);
}
