import { readFileSync, readdirSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ALFRED_SUPABASE_HOST, ALFRED_SUPABASE_PROJECT_REF, ALFRED_SUPABASE_USER, type SupabaseSettings, type UserProfile } from "@/lib/config";
import { emptyAccountingState, type AccountingState } from "@/lib/finance/accounting/types";

const transport = vi.hoisted(() => ({ connect: vi.fn(), outside: vi.fn() }));
vi.mock("node:dns/promises", () => ({ resolve4: async () => ["127.0.0.1"] }));
vi.mock("pg", () => ({ types: { setTypeParser: vi.fn() }, Pool: class { on() {} connect = transport.connect; query = transport.outside; async end() {} } }));
import { ingestBankMessages } from "@/lib/bank/service";
import { createTransferConversationDeps, loadOwnTransferNotices } from "@/lib/bank/own-transfers";
import { listBankTransferWindow } from "@/lib/bank/store";
import { loadAccountingState } from "@/lib/finance/accounting/persisted-store";
import { buildAccountingView, projectAccountingTransactions } from "@/lib/finance/accounting/view";
import { parseBankText } from "@/lib/bank/parse";
import { createArchive, readArchive } from "@/portability/archive.mjs";
import { planImport, type ImportArchive } from "@/lib/portability/model";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW = new Date("2026-11-04T11:09:00Z");
const settings: SupabaseSettings = { host: ALFRED_SUPABASE_HOST, projectRef: ALFRED_SUPABASE_PROJECT_REF, user: ALFRED_SUPABASE_USER, database: "postgres", password: "synthetic-no-network" };
const profile: UserProfile = { profileId: OWNER, telegramUserId: null, spreadsheetId: "", currency: "GHS", timezone: "Africa/Accra", preferredName: "Fictional", communicationPreference: "concise" };
let db: PGlite, available = Promise.resolve();
const statementTrace: string[] = [];
let injectedFailure: "connection" | "rollback" | "pipe" | "source-version" | "provider-edit" | null = null;
let versionReadCount = 0;
const outgoing = (amount = "1.00", id = "88123456", fee = "0.00") => `GHS ${amount} was withdrawn from your Hubtel wallet. Available balance: GHS 99.00. Fee charged: GHS ${fee}. Transaction ID: ${id}.`;
const incoming = (amount = "1.00", id = "92300000001", sender = "Credit.Inv") => `Payment received for GHS ${amount} from ${sender} Current Balance: GHS 100.00 . Available Balance: GHS 100.00. Reference: wallet. Transaction ID: ${id}.`;

beforeAll(async () => {
  db = new PGlite();
  await db.exec("create role anon; create role authenticated; create schema auth; create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$; create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}'::jsonb);");
  for (const name of readdirSync("supabase/migrations").filter((name) => name.endsWith(".sql")).sort()) await db.exec(readFileSync("supabase/migrations/" + name, "utf8"));
  // Isolated one-session PostgreSQL rehearsal, not a claim of simultaneous-session lock scheduling.
  transport.connect.mockImplementation(async () => {
    const previous = available; let release!: () => void;
    available = new Promise<void>((resolve) => { release = resolve; }); await previous;
    return Object.assign(new EventEmitter(), { query: async (text: string, values: unknown[] = []) => {
      statementTrace.push(text);
      if (injectedFailure === "provider-edit" && text === "savepoint alfred_automatic_transfer_pair") {
        injectedFailure = null;
        // Model a committed owner edit after discovery and before pair locking.
        // It precedes the savepoint, so deferring this optional pair must retain it.
        await db.query("update accounting_states set revision=revision+1,state=jsonb_set(jsonb_set(state,'{revision}',to_jsonb(revision+1)),'{accounts,0,provider}',to_jsonb('Fictional other bank'::text)) where owner_id=$1", [OWNER]);
      }
      if (injectedFailure === "connection" && text.includes("select public.alfred_write_accounting_state(")) throw Object.assign(new Error("Synthetic connection uncertainty"), { code: "08006" });
      if (injectedFailure === "pipe" && text.includes("select public.alfred_write_accounting_state(")) throw Object.assign(new Error("Synthetic pipe failure"), { code: "EPIPE" });
      if (injectedFailure === "rollback" && text.startsWith("rollback to savepoint")) throw Object.assign(new Error("Synthetic rollback connection failure"), { code: "08006" });
      if (injectedFailure === "source-version" && text.includes("select public.alfred_accounting_source_version(")) {
        versionReadCount += 1;
        if (versionReadCount === 2) await db.query("update bank_messages set raw=raw||' Synthetic corrected source' where id=(select id from bank_messages order by occurred_at,id limit 1)");
      }
      return db.query(text, values);
    }, release });
  });
  transport.outside.mockImplementation((text: string, values: unknown[] = []) => { statementTrace.push(text); return db.query(text, values); });
}, 30_000);
beforeEach(async () => {
  injectedFailure = null;
  versionReadCount = 0;
  if ((await db.query<{ present: boolean }>("select to_regprocedure('public.fixture_normal_accounting_write(uuid,bigint,text,text,text,jsonb)') is not null as present")).rows[0].present) {
    await db.exec("drop function public.alfred_write_accounting_state(uuid,bigint,text,text,text,jsonb);alter function public.fixture_normal_accounting_write(uuid,bigint,text,text,text,jsonb) rename to alfred_write_accounting_state;");
  }
  await db.exec("drop trigger if exists fixture_reject_transfer on accounting_events; drop function if exists fixture_reject_transfer(); truncate auth.users cascade;");
  await db.query("insert into auth.users(id) values($1),($2)", [OWNER, OTHER]);
  for (const ownerId of [OWNER, OTHER]) {
    const state = emptyAccountingState(ownerId);
    state.accounts = [
      { id: "hubtel-wallet", label: "Everyday Hubtel wallet", provider: "Hubtel", currency: "GHS", includeInCash: true, createdAt: NOW.toISOString() },
      { id: "mtn-wallet", label: "Personal MTN MoMo", provider: "MTN MoMo", currency: "GHS", includeInCash: true, createdAt: NOW.toISOString() },
    ];
    await db.query("insert into accounting_states(owner_id,revision,state) values($1,0,$2::jsonb)", [ownerId, JSON.stringify(state)]);
  }
});
afterAll(async () => { await available; await db.close(); });
const ingest = (text: string, owner = profile) => ingestBankMessages(settings, owner, text, { channel: "mac", sender: /Hubtel wallet/.test(text) ? "Hubtel" : "MobileMoney", receivedAt: NOW });
async function saved(ownerId = OWNER): Promise<AccountingState> { return (await loadAccountingState(settings, ownerId)).state; }
async function seedPending(text: string, at: string): Promise<string> {
  const item = parseBankText(text, { now: new Date(at), timeZone: "Africa/Accra", sender: /Hubtel wallet/.test(text) ? "Hubtel" : "MobileMoney" })[0];
  return (await db.query<{ id: string }>(`insert into bank_messages(owner_id,source,channel,external_id,text_hash,direction,kind,amount,fee,currency,counterparty,balance,occurred_at,status,raw,read_by)
    values($1,$2,'mac',$3,$4,$5,'payment',$6,$7,'GHS',$8,$9,$10,'needs_label',$11,'rules') returning id`, [OWNER, item.source, item.externalId, item.fingerprint, item.direction, item.amount, item.fee, item.counterparty, item.balance, item.occurredAt, item.raw])).rows[0].id;
}

/** The original Money export contract has canonical account keys but a generic
 * provider. Exercise its real ZIP/JSON round trip and destination ID mapping. */
async function installImportedMoneyAccounts(namespace = "money-site:synthetic-original", keys = ["hubtel-wallet", "mtn-momo"]) {
  const native = keys.map((account) => ({ account, label: account === "hubtel-wallet" ? "Holiday reserve" : "Everyday phone funds", cash: true, date: NOW.toISOString() }));
  const bytes = await createArchive({ sourceApp: "money-tracker", namespace, timezone: "Africa/Accra", currency: "GHS", exportedAt: NOW.toISOString(), coverage: [], datasets: {
    accounts: native.map((row) => ({ id: row.account, label: row.label, provider: "Imported Money Tracker", currency: "GHS", includeInCash: row.cash, createdAt: row.date })),
    movements: [], snapshots: [], transfers: [], settlements: [], "moneyTracker.native": { snapshot: { currency: "GHS", accounts: native, transactions: [], transfers: [] }, planning: {}, bills: {} },
  } });
  const archive = await readArchive(bytes) as ImportArchive;
  const before = (await saved()).accounts.every((row) => row.provider !== "Imported Money Tracker") ? emptyAccountingState(OWNER) : await saved();
  const plan = planImport(before, archive, `receipt:${namespace}`, NOW.toISOString());
  expect(plan.conflicts).toEqual([]);
  await db.query("update accounting_states set revision=$2,state=$3::jsonb where owner_id=$1", [OWNER, plan.next.revision, JSON.stringify(plan.next)]);
  await db.query(`insert into finance_import_receipts(owner_id,id,archive_id,archive,summary,before_state,after_state,source_version_after)
    values($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,public.alfred_accounting_source_version($1::uuid))`,
  [OWNER, `receipt:${namespace}`, archive.archiveId, JSON.stringify(archive), JSON.stringify(plan.summary), JSON.stringify(before), JSON.stringify(plan.next)]);
  return { archive, imported: plan.next };
}

describe("Money-imported account identities through actual transfer ingestion", () => {
  it("recognizes the canonical imported Hubtel/MoMo pair without guessing labels or rewriting saved provider metadata", async () => {
    const { archive, imported } = await installImportedMoneyAccounts();
    const originalAccounts = structuredClone(imported.accounts);
    expect(originalAccounts.every((row) => row.id.startsWith("import:accounts:") && row.provider === "Imported Money Tracker")).toBe(true);
    await ingest(outgoing("1.00", "88123456", "0.38"));
    const second = await ingest(incoming());
    expect(second.outcomes[0].outcome).toBe("transfer");
    const state = await saved();
    expect(state.transfers).toHaveLength(1);
    expect(state.accounts).toEqual(originalAccounts);
    expect(buildAccountingView(state, "GHS").totals).toEqual({ incomeMinor: 0, spentMinor: 38 });
    const contexts = await loadOwnTransferNotices(settings, OWNER, second.durableMessageIds);
    expect(contexts.get(second.durableMessageIds[0])).toMatchObject({ state: "paired", fromAccount: { label: "Holiday reserve" }, toAccount: { label: "Everyday phone funds" } });
    const replay = planImport(state, archive, "repeat-original-archive", NOW.toISOString());
    expect(replay.conflicts).toEqual([]); expect(replay.duplicates).toBe(2); expect(replay.additions.accounts).toBe(0);
    const stored = (await db.query<{ state: AccountingState }>("select state from accounting_states where owner_id=$1", [OWNER])).rows[0].state;
    expect(stored.accounts).toEqual(originalAccounts);
    expect(stored).not.toHaveProperty("transferProviders");
    expect(stored.audit.at(-1)?.before.accounts).toEqual(originalAccounts);
  });
  it.each(["missing", "undone"] as const)("keeps both alerts unpaired when retained Money proof is %s", async (condition) => {
    await installImportedMoneyAccounts();
    if (condition === "missing") await db.query("delete from finance_import_receipts where owner_id=$1", [OWNER]);
    else await db.query("update finance_import_receipts set undone_at=now() where owner_id=$1", [OWNER]);
    await ingest(outgoing()); await ingest(incoming());
    const state = await saved();
    expect(state.transfers).toHaveLength(0); expect(state.movements).toHaveLength(2);
    expect(state.movements.every((row) => row.status === "review" && row.accountId === null)).toBe(true);
  });
  it("does not choose between two independently imported Hubtel cash accounts", async () => {
    await installImportedMoneyAccounts();
    await installImportedMoneyAccounts("money-site:synthetic-second", ["hubtel-wallet"]);
    await ingest(outgoing()); await ingest(incoming());
    expect((await saved()).transfers).toHaveLength(0);
    expect((await saved()).accounts).toHaveLength(3);
  });
  it("preserves a later owner provider edit instead of forcing the discovered imported account into the pair", async () => {
    await installImportedMoneyAccounts();
    await ingest(outgoing("1.00", "88123456", "0.38"));
    injectedFailure = "provider-edit";
    await ingest(incoming());
    const loaded = await loadAccountingState(settings, OWNER);
    expect(loaded.state.transfers).toHaveLength(0);
    expect(loaded.state.accounts[0].provider).toBe("Fictional other bank");
    expect(loaded.state.movements).toHaveLength(2);
    expect(loaded.state.movements.every((row) => row.status === "review")).toBe(true);
    expect(projectAccountingTransactions(loaded.rawTransactions, loaded.state).filter((row) => row.status === "active")).toMatchObject([{ category: "Fees", amount: "0.38" }]);
    expect((await db.query("select * from accounting_events where action='automatic_pair_transfer'")).rows).toHaveLength(0);
  });
});

describe("deterministic owner-account transfers through durable ingest", () => {
  it("uses a bounded pair preflight without loading accounting history for an unmatched first alert", async () => {
    statementTrace.length = 0;
    await ingest(outgoing());
    expect(statementTrace.some((sql) => sql.includes("pivot.id=any($2::uuid[])"))).toBe(true);
    expect(statementTrace.some((sql) => sql.includes("select state from public.accounting_states") || sql.includes("alfred_accounting_source_version") || sql.includes("order by occurred_at desc limit 200"))).toBe(false);
  });
  it.each(["0.01", "0.50", "1.00", "125.25"])("pairs both observed Hubtel→MTN legs at GHS%s and keeps only fees in spending", async (amount) => {
    await ingest(outgoing(amount, "88123456", "0.38"));
    const second = await ingest(incoming(amount));
    expect(second.outcomes[0]).toMatchObject({ outcome: "transfer", message: { kind: "transfer_own", status: "transfer" } });
    const state = await saved();
    expect(state.transfers).toHaveLength(1);
    expect(state.movements.map((row) => [row.direction, row.accountId, row.status]).sort()).toEqual([["in", "mtn-wallet", "transfer"], ["out", "hubtel-wallet", "transfer"]]);
    expect(buildAccountingView(state, "GHS").totals).toEqual({ incomeMinor: 0, spentMinor: 38 });
    expect(state.snapshots.map((row) => row.balanceMinor).sort((a, b) => a - b)).toEqual([9900, 10000]);
    expect((await db.query("select * from transactions")).rows).toHaveLength(1);
    const contexts = await loadOwnTransferNotices(settings, OWNER, state.movements.map((row) => row.sourceId));
    expect(contexts.size).toBe(2);
    expect([...contexts.values()].every((row) => row.state === "paired" && row.fromAccount.label === "Everyday Hubtel wallet" && row.toAccount.label === "Personal MTN MoMo" && row.amount === amount)).toBe(true);
  });

  it("recognizes the pair in reverse arrival order and never creates a missing counterleg", async () => {
    const first = await ingest(incoming());
    expect((await saved()).transfers).toHaveLength(0);
    expect((await saved()).movements).toHaveLength(1);
    expect(first.outcomes[0].outcome).toBe("needs_label");
    await ingest(outgoing());
    expect((await saved()).transfers).toHaveLength(1);
  });

  it("replays both alerts and a chat acknowledgement without another pair or accounting revision", async () => {
    const first = await ingest(outgoing()), second = await ingest(incoming());
    const revision = (await saved()).revision;
    expect((await ingest(outgoing())).duplicates).toBe(1);
    expect((await ingest(incoming())).duplicates).toBe(1);
    const reply = await createTransferConversationDeps(settings).confirm(OWNER, second.durableMessageIds[0], { requestId: "repeat-confirm", evidenceFingerprint: "already-paired" });
    expect(reply).toMatchObject({ status: "paired", changed: false });
    expect((await saved()).revision).toBe(revision);
    expect((await saved()).transfers).toHaveLength(1);
    expect((await db.query("select * from bank_messages")).rows).toHaveLength(2);
    expect(first.durableMessageIds).toHaveLength(1);
  });

  it("asks about a time/amount coincidence and accepts an explicit chat confirmation without a modal", async () => {
    await ingest(outgoing());
    const received = await ingest(incoming("1.00", "92300000001", "FICTIONAL EXTERNAL PERSON"));
    expect((await saved()).transfers).toHaveLength(0);
    const conversation = createTransferConversationDeps(settings);
    expect(await conversation.inspect(OWNER, received.durableMessageIds[0])).toMatchObject({ status: "candidate", transfer: { state: "candidate" } });
    const context = await conversation.inspect(OWNER, received.durableMessageIds[0]);
    expect(await conversation.confirm(OWNER, received.durableMessageIds[0], { requestId: "confirm-observed-pair", evidenceFingerprint: context.evidenceFingerprint, expectedPairId: context.transfer?.pairId })).toMatchObject({ status: "paired", changed: true });
    expect(buildAccountingView(await saved(), "GHS").totals).toEqual({ incomeMinor: 0, spentMinor: 0 });
  });

  it("does not pick among two equally possible receiving legs", async () => {
    await ingest(incoming("1.00", "92300000001")); await ingest(incoming("1.00", "92300000002"));
    const sent = await ingest(outgoing());
    expect((await saved()).transfers).toHaveLength(0);
    expect(await createTransferConversationDeps(settings).inspect(OWNER, sent.durableMessageIds[0])).toMatchObject({ status: "ambiguous" });
  });

  it("requires a chat account choice when the owner has two Hubtel wallets", async () => {
    const state = await saved(); state.accounts.push({ ...state.accounts[0], id: "second-hubtel", label: "Second Hubtel wallet" });
    await db.query("update accounting_states set state=$2::jsonb where owner_id=$1", [OWNER, JSON.stringify(state)]);
    const sent = await ingest(outgoing()); await ingest(incoming());
    expect((await saved()).transfers).toHaveLength(0);
    const conversation = createTransferConversationDeps(settings);
    const context = await conversation.inspect(OWNER, sent.durableMessageIds[0]);
    const result = await conversation.confirm(OWNER, sent.durableMessageIds[0], { requestId: "choose-two-saved-accounts", fromAccountId: "hubtel-wallet", toAccountId: "mtn-wallet", evidenceFingerprint: context.evidenceFingerprint });
    expect(result).toMatchObject({ status: "paired", changed: true, transfer: { fromAccount: { id: "hubtel-wallet" } } });
    expect((await saved()).transfers).toHaveLength(1);
  });

  it("never pairs across owners or accepts another owner's bank ID", async () => {
    const sent = await ingest(outgoing()); await ingest(incoming(), { ...profile, profileId: OTHER });
    expect((await saved()).transfers).toHaveLength(0);
    const conversation = createTransferConversationDeps(settings);
    expect(await conversation.inspect(OTHER, sent.durableMessageIds[0])).toMatchObject({ status: "none", accounts: [] });
    expect(await conversation.confirm(OTHER, sent.durableMessageIds[0], { requestId: "foreign-bank-id", evidenceFingerprint: "foreign" })).toEqual({ status: "stale", changed: false });
  });

  it("keeps a skipped or manually labelled side unchanged", async () => {
    const sent = await ingest(outgoing());
    await db.query("update bank_messages set status='skipped' where id=$1", [sent.durableMessageIds[0]]);
    await ingest(incoming());
    expect((await saved()).transfers).toHaveLength(0);
    expect((await db.query<{ status: string }>("select status from bank_messages where id=$1", [sent.durableMessageIds[0]])).rows[0].status).toBe("skipped");
  });

  it("keeps a newly stored SMS and its fee when a late pair-event write fails, with no half-written classification or accounting state", async () => {
    const sent = await ingest(outgoing("1.00", "88123456", "0.38"));
    await db.exec("create function fixture_reject_transfer() returns trigger language plpgsql as $$begin if new.action='automatic_pair_transfer' then raise exception 'Synthetic interrupted transfer';end if;return new;end$$;create trigger fixture_reject_transfer before insert on accounting_events for each row execute function fixture_reject_transfer()");
    statementTrace.length = 0;
    const received = await ingest(incoming());
    expect(received).toMatchObject({ found: 1, duplicates: 0, outcomes: [{ outcome: "needs_label" }] });
    expect((await db.query("select * from bank_messages")).rows).toHaveLength(2);
    expect((await db.query<{ status: string }>("select status from bank_messages where id=$1", [sent.durableMessageIds[0]])).rows[0].status).toBe("needs_label");
    expect((await db.query<{ status: string; kind: string }>("select status,kind from bank_messages")).rows.every((row) => row.status === "needs_label" && row.kind === "payment")).toBe(true);
    expect((await saved())).toMatchObject({ revision: 0, transfers: [], snapshots: [], audit: [] });
    expect((await db.query("select * from accounting_events")).rows).toHaveLength(0);
    expect((await db.query<{ amount: string; category: string }>("select amount::text,category from transactions")).rows).toEqual([{ amount: "0.38", category: "Fees" }]);
    expect(statementTrace).toContain("rollback to savepoint alfred_automatic_transfer_pair");
    expect(statementTrace).toContain("release savepoint alfred_automatic_transfer_pair");
    await db.exec("drop trigger fixture_reject_transfer on accounting_events");
    const conversation = createTransferConversationDeps(settings), context = await conversation.inspect(OWNER, received.durableMessageIds[0]);
    expect(await conversation.confirm(OWNER, received.durableMessageIds[0], { requestId: "recover-pair-in-chat", evidenceFingerprint: context.evidenceFingerprint, expectedPairId: context.transfer!.pairId })).toMatchObject({ status: "paired", changed: true });
    expect((await saved()).transfers).toHaveLength(1);
    expect((await db.query("select * from transactions")).rows).toHaveLength(1);
  });

  it.each([
    ["out", "12:00", "12:09", "12:18"],
    ["out", "12:18", "12:09", "12:00"],
    ["out", "12:00", "12:10", "12:20"],
    ["in", "12:00", "12:09", "12:18"],
  ])("records a late %s at %s without hiding its %s counterpart's competitor at %s", async (direction, newAt, oppositeAt, competitorAt) => {
    const at = (time: string) => `2026-11-04T${time}:00Z`;
    await seedPending(direction === "out" ? incoming("200.00") : outgoing("200.00"), at(oppositeAt));
    await seedPending(direction === "out" ? outgoing("200.00", "88123457") : incoming("200.00", "92300000002"), at(competitorAt));
    const text = direction === "out" ? outgoing("200.00", "88123456", "0.38") : incoming("200.00", "92300000001");
    const result = await ingestBankMessages(settings, profile, text, { channel: "mac", sender: direction === "out" ? "Hubtel" : "MobileMoney", receivedAt: new Date(at(newAt)) });
    expect(result).toMatchObject({ found: 1, duplicates: 0, outcomes: [{ outcome: "needs_label" }] });
    expect((await db.query("select * from bank_messages")).rows).toHaveLength(3);
    expect((await db.query<{ status: string; kind: string }>("select status,kind from bank_messages")).rows.every((row) => row.status === "needs_label" && row.kind === "payment")).toBe(true);
    expect((await saved())).toMatchObject({ revision: 0, transfers: [], audit: [] });
    expect((await db.query("select * from accounting_events")).rows).toHaveLength(0);
  });

  it("rolls back an expected accounting CAS rejection to its savepoint while retaining the new SMS", async () => {
    await ingest(outgoing("1.00", "88123456", "0.38"));
    await db.exec(`alter function public.alfred_write_accounting_state(uuid,bigint,text,text,text,jsonb) rename to fixture_normal_accounting_write;
      create function public.alfred_write_accounting_state(owner uuid,expected_revision bigint,request_key text,fingerprint text,source_version text,next_state jsonb) returns jsonb language sql as $$select public.fixture_normal_accounting_write(owner,expected_revision+1,request_key,fingerprint,source_version,next_state)$$;`);
    const result = await ingest(incoming());
    expect(result).toMatchObject({ found: 1, outcomes: [{ outcome: "needs_label" }] });
    expect((await db.query("select * from bank_messages")).rows).toHaveLength(2);
    expect((await db.query<{ status: string }>("select status from bank_messages")).rows.every((row) => row.status === "needs_label")).toBe(true);
    expect((await saved())).toMatchObject({ revision: 0, transfers: [], snapshots: [], audit: [] });
    expect((await db.query("select * from accounting_events")).rows).toHaveLength(0);
    expect((await db.query<{ amount: string }>("select amount::text from transactions")).rows).toEqual([{ amount: "0.38" }]);
  });

  it("does not mistake a competitor outside the latest 200 source rows for a unique pair", async () => {
    await seedPending(incoming("200.00"), "2026-11-04T12:09:00Z");
    const competitor = await seedPending(outgoing("200.00", "88123457"), "2026-11-04T11:59:00Z");
    await db.query(`insert into bank_messages(owner_id,source,channel,external_id,text_hash,direction,kind,amount,fee,currency,counterparty,balance,occurred_at,status,raw,read_by)
      select $1,'hubtel','mac',(88000000+n)::text,'synthetic-distractor-'||n,'out','payment',7.77,0,'GHS','Hubtel wallet',null,'2026-11-04T12:05:00Z','needs_label','Synthetic unrelated source','rules' from generate_series(1,198) n`, [OWNER]);
    const result = await ingestBankMessages(settings, profile, outgoing("200.00", "88123456", "0.38"), { channel: "mac", sender: "Hubtel", receivedAt: new Date("2026-11-04T12:00:00Z") });
    expect(result).toMatchObject({ found: 1, duplicates: 0, outcomes: [{ outcome: "needs_label" }] });
    const window = await listBankTransferWindow(settings, OWNER, result.durableMessageIds);
    expect(window.complete).toBe(true); expect(window.messages.map((row) => row.id)).toContain(competitor);
    const loaded = await loadAccountingState(settings, OWNER);
    expect(loaded.bankMessages?.some((row) => row.id === competitor)).toBe(false);
    expect(loaded.bankMessages?.some((row) => row.id === result.durableMessageIds[0])).toBe(true);
    expect((await db.query<{ status: string }>("select status from bank_messages where id=any($1::uuid[])", [[competitor, ...result.durableMessageIds]])).rows.every((row) => row.status === "needs_label")).toBe(true);
    expect(loaded.state).toMatchObject({ revision: 0, transfers: [], audit: [] });
    expect(await createTransferConversationDeps(settings).inspect(OWNER, result.durableMessageIds[0])).toMatchObject({ status: "unavailable" });
  });

  it("defers an overflowing complete-window check instead of falling back to a truncated set", async () => {
    await db.query(`insert into bank_messages(owner_id,source,channel,external_id,text_hash,direction,kind,amount,fee,currency,counterparty,balance,occurred_at,status,raw,read_by)
      select $1,'momo','mac',(93000000000+n)::text,'synthetic-overflow-'||n,'in','payment',200,0,'GHS','Credit.Inv',null,$2,'needs_label','Synthetic incoming rail source','rules' from generate_series(1,400) n`, [OWNER, NOW.toISOString()]);
    statementTrace.length = 0;
    const result = await ingest(outgoing("200.00", "88123456", "0.38"));
    expect(result).toMatchObject({ found: 1, duplicates: 0, outcomes: [{ outcome: "needs_label" }] });
    expect(statementTrace.some((sql) => sql.includes("alfred_accounting_source_version"))).toBe(false);
    expect(await listBankTransferWindow(settings, OWNER, result.durableMessageIds)).toEqual({ complete: false, messages: [] });
    expect((await db.query("select * from bank_messages")).rows).toHaveLength(401);
    expect((await db.query<{ revision: number; state: AccountingState }>("select revision,state from accounting_states where owner_id=$1", [OWNER])).rows[0].state).toMatchObject({ revision: 0, transfers: [], audit: [] });
  });

  it("keeps valid new evidence when optional discovery sees a source-version race before any pairing writes", async () => {
    await ingest(outgoing("1.00", "88123456", "0.38"));
    injectedFailure = "source-version";
    const result = await ingest(incoming()); injectedFailure = null;
    expect(result).toMatchObject({ found: 1, duplicates: 0, outcomes: [{ outcome: "needs_label" }] });
    expect((await db.query("select * from bank_messages")).rows).toHaveLength(2);
    expect((await db.query<{ status: string }>("select status from bank_messages")).rows.every((row) => row.status === "needs_label")).toBe(true);
    expect((await saved())).toMatchObject({ revision: 0, transfers: [], snapshots: [], audit: [] });
    expect((await db.query("select * from accounting_events")).rows).toHaveLength(0);
    expect((await db.query<{ amount: string }>("select amount::text from transactions")).rows).toEqual([{ amount: "0.38" }]);
  });

  it.each(["connection", "rollback", "pipe"] as const)("does not acknowledge ingestion when %s uncertainty prevents safely accepting the optional pair", async (failure) => {
    await ingest(outgoing());
    if (failure === "rollback") await db.exec("create function fixture_reject_transfer() returns trigger language plpgsql as $$begin raise exception 'Synthetic pair write failure';end$$;create trigger fixture_reject_transfer before insert on accounting_events for each row execute function fixture_reject_transfer()");
    injectedFailure = failure;
    await expect(ingest(incoming())).rejects.toThrow(/Synthetic (?:connection uncertainty|rollback connection failure|pipe failure)/);
    injectedFailure = null;
    expect((await db.query("select * from bank_messages")).rows).toHaveLength(1);
    expect((await db.query<{ status: string }>("select status from bank_messages")).rows[0].status).toBe("needs_label");
    expect((await saved())).toMatchObject({ revision: 0, transfers: [], audit: [] });
  });

  it("invalidates the entire automatic pair after one source changes while keeping an active fee exactly once", async () => {
    await ingest(outgoing("1.00", "88123456", "0.38")); const received = await ingest(incoming());
    await db.query("update bank_messages set amount=2 where id=$1", [received.durableMessageIds[0]]);
    const loaded = await loadAccountingState(settings, OWNER);
    expect(loaded.state.movements.every((row) => row.status === "review" && row.automaticTransferStale)).toBe(true);
    expect(buildAccountingView(loaded.state, "GHS").totals).toEqual({ incomeMinor: 0, spentMinor: 38 });
    const projected = projectAccountingTransactions(loaded.rawTransactions, loaded.state);
    expect(projected.filter((row) => row.status === "active")).toHaveLength(1);
    expect(projected[0]).toMatchObject({ type: "expense", category: "Fees", amount: "0.38" });
    expect((await loadOwnTransferNotices(settings, OWNER, received.durableMessageIds)).size).toBe(0);
  });

  it("corrects an automatic pair in chat, retains fees, and never silently re-pairs a rejected source pair", async () => {
    await ingest(outgoing("1.00", "88123456", "0.38")); const received = await ingest(incoming());
    const conversation = createTransferConversationDeps(settings), context = await conversation.inspect(OWNER, received.durableMessageIds[0]);
    expect(await conversation.reject(OWNER, received.durableMessageIds[0], { requestId: "reject-exact-auto-pair", evidenceFingerprint: context.evidenceFingerprint, expectedPairId: context.transfer!.pairId })).toEqual({ status: "unpaired", changed: true });
    expect((await saved()).transfers).toHaveLength(0);
    expect((await saved()).transferRejections).toEqual([context.transfer!.pairId]);
    expect((await saved()).audit.at(-1)!.before.transfers).toHaveLength(1);
    expect((await saved()).audit.at(-1)!.before.movements.every((row) => row.status === "transfer")).toBe(true);
    expect(buildAccountingView(await saved(), "GHS").totals).toEqual({ incomeMinor: 0, spentMinor: 38 });
    await ingest(outgoing()); await ingest(incoming());
    expect((await saved()).transfers).toHaveLength(0);
    await db.query("delete from bank_messages where id=$1", [received.durableMessageIds[0]]);
    await ingest(incoming("1.00", "92300000002"));
    expect((await saved()).transfers).toHaveLength(0);
  });

  it("refuses a stale yes when the underlying receiving source was edited", async () => {
    await ingest(outgoing()); const received = await ingest(incoming("1.00", "92300000001", "FICTIONAL EXTERNAL PERSON"));
    const conversation = createTransferConversationDeps(settings), context = await conversation.inspect(OWNER, received.durableMessageIds[0]);
    await db.query("update bank_messages set counterparty='CHANGED SOURCE' where id=$1", [received.durableMessageIds[0]]);
    expect(await conversation.confirm(OWNER, received.durableMessageIds[0], { requestId: "stale-confirm", evidenceFingerprint: context.evidenceFingerprint, expectedPairId: context.transfer!.pairId })).toEqual({ status: "stale", changed: false });
    expect((await saved()).transfers).toHaveLength(0);
  });

  it("preserves an active standalone fee in both reports after its outgoing bank source disappears", async () => {
    const sent = await ingest(outgoing("1.00", "88123456", "0.38")); await ingest(incoming());
    await db.query("delete from bank_messages where id=$1", [sent.durableMessageIds[0]]);
    const loaded = await loadAccountingState(settings, OWNER);
    expect(buildAccountingView(loaded.state, "GHS").totals).toEqual({ incomeMinor: 0, spentMinor: 38 });
    const active = projectAccountingTransactions(loaded.rawTransactions, loaded.state).filter((row) => row.status === "active");
    expect(active).toHaveLength(1); expect(active[0]).toMatchObject({ type: "expense", category: "Fees", amount: "0.38" });
  });

  it("a chat rejection overrides an earlier own-name heuristic and leaves both legs open for a conversational purpose", async () => {
    await db.query("update profiles set account_names='FICTIONAL OWNER' where id=$1", [OWNER]);
    await ingest(outgoing("1.00", "88123456", "0.38")); const received = await ingest(incoming("1.00", "92300000001", "FICTIONAL OWNER"));
    const conversation = createTransferConversationDeps(settings), context = await conversation.inspect(OWNER, received.durableMessageIds[0]);
    expect(context.status).toBe("paired");
    expect(await conversation.reject(OWNER, received.durableMessageIds[0], { requestId: "reject-heuristic-pair", expectedPairId: context.transfer!.pairId, evidenceFingerprint: context.evidenceFingerprint })).toEqual({ status: "unpaired", changed: true });
    expect((await db.query<{ status: string; kind: string }>("select status,kind from bank_messages")).rows.every((row) => row.status === "needs_label" && row.kind === "payment")).toBe(true);
    expect((await saved()).movements.every((row) => row.status === "review")).toBe(true);
    expect(buildAccountingView(await saved(), "GHS").totals).toEqual({ incomeMinor: 0, spentMinor: 38 });
  });
});

describe("the real transfer store behind conversational replies", () => {
  it("links an observed candidate from a natural account statement and keeps retries idempotent", async () => {
    const { answerTransferConversation } = await import("@/lib/bank/transfer-conversation");
    const { MemoryMessageLog } = await import("@/lib/accounts/messages");
    await ingest(outgoing());
    const received = await ingest(incoming("1.00", "92300000001", "FICTIONAL EXTERNAL PERSON"));
    const bankMessageId = received.durableMessageIds[0];
    const service = createTransferConversationDeps(settings), messages = new MemoryMessageLog();
    const input = { text: "from my Hubtel wallet to my MTN MoMo account", ownerId: OWNER,
      focus: { bankMessageId, requiresPurpose: true }, clientId: "real-store-chat-transfer", service, messages };
    const reply = await answerTransferConversation(input);
    expect(reply?.intent).toBe("bank:transfer-paired");
    expect(reply?.text).toContain("Everyday Hubtel wallet");
    expect(reply?.text).toContain("Personal MTN MoMo");
    expect((await saved()).transfers).toHaveLength(1);
    const revision = (await saved()).revision;
    expect((await answerTransferConversation(input))?.intent).toBe("bank:transfer-paired");
    expect((await saved()).revision).toBe(revision);
    expect((await db.query("select * from transactions")).rows).toEqual([]);
  });

  it("unlinks an exact rejected automatic pair through chat and preserves the original fee", async () => {
    const { answerTransferConversation } = await import("@/lib/bank/transfer-conversation");
    const { MemoryMessageLog } = await import("@/lib/accounts/messages");
    await ingest(outgoing("1.00", "88123456", "0.38"));
    const received = await ingest(incoming());
    const bankMessageId = received.durableMessageIds[0];
    const service = createTransferConversationDeps(settings), messages = new MemoryMessageLog();
    const question = await answerTransferConversation({ text: "no, it was a gift", ownerId: OWNER,
      focus: { bankMessageId, requiresPurpose: false }, clientId: "real-store-chat-unpair-question", service, messages });
    expect(question?.text).toContain("Should I unlink");
    expect((await saved()).transfers).toHaveLength(1);
    await messages.append({ ownerId: OWNER, role: "assistant", channel: "web", body: question!.text, intent: question?.intent, paymentNotice: question?.paymentNotice });
    const reply = await answerTransferConversation({ text: "yes", ownerId: OWNER, focus: question!.paymentNotice,
      clientId: "real-store-chat-unpair-answer", service, messages });
    expect(reply?.intent).toBe("bank:transfer-unpaired");
    expect((await saved()).transfers).toHaveLength(0);
    expect((await db.query<{ status: string }>("select status from bank_messages order by id")).rows.map(row => row.status)).toEqual(["needs_label", "needs_label"]);
    expect(buildAccountingView(await saved(), "GHS").totals).toEqual({ incomeMinor: 0, spentMinor: 38 });
    expect((await db.query<{ category: string; amount: string }>("select category,amount::text from transactions")).rows).toEqual([{ category: "Fees", amount: "0.38" }]);
  });
});
