import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { StudioSettings, SupabaseSettings, UserProfile } from "@/lib/config";
import { loadLedger } from "@/lib/web/ledger";
import { loadLedgerBankMetadata } from "@/lib/web/ledger-bank-metadata";
import { sourceMovements } from "@/lib/finance/accounting/sources";
import { emptyAccountingState } from "@/lib/finance/accounting/types";
import { listRawTransactions } from "@/lib/supabase/finance-store";
import { createSupabaseBankStore } from "@/lib/bank/store";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/supabase/connection", () => ({ query: mocks.query }));
const OWNER = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const settings = { supabase: {} as SupabaseSettings } as StudioSettings;
const profile: UserProfile = { profileId: OWNER, preferredName: "Synthetic owner", currency: "GHS", timezone: "Africa/Accra", communicationPreference: "concise", telegramUserId: null, spreadsheetId: "" };

describe("dashboard ledger critical path on fictional SQL data", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`create role anon;create role authenticated;create schema auth;
      create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;
      create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}'::jsonb);`);
    for (const filename of readdirSync("supabase/migrations").filter(name => name.endsWith(".sql")).sort()) {
      await db.exec(readFileSync(`supabase/migrations/${filename}`, "utf8"));
    }
    await db.query("insert into auth.users(id) values($1::uuid),($2::uuid)", [OWNER, OTHER]);
    await db.query("update profiles set account_names='Synthetic wallet; Synthetic reserve' where id=$1::uuid", [OWNER]);
    await db.query(`insert into transactions(transaction_id,created_at,transaction_date,user_id,owner_id,type,amount,currency,category,description,status,updated_at,source_update_id)
      select ('20000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,now(),('2026-11-'||lpad(((n%28)+1)::text,2,'0'))::date,$1::text,$1::uuid,'expense',10,'GHS','Food','Synthetic purchase '||n,'active',now(),'synthetic-source:'||n from generate_series(1,2315) n`, [OWNER]);
    await db.query(`insert into budgets(budget_id,user_id,owner_id,period,category,amount,currency,created_at,updated_at)
      values('synthetic-budget',$1::text,$1::uuid,'2026-11','Food',8000,'GHS',now(),now())`, [OWNER]);
    await db.query(`insert into bank_messages(id,owner_id,source,channel,text_hash,direction,kind,amount,fee,currency,counterparty,balance,occurred_at,status,raw)
      values('10000000-0000-4000-8000-000000000001',$1::uuid,'momo','manual','synthetic-owner-hash','out','payment',10,0,'GHS','Synthetic merchant',500,now(),'needs_label','Synthetic fixture'),
      ('10000000-0000-4000-8000-000000000002',$2::uuid,'momo','manual','synthetic-other-hash','out','payment',99,0,'GHS','Other fixture',999,now(),'needs_label','Other fixture')`, [OWNER, OTHER]);
    await db.query(`insert into ingest_tokens(owner_id,token_hash,last_used_at) values($1::uuid,'synthetic-token-hash','2026-11-05T12:00:00Z')`, [OWNER]);
    await db.query(`insert into bank_messages(id,owner_id,source,channel,text_hash,direction,kind,amount,fee,currency,counterparty,balance,occurred_at,status,raw)
      select ('40000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,$1::uuid,'momo','manual','synthetic-sized-sms:'||n,'out','payment',10,0,'GHS','Synthetic merchant',null,
        '2026-11-04T12:00:00Z'::timestamptz,'needs_label',repeat('Synthetic payment alert for fictional benchmark. ',12) from generate_series(1,199) n`, [OWNER]);
    mocks.query.mockImplementation(async (_settings: SupabaseSettings, sql: string, values: unknown[]) => (await db.query(sql, values)).rows);
    const raw = await listRawTransactions(settings.supabase, OWNER), messages = await createSupabaseBankStore(settings.supabase).listMessages(OWNER);
    const state = {
      ...emptyAccountingState(OWNER),
      accounts: [{ id: "synthetic-wallet", label: "Synthetic wallet", provider: "Synthetic provider", currency: "GHS", includeInCash: true, createdAt: "2026-11-01T12:00:00Z" }],
      movements: sourceMovements(OWNER, raw, messages).map(movement => ({ ...movement, accountId: "synthetic-wallet" })),
      snapshots: Array.from({ length: 2277 }, (_, index) => ({ id: `synthetic-snapshot:${index}`, accountId: "synthetic-wallet", balanceMinor: 50000 + index, occurredAt: new Date(Date.UTC(2026, 10, 1, 0, index)).toISOString(), sourceId: `synthetic-statement:${index}`, sourceMovementId: null })),
    };
    await db.query("insert into accounting_states(owner_id,revision,state) values($1::uuid,0,$2::jsonb)", [OWNER, JSON.stringify(state)]);
  }, 30_000);
  afterAll(async () => { await db?.close(); });

  it("measures real read queries under a three-client 80ms latency model and preserves owner data", async () => {
    const calls: { sql: string; values: unknown[] }[] = [];
    const queue: (() => void)[] = [];
    let active = 0, peakQueue = 0, databasePayloadBytes = 0;
    mocks.query.mockImplementation((_settings: SupabaseSettings, sql: string, values: unknown[] = []) => new Promise((resolve, reject) => {
      calls.push({ sql, values });
      const run = () => {
        active++;
        setTimeout(() => {
          void db.query(sql, values).then(result => { databasePayloadBytes += Buffer.byteLength(JSON.stringify(result.rows)); resolve(result.rows); }, reject).finally(() => {
            active--; queue.shift()?.();
          });
        }, 80);
      };
      if (active < 3) run(); else { queue.push(run); peakQueue = Math.max(peakQueue, queue.length); }
    }));
    const start = performance.now();
    const result = await loadLedger(profile, settings);
    const elapsedMs = Math.round(performance.now() - start);
    console.info("dashboard-ledger-loading", JSON.stringify({ queryCount: calls.length, elapsedMs, simulatedQueryLatencyMs: 80, clients: 3, peakQueue, rows: result.rows.length, databasePayloadBytes, browserPayloadBytes: Buffer.byteLength(JSON.stringify(result)), queryKinds: calls.map(call => call.sql.match(/from public\.([a-z_]+)/i)?.[1] ?? "capability-or-version") }));
    expect(result.rows).toHaveLength(2315);
    expect(result.bank).toMatchObject({ connected: true, lastUsedAt: "2026-11-05T12:00:00.000Z", accountNames: ["Synthetic wallet", "Synthetic reserve"], balances: [{ source: "momo", label: "MoMo", balance: "500.00" }] });
    expect(JSON.stringify(result)).not.toContain("Other fixture");
    expect(calls.every(call => /^\s*select\b/i.test(call.sql))).toBe(true);
    expect(calls.filter(call => call.values.length).every(call => call.values[0] === OWNER)).toBe(true);
    // 15 for the books, plus one for the charts kept from chat and one for the payday they confirmed.
    expect(calls.length).toBe(17);
  });

  it("keeps token existence separate from usage and selects the latest non-null balance with creation-time ties", async () => {
    mocks.query.mockImplementation(async (_settings: SupabaseSettings, sql: string, values: unknown[]) => (await db.query(sql, values)).rows);
    await db.exec("begin");
    try {
      await db.query("update ingest_tokens set last_used_at=null,last_empty_at='2026-11-05T10:20:30.123456Z' where owner_id=$1::uuid", [OWNER]);
      await db.query("update bank_messages set occurred_at='2026-11-01T10:00:00Z' where owner_id=$1::uuid", [OWNER]);
      await db.query(`insert into bank_messages(id,owner_id,source,channel,text_hash,direction,kind,amount,fee,currency,counterparty,balance,occurred_at,created_at,status,raw) values
        ('30000000-0000-4000-8000-000000000001',$1::uuid,'momo','manual','synthetic-ranking-1','out','payment',10,0,'GHS','Synthetic fixture',610.25,'2026-11-02T10:00:00.123456Z','2026-11-02T11:00:00Z','recorded','Synthetic fixture'),
        ('30000000-0000-4000-8000-000000000002',$1::uuid,'momo','manual','synthetic-ranking-2','out','payment',10,0,'GHS','Synthetic fixture',620.75,'2026-11-02T10:00:00.123456Z','2026-11-02T12:00:00Z','recorded','Synthetic fixture'),
        ('30000000-0000-4000-8000-000000000003',$1::uuid,'momo','manual','synthetic-ranking-null','out','payment',10,0,'GHS','Synthetic fixture',null,'2026-11-03T10:00:00Z','2026-11-03T11:00:00Z','recorded','Synthetic fixture'),
        ('30000000-0000-4000-8000-000000000004',$1::uuid,'gcb','manual','synthetic-second-provider','out','payment',10,0,'GHS','Synthetic fixture',12.30,'2026-11-01T08:00:00Z','2026-11-01T09:00:00Z','recorded','Synthetic fixture')`, [OWNER]);
      const result = await loadLedgerBankMetadata(settings.supabase, OWNER);
      expect(result).toEqual({
        connected: true, lastUsedAt: null, lastEmptyAt: "2026-11-05T10:20:30.123Z", accountNames: ["Synthetic wallet", "Synthetic reserve"],
        balances: [
          { source: "gcb", label: "GCB card", balance: "12.30", at: "2026-11-01T08:00:00.000Z" },
          { source: "momo", label: "MoMo", balance: "620.75", at: "2026-11-02T10:00:00.123Z" },
        ],
      });
      const other = await loadLedgerBankMetadata(settings.supabase, OTHER);
      expect(other).toMatchObject({ connected: false, lastUsedAt: null, lastEmptyAt: null, accountNames: [], balances: [{ balance: "999.00" }] });
      await db.query("delete from ingest_tokens where owner_id=$1::uuid", [OWNER]);
      expect(await loadLedgerBankMetadata(settings.supabase, OWNER)).toMatchObject({ connected: false, lastUsedAt: null, lastEmptyAt: null });
    } finally { await db.exec("rollback"); }
  });

  it("reads fresh metadata on the next call and propagates failures instead of inventing empty state", async () => {
    mocks.query.mockImplementation(async (_settings: SupabaseSettings, sql: string, values: unknown[]) => (await db.query(sql, values)).rows);
    await db.exec("begin");
    try {
      await loadLedgerBankMetadata(settings.supabase, OWNER);
      await db.query("update profiles set account_names='Synthetic new name' where id=$1::uuid", [OWNER]);
      expect((await loadLedgerBankMetadata(settings.supabase, OWNER)).accountNames).toEqual(["Synthetic new name"]);
    } finally { await db.exec("rollback"); }
    mocks.query.mockRejectedValueOnce(new Error("Synthetic database failure"));
    await expect(loadLedgerBankMetadata(settings.supabase, OWNER)).rejects.toThrow("Synthetic database failure");
  });
});
