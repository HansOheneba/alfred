import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { getGettingStartedState } from "@/app/components/getting-started-state";
import type { StudioSettings, SupabaseSettings, UserProfile } from "@/lib/config";
import { saveAccountingAction } from "@/lib/finance/accounting/persisted-store";
import { financeLooksEmpty } from "@/lib/web/finance-empty";
import { loadLedger } from "@/lib/web/ledger";

const harness = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/supabase/connection", () => ({ query: (...args: unknown[]) => harness.query(...args) }));
// The only query transport is the embedded database below. These settings cannot connect to a real project.
const database = { projectRef: "synthetic", host: "synthetic.invalid", user: "synthetic", database: "postgres", password: "" } as unknown as SupabaseSettings;
const settings: StudioSettings = { deepseek: { apiKey: "", model: "unused" }, google: null, supabase: database, authorizedUserIds: [], timezone: "Africa/Accra", currency: "GHS", confirmTransactions: "always" };
const profile = (profileId: string): UserProfile => ({ profileId, telegramUserId: null, spreadsheetId: "", preferredName: "Synthetic", timezone: "Africa/Accra", currency: "GHS", communicationPreference: "concise" });
let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec("create role anon; create role authenticated; create schema auth; create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$; create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}'::jsonb);");
  const migrationDir = new URL("../supabase/migrations/", import.meta.url);
  for (const name of (await readdir(migrationDir)).filter((name) => name.endsWith(".sql")).sort()) await db.exec(await readFile(new URL(name, migrationDir), "utf8"));
  harness.query.mockImplementation(async (_settings: unknown, sql: string, values: unknown[] = []) => (await db.query(sql, values)).rows);
}, 30_000);
afterAll(async () => { await db?.close(); });

async function owner() {
  const id = randomUUID();
  await db.query("insert into auth.users(id) values($1::uuid)", [id]);
  return id;
}
const sql = (text: string) => (id: string) => db.query(text, [id]).then(() => undefined);

/** Each source that can put something on a ledger, seeded alone for a fresh owner. */
const sources: Record<string, (id: string) => Promise<void>> = {
  "an active transaction": sql("insert into public.transactions(transaction_id,created_at,transaction_date,user_id,owner_id,type,amount,currency,category,description,status,updated_at,source_update_id) values(gen_random_uuid(),now(),current_date,$1::text,$1::uuid,'expense',12,'GHS','Food','Synthetic lunch','active',now(),'synthetic-source')"),
  "a budget": sql("insert into public.budgets(budget_id,user_id,owner_id,period,category,amount,currency,created_at,updated_at) values('synthetic-budget',$1::text,$1::uuid,to_char(current_date,'YYYY-MM'),'Food',100,'GHS',now(),now())"),
  "an active savings goal": sql("insert into public.savings_goals(goal_id,user_id,owner_id,name,target_amount,current_amount,currency,target_date,status,created_at,updated_at) values('synthetic-goal',$1::text,$1::uuid,'Synthetic goal',1000,10,'GHS','2027-06-01','active',now(),now())"),
  "an outstanding loan": sql("insert into public.loans(owner_id,person,person_key,kind,amount,currency,occurred_at) values($1::uuid,'Synthetic friend','synthetic friend','lent',50,'GHS',now())"),
  "a bill": sql("insert into public.bills(owner_id,name,next_date,amount,currency,cadence) values($1::uuid,'Synthetic streaming',current_date + 5,40,'GHS','monthly')"),
  "a bank alert with a balance": sql("insert into public.bank_messages(id,owner_id,source,channel,text_hash,direction,kind,amount,fee,currency,balance,occurred_at,status,raw) values(gen_random_uuid(),$1::uuid,'momo','manual',gen_random_uuid()::text,'out','payment',10,0,'GHS',90,now(),'needs_label','Synthetic alert')"),
  "a financial account": async (id) => { await saveAccountingAction(database, id, { type: "create_account", account: { id: "cash", label: "Synthetic cash", provider: "Manual", currency: "GHS", includeInCash: true }, expectedRevision: 0, requestId: `synthetic-${id}` }); },
};

async function both(id: string) {
  return { quick: await financeLooksEmpty(database, id), full: getGettingStartedState(await loadLedger(profile(id), settings)).isEmpty };
}

describe("cheap empty-account check", () => {
  it("agrees with the full Get Started rule for an owner with no records", async () => {
    expect(await both(await owner())).toEqual({ quick: true, full: true });
  });

  it.each(Object.keys(sources))("agrees with the full rule once the owner has %s", async (name) => {
    const id = await owner();
    await sources[name](id);
    expect(await both(id)).toEqual({ quick: false, full: false });
  });

  it("ignores deleted transactions and goals, as the full rule does", async () => {
    const id = await owner();
    await sql("insert into public.transactions(transaction_id,created_at,transaction_date,user_id,owner_id,type,amount,currency,category,description,status,updated_at,source_update_id) values(gen_random_uuid(),now(),current_date,$1::text,$1::uuid,'expense',12,'GHS','Food','Synthetic removed','deleted',now(),'synthetic-deleted')")(id);
    await sql("insert into public.savings_goals(goal_id,user_id,owner_id,name,target_amount,current_amount,currency,target_date,status,created_at,updated_at) values('synthetic-deleted-goal',$1::text,$1::uuid,'Synthetic removed goal',1000,0,'GHS','2027-06-01','deleted',now(),now())")(id);
    expect(await both(id)).toEqual({ quick: true, full: true });
  });

  it("agrees with the full rule after adding and then deleting the owner's last active transaction", async () => {
    const id = await owner();
    expect(await both(id)).toEqual({ quick: true, full: true });
    await sources["an active transaction"](id);
    expect(await both(id)).toEqual({ quick: false, full: false });
    await db.query("update public.transactions set status='deleted',updated_at=now() where owner_id=$1::uuid", [id]);
    expect(await both(id)).toEqual({ quick: true, full: true });
  });

  it("only errs towards hiding Get Started when stored rows leave the ledger empty", async () => {
    const id = await owner();
    await sql("insert into public.loans(owner_id,person,person_key,kind,amount,currency,occurred_at) values($1::uuid,'Synthetic friend','synthetic friend','lent',50,'GHS',now()),($1::uuid,'Synthetic friend','synthetic friend','repaid',50,'GHS',now())")(id);
    // A settled loan shows nothing on the ledger, but the check stays conservative.
    expect(await both(id)).toEqual({ quick: false, full: true });
  });
});
