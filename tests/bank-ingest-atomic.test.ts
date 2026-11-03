import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ALFRED_SUPABASE_HOST, ALFRED_SUPABASE_PROJECT_REF, ALFRED_SUPABASE_USER, type SupabaseSettings, type UserProfile } from "@/lib/config";

const transport = vi.hoisted(() => ({ connect: vi.fn(), outside: vi.fn() }));
vi.mock("node:dns/promises", () => ({ resolve4: async () => ["127.0.0.1"] }));
vi.mock("pg", () => ({
  types: { setTypeParser: vi.fn() },
  Pool: class {
    on() {}
    connect = transport.connect;
    query = transport.outside;
    async end() {}
  },
}));
import { ingestBankMessages } from "@/lib/bank/service";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const settings: SupabaseSettings = { host: ALFRED_SUPABASE_HOST, projectRef: ALFRED_SUPABASE_PROJECT_REF,
  user: ALFRED_SUPABASE_USER, database: "postgres", password: "synthetic-no-network" };
const owner: UserProfile = { profileId: OWNER, telegramUserId: null, spreadsheetId: "", currency: "GHS", timezone: "Africa/Accra",
  preferredName: "Fictional", communicationPreference: "concise" };
const TEXT = "Payment made for GHS 18.50 to FICTIONAL PAYEE Current Balance: GHS 610.40 . Available Balance: GHS 610.40. Reference: groceries. Transaction ID: 92300000001. Fee charged: GHS0.38 Tax charged: 0.";
let db: PGlite;
let available = Promise.resolve();

beforeAll(async () => {
  db = new PGlite();
  await db.exec("create role anon; create role authenticated; create schema auth; create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$; create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}'::jsonb);");
  for (const name of readdirSync("supabase/migrations").filter(name => name.endsWith(".sql")).sort()) {
    await db.exec(readFileSync("supabase/migrations/" + name, "utf8"));
  }
  // PGlite has one session. This fixture models a checked-out client and keeps
  // concurrent requests from interleaving their transactions on that session.
  // Separate mock-client tests cover ALS routing/isolation; this is SQL rollback
  // and retry integration, not simultaneous-session PostgreSQL lock proof.
  transport.connect.mockImplementation(async () => {
    const previous = available;
    let release!: () => void;
    available = new Promise<void>(resolve => { release = resolve; });
    await previous;
    return { query: (text: string, values: unknown[] = []) => db.query(text, values), release };
  });
  transport.outside.mockImplementation((text: string, values: unknown[] = []) => db.query(text, values));
}, 30_000);

beforeEach(async () => {
  await db.exec("drop trigger if exists fixture_reject_transaction on public.transactions; drop trigger if exists fixture_reject_link on public.bank_messages; drop function if exists fixture_reject_write(); truncate auth.users cascade;");
  await db.query("insert into auth.users(id) values($1),($2)", [OWNER, OTHER]);
  await db.query("insert into payee_rules(owner_id,payee_key,category,description) values($1,'fictional payee','Food','Synthetic groceries')", [OWNER]);
});
afterAll(async () => { await available; await db.close(); });

async function ingest(text = TEXT, selectedOwner = owner) {
  return ingestBankMessages(settings, selectedOwner, text, { channel: "mac", sender: "MobileMoney", receivedAt: new Date("2026-11-03T22:00:00Z") });
}
async function counts() {
  return (await db.query<{ bank: number; transactions: number }>("select (select count(*)::int from bank_messages) bank,(select count(*)::int from transactions) transactions")).rows[0];
}
async function reject(point: "fee" | "principal" | "link") {
  const clause = point === "fee" ? "new.category='Fees'" : point === "principal" ? "new.category<>'Fees'" : "new.transaction_id is not null";
  await db.exec(`create function fixture_reject_write() returns trigger language plpgsql as $$begin if ${clause} then raise exception 'Synthetic interrupted ingest';end if;return new;end$$;`);
  await db.exec(point === "link" ? "create trigger fixture_reject_link before update on bank_messages for each row execute function fixture_reject_write()" : "create trigger fixture_reject_transaction before insert on transactions for each row execute function fixture_reject_write()");
}

describe("atomic durable bank evidence and financial disposition", () => {
  it.each(["fee", "principal", "link"] as const)("rolls back the entire parsed alert when the %s write fails, then retries without lost or duplicated money", async (point) => {
    await reject(point);
    await expect(ingest()).rejects.toThrow("Synthetic interrupted ingest");
    expect(await counts()).toEqual({ bank: 0, transactions: 0 });
    await db.exec("drop trigger if exists fixture_reject_transaction on transactions;drop trigger if exists fixture_reject_link on bank_messages");
    const successful = await ingest();
    expect(successful).toMatchObject({ found: 1, duplicates: 0 });
    expect(successful.outcomes[0]).toMatchObject({ outcome: "recorded", feeRecorded: true, category: "Food" });
    expect(await counts()).toEqual({ bank: 1, transactions: 2 });
    const rows = (await db.query<{ amount: string; category: string }>("select amount::text,category from transactions order by category")).rows;
    expect(rows).toEqual([{ amount: "0.38", category: "Fees" }, { amount: "18.50", category: "Food" }]);
    expect((await db.query<{ raw: string }>("select raw from bank_messages")).rows[0].raw).toBe(TEXT);
    expect(await ingest()).toMatchObject({ found: 1, duplicates: 1, outcomes: [], durableMessageIds: successful.durableMessageIds });
    expect(await counts()).toEqual({ bank: 1, transactions: 2 });
  });

  it("keeps a multi-movement input wholly retryable after a later movement fails", async () => {
    const second = TEXT.replace("92300000001", "92300000002").replace("GHS 18.50", "GHS 19.50");
    await db.exec("create function fixture_reject_write() returns trigger language plpgsql as $$begin if new.amount=19.50 then raise exception 'Synthetic interrupted second movement';end if;return new;end$$;create trigger fixture_reject_transaction before insert on transactions for each row execute function fixture_reject_write()");
    await expect(ingest(TEXT + "\n" + second)).rejects.toThrow("Synthetic interrupted second movement");
    expect(await counts()).toEqual({ bank: 0, transactions: 0 });
    await db.exec("drop trigger fixture_reject_transaction on transactions");
    expect(await ingest(TEXT + "\n" + second)).toMatchObject({ found: 2, duplicates: 0 });
    expect(await counts()).toEqual({ bank: 2, transactions: 4 });
  });

  it("serializes overlapping synthetic retries and records one principal and fee", async () => {
    const results = await Promise.all([ingest(), ingest()]);
    expect(results.reduce((sum, result) => sum + result.duplicates, 0)).toBe(1);
    expect(await counts()).toEqual({ bank: 1, transactions: 2 });
    expect(results[0].durableMessageIds).toEqual(results[1].durableMessageIds);
  });

  it("keeps equal provider identifiers separate for two owners", async () => {
    await Promise.all([ingest(), ingest(TEXT, { ...owner, profileId: OTHER })]);
    expect((await db.query<{ owner_id: string; count: number }>("select owner_id::text,count(*)::int from bank_messages group by owner_id order by owner_id")).rows)
      .toEqual([{ owner_id: OWNER, count: 1 }, { owner_id: OTHER, count: 1 }]);
    expect((await db.query<{ owner_id: string; count: number }>("select owner_id::text,count(*)::int from transactions group by owner_id order by owner_id")).rows)
      .toEqual([{ owner_id: OWNER, count: 2 }, { owner_id: OTHER, count: 1 }]);
  });

  it("does not silently repair or overwrite a historical partial record", async () => {
    const result = await ingest();
    await db.query("update bank_messages set status='needs_label',transaction_id=null where id=$1", [result.durableMessageIds[0]]);
    expect(await ingest()).toMatchObject({ duplicates: 1, outcomes: [] });
    expect((await db.query<{ transaction_id: string | null; status: string }>("select transaction_id,status from bank_messages")).rows[0])
      .toEqual({ transaction_id: null, status: "needs_label" });
    expect(await counts()).toEqual({ bank: 1, transactions: 2 });
  });
});
