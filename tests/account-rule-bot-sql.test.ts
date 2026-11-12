import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const connection = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/supabase/connection", () => ({ query: connection.query }));
import { createAccountRuleBotDeps, handleAccountRuleBotCommand } from "@/lib/account-rules/bot-command";
import { loadAccountRules, saveAccountRuleCommand } from "@/lib/account-rules/store";
import { emptyAccountingState } from "@/lib/finance/accounting/types";
import { loadAccountingState, saveAccountingAction } from "@/lib/finance/accounting/persisted-store";
import { createSupabaseFinanceStore } from "@/lib/supabase/finance-store";
import { handleProfileTurn, type StudioDeps } from "@/lib/studio/handle";
import type { SupabaseSettings } from "@/lib/config";
import { profile, settings } from "./helpers";

const modulePath = process.env.ALFRED_PGLITE_MODULE ?? resolve("node_modules/@electric-sql/pglite/dist/index.js");
if (process.env.ALFRED_PGLITE_MODULE && !existsSync(modulePath)) throw new Error("ALFRED_PGLITE_MODULE must point to a local PGlite module.");
interface Database { exec(sql: string): Promise<unknown>; query<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<{ rows: T[] }>; close(): Promise<void> }
const OWNER = "00000000-0000-4000-8000-000000000001", OTHER = "00000000-0000-4000-8000-000000000002";
const RULE = "00000000-0000-4000-8000-000000000010", BINDING = "00000000-0000-4000-8000-000000000011";
const NOW = "2026-11-02T12:00:00.000Z", ACCOUNT = "synthetic-owned-bank", CHAT = "100";
const dbSettings = {} as SupabaseSettings;

/** All runtime store calls are redirected to an in-memory, credential-free PostgreSQL. */
describe.skipIf(!existsSync(modulePath))("bot commands, UI rules and bot reports on the same synthetic PostgreSQL", () => {
  let db: Database;
  beforeAll(async () => {
    const { PGlite } = await import(/* @vite-ignore */ pathToFileURL(modulePath).href) as { PGlite: new () => Database };
    db = new PGlite();
    await db.exec("create role anon; create role authenticated; create schema auth; create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$; create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}'::jsonb);");
    const directory = resolve("supabase/migrations");
    for (const name of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) await db.exec(readFileSync(resolve(directory, name), "utf8"));
  }, 30_000);
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(NOW));
    await db.exec("truncate auth.users cascade");
    await db.query("insert into auth.users(id) values($1),($2)", [OWNER, OTHER]);
    const initial = { ...emptyAccountingState(OWNER), accounts: [{ id: ACCOUNT, label: "Fictional GCB account", provider: "GCB", currency: "GHS", includeInCash: true, createdAt: NOW }] };
    await db.query("insert into public.accounting_states(owner_id,revision,state) values($1,0,$2::jsonb)", [OWNER, JSON.stringify(initial)]);
    connection.query.mockImplementation(async (_settings: unknown, sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows);
  });
  afterEach(() => vi.useRealTimers());
  afterAll(async () => { await db?.close(); });
  async function message(id: string, merchant: string, at = "2026-11-02T12:01:00.000Z") {
    // A recorded native bank message has the original ledger row created by ingestion.
    await db.query("insert into public.transactions(transaction_id,owner_id,user_id,created_at,transaction_date,type,amount,currency,category,description,payment_method,notes,status,updated_at,source_update_id) values($1::uuid,$2::uuid,$2::text,$4::timestamptz,($4::timestamptz)::date,'expense',10,'GHS','Uncategorized',$3,'GCB','Synthetic','active',$4::timestamptz,$5)", [id, OWNER, merchant, at, `bank:${id}`]);
    await db.query("insert into public.bank_messages(id,owner_id,source,channel,external_id,text_hash,direction,kind,amount,fee,currency,counterparty,occurred_at,status,raw,transaction_id) values($1::uuid,$2,'gcb','manual',null,$1::text,'out','payment',10,0,'GHS',$3,$4,'recorded','Synthetic debit. Your A/C No:XXXX0543',$1::uuid)", [id, OWNER, merchant, at]);
  }
  async function bind() {
    return saveAccountRuleCommand(dbSettings, OWNER, { type: "save_binding", expectedRevision: 0, requestId: "synthetic-ui-binding", binding: { id: BINDING, accountId: ACCOUNT, provider: "gcb", accountSuffix: "0543", currency: "GHS", active: true } });
  }
  it("a UI-created account rule is listed by /rule and its category appears in a real bot reporting hook", async () => {
    await bind();
    await saveAccountRuleCommand(dbSettings, OWNER, { type: "upsert_rule", expectedRevision: 1, requestId: "synthetic-ui-rule", rule: { id: RULE, accountId: ACCOUNT, matchMode: "exact", merchantExact: "Fictional UI Merchant", category: "UI Grocery", effectiveFrom: "2026-11-01T00:00:00.000Z" } });
    await message("00000000-0000-4000-8000-000000000020", "Fictional UI Merchant");
    const commandDeps = createAccountRuleBotDeps(dbSettings);
    expect(await handleAccountRuleBotCommand("/rule list", OWNER, CHAT, commandDeps)).toContain("UI Grocery");
    const store = createSupabaseFinanceStore(dbSettings), base = settings(); let serial = 0;
    const deps: StudioDeps = { settings: { ...base, ai: base.ai!, supabase: dbSettings }, store, accountRuleCommands: commandDeps, now: () => new Date(NOW), createId: () => RULE, createActionId: () => "synthetic-action", nextUpdateId: () => ++serial,
      interpret: async () => ({ type: "get_spending_summary", period: "this_month", detail: "by_category" }) };
    const result = await handleProfileTurn({ ...profile(), profileId: OWNER }, { text: "What are my spending categories?", clientId: "synthetic-same-database-report" }, deps);
    expect(result.text).toContain("UI Grocery"); expect(result.text).toContain("10.00");
    expect((await store.listReportTransactions!(OWNER))[0].category).toBe("UI Grocery");
    const accounting = await loadAccountingState(dbSettings, OWNER), movement = accounting.state.movements[0];
    await saveAccountingAction(dbSettings, OWNER, { type: "classify_movement", movement: { movementId: movement.id, sourceFingerprint: movement.sourceFingerprint }, status: "confirmed", category: "Manual Grocery", expectedRevision: accounting.state.revision, requestId: "synthetic-ui-manual-override" });
    expect((await store.listReportTransactions!(OWNER))[0].category).toBe("Manual Grocery");
    const manual = await handleProfileTurn({ ...profile(), profileId: OWNER }, { text: "Show my categories after my edit", clientId: "synthetic-manual-wins-report" }, deps); expect(manual.text).toContain("Manual Grocery");
  });
  it("bot confirmation persists the same UI rule state, atomically excludes cancellation after claim, and hydrates future matching sources", async () => {
    await bind();
    const deps = createAccountRuleBotDeps(dbSettings); deps.now = () => new Date(NOW); deps.token = () => "syntheticToken01"; deps.id = () => RULE;
    const draft = await handleAccountRuleBotCommand(`/rule add ${ACCOUNT} "Fictional Bot Merchant" "Bot Grocery"`, OWNER, CHAT, deps);
    expect(draft).toContain("Nothing is saved yet"); expect((await loadAccountRules(dbSettings, OWNER)).state.rules).toEqual([]);
    expect(await handleAccountRuleBotCommand("/rule confirm syntheticToken01", OTHER, CHAT, deps)).toContain("not available");
    await deps.pending.claim(OWNER, CHAT, "syntheticToken01", NOW);
    expect(await handleAccountRuleBotCommand("/rule cancel syntheticToken01", OWNER, CHAT, deps)).toContain("could not be cancelled");
    expect(await handleAccountRuleBotCommand("/rule confirm syntheticToken01", OWNER, CHAT, deps)).toContain("Account rule saved");
    const shared = await loadAccountRules(dbSettings, OWNER); expect(shared.state.rules).toHaveLength(1); expect(shared.state.rules[0]).toMatchObject({ accountId: ACCOUNT, merchantExact: "fictional bot merchant", category: "Bot Grocery", effectiveFrom: NOW });
    expect(await handleAccountRuleBotCommand("/rule confirm syntheticToken01", OWNER, CHAT, deps)).toContain("already confirmed");
    expect((await loadAccountRules(dbSettings, OWNER)).state.revision).toBe(shared.state.revision);
    await message("00000000-0000-4000-8000-000000000021", "Fictional Bot Merchant");
    expect((await createSupabaseFinanceStore(dbSettings).listReportTransactions!(OWNER))[0].category).toBe("Bot Grocery");
    const rows = await db.query<{ status: string }>("select status from public.pending_actions where owner_id=$1 and action_id=$2", [OWNER, "syntheticToken01"]); expect(rows.rows[0].status).toBe("completed");
  });
});
