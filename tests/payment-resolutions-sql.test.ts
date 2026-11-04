import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ALFRED_SUPABASE_HOST, ALFRED_SUPABASE_PROJECT_REF, ALFRED_SUPABASE_USER, type SupabaseSettings } from "@/lib/config";

const transport = vi.hoisted(() => ({ connect: vi.fn(), outside: vi.fn() }));
vi.mock("node:dns/promises", () => ({ resolve4: async () => ["127.0.0.1"] }));
vi.mock("pg", () => ({ types: { setTypeParser: vi.fn() }, Pool: class { on() {} connect = transport.connect; query = transport.outside; async end() {} } }));
import { createSupabaseBankStore, type BankMessage, type NewBankMessage } from "@/lib/bank/store";
import { createPaymentResolutionDeps, loadPaymentResolutionNotice } from "@/lib/bank/payment-resolutions";
import { loadAccountingState, saveAccountingAction } from "@/lib/finance/accounting/persisted-store";
import { buildAccountingView } from "@/lib/finance/accounting/view";
import { emptyAccountingState } from "@/lib/finance/accounting/types";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AT = "2026-11-04T12:00:00.000Z", EARLIER = "2026-11-04T11:00:00.000Z";
const settings: SupabaseSettings = { host: ALFRED_SUPABASE_HOST, projectRef: ALFRED_SUPABASE_PROJECT_REF, user: ALFRED_SUPABASE_USER, database: "postgres", password: "synthetic-no-network" };
let db: PGlite, available = Promise.resolve(), sequence = 0;
const statements: string[] = [];
const service = () => createPaymentResolutionDeps(settings);
const bank = () => createSupabaseBankStore(settings);
const state = async (owner = OWNER) => (await loadAccountingState(settings, owner, undefined, undefined, false)).state;
const rows = async <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, values: unknown[] = []) => (await db.query<T>(sql, values)).rows;

beforeAll(async () => {
  db = new PGlite();
  await db.exec("create role anon; create role authenticated; create schema auth; create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$; create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}'::jsonb);");
  for (const name of readdirSync("supabase/migrations").filter(name => name.endsWith(".sql")).sort()) await db.exec(readFileSync(`supabase/migrations/${name}`, "utf8"));
  // One-session SQL rollback rehearsal, not a simultaneous-session lock claim.
  transport.connect.mockImplementation(async () => {
    const previous = available; let release!: () => void;
    available = new Promise<void>(resolve => { release = resolve; }); await previous;
    return { query: (text: string, values: unknown[] = []) => { statements.push(text); return db.query(text, values); }, release };
  });
  transport.outside.mockImplementation((text: string, values: unknown[] = []) => { statements.push(text); return db.query(text, values); });
}, 30_000);
beforeEach(async () => {
  sequence = 0; statements.length = 0;
  await db.exec("drop trigger if exists fixture_reject_resolution on bank_payment_resolutions; drop trigger if exists fixture_reject_resolution_event on accounting_events; drop function if exists fixture_reject_resolution_write(); truncate auth.users cascade;");
  await db.query("insert into auth.users(id) values($1),($2)", [OWNER, OTHER]);
  for (const ownerId of [OWNER, OTHER]) await db.query("insert into accounting_states(owner_id,revision,state) values($1,0,$2::jsonb)", [ownerId, JSON.stringify(emptyAccountingState(ownerId))]);
});
afterAll(async () => { await available; await db.close(); });

async function ledger(source: BankMessage, amount: string, fee = false): Promise<string> {
  const id = `10000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
  await db.query(`insert into transactions(transaction_id,created_at,transaction_date,user_id,owner_id,type,amount,currency,category,description,payment_method,notes,status,updated_at,source_update_id)
    values($1::uuid,$2::timestamptz,'2026-11-04',$3::text,$3::text::uuid,'expense',$4::numeric,$5,$6,$7,'MTN MoMo','','active',$2::timestamptz,$8)`,
  [id, source.occurredAt, source.ownerId, amount, source.currency, fee ? "Fees" : "Food", fee ? "Fictional actual fee" : "Fictional original purchase", `bank:${source.id}${fee ? ":fee" : ""}`]);
  return id;
}
async function pending(direction: "in" | "out" = "out", amount = "9.00", overrides: Partial<NewBankMessage> = {}): Promise<BankMessage> {
  const index = ++sequence;
  const source = (await bank().insertMessage({ ownerId: OWNER, source: "momo", channel: "mac", externalId: `fictional-${index}`, textHash: `fictional-hash-${index}`,
    direction, kind: "payment", amount, fee: "0.00", currency: "GHS", counterparty: "FICTIONAL MERCHANT", balance: "123.45", occurredAt: AT, status: "needs_label", raw: `Fictional immutable bank alert ${index}`, ...overrides }))!;
  if (Number(source.fee) > 0) await bank().updateMessage(source.ownerId, source.id, { feeTransactionId: await ledger(source, source.fee, true) });
  return (await bank().getMessage(source.ownerId, source.id))!;
}
async function purchase(amount = "100.00", fee = "1.00"): Promise<BankMessage> {
  const source = await pending("out", amount, { occurredAt: EARLIER, fee });
  await bank().updateMessage(OWNER, source.id, { transactionId: await ledger(source, amount), status: "recorded" });
  return (await bank().getMessage(OWNER, source.id))!;
}
async function noMoney(source: BankMessage, requestId = "no-money-fixture") {
  const deps = service(), context = await deps.inspect(source.ownerId, source.id);
  const input = { requestId, evidenceFingerprint: context.evidenceFingerprint, reason: "failed" as const };
  return { deps, context, input, result: await deps.noMoney(source.ownerId, source.id, input) };
}
async function returned(original: BankMessage, incoming: BankMessage, requestId = "return-fixture", focus = incoming) {
  const deps = service(), context = await deps.inspect(OWNER, focus.id);
  const input = { requestId, evidenceFingerprint: context.evidenceFingerprint, originalId: `bank:${original.id}`, returnBankMessageId: incoming.id, principalMinor: Math.round(Number(incoming.amount) * 100) };
  return { deps, context, input, result: await deps.returned(OWNER, focus.id, input) };
}

describe("explicit payment resolutions through the production SQL store", () => {
  it("closes only an explicitly confirmed pending non-movement, retaining source evidence and its genuine fee", async () => {
    const source = await pending("out", "9.00", { fee: "0.25" });
    const { context, result } = await noMoney(source);
    expect(context.noMoneyAllowed).toBe(true);
    expect(result).toEqual({ status: "saved", changed: true });
    const current = await bank().getMessage(OWNER, source.id);
    expect(current).toEqual({ ...source, status: "not_completed" });
    expect((await bank().listMessages(OWNER, "needs_label"))).toEqual([]);
    expect(buildAccountingView(await state(), "GHS").totals).toEqual({ incomeMinor: 0, spentMinor: 25 });
    const audit = (await rows<{ kind: string; reason: string; source_snapshot: BankMessage; accounting_revision: string }>("select kind,reason,source_snapshot,accounting_revision::text from bank_payment_resolutions"))[0];
    expect(audit).toMatchObject({ kind: "not_completed", reason: "failed", source_snapshot: source, accounting_revision: "1" });
    expect(await rows("select category,amount::text from transactions")).toEqual([{ category: "Fees", amount: "0.25" }]);
    expect((await state()).audit.at(-1)?.action).toBe("resolve_payment_no_money");
  });

  it("replays an exact no-money confirmation without another write, but rejects altered intent", async () => {
    const source = await pending();
    const { deps, input } = await noMoney(source);
    const revision = (await state()).revision;
    expect(await deps.noMoney(OWNER, source.id, input)).toEqual({ status: "duplicate", changed: false });
    expect(await deps.noMoney(OWNER, source.id, { ...input, reason: "not_completed" })).toEqual({ status: "stale", changed: false });
    expect((await state()).revision).toBe(revision);
    expect(await rows("select id from bank_payment_resolutions")).toHaveLength(1);
  });

  it.each(["recorded", "loan", "transfer"] as const)("does not turn a protected %s source into a failed payment", async status => {
    const source = status === "recorded" ? await purchase() : await pending("out", "9.00", { status, kind: status === "transfer" ? "transfer_own" : "loan_out" });
    const before = await bank().getMessage(OWNER, source.id), context = await service().inspect(OWNER, source.id);
    expect(context.noMoneyAllowed).toBe(false);
    expect(await service().noMoney(OWNER, source.id, { requestId: "protected-source", evidenceFingerprint: context.evidenceFingerprint, reason: "not_completed" })).toEqual({ status: "protected", changed: false });
    expect(await bank().getMessage(OWNER, source.id)).toEqual(before);
    expect(await rows("select id from bank_payment_resolutions")).toEqual([]);
  });

  it("requires an exact owner and current source proof; missing proof never writes", async () => {
    const source = await pending(), context = await service().inspect(OWNER, source.id);
    expect(await service().noMoney(OWNER, source.id, { requestId: "missing-proof", evidenceFingerprint: "", reason: "failed" })).toEqual({ status: "stale", changed: false });
    expect(await service().noMoney(OTHER, source.id, { requestId: "foreign-source", evidenceFingerprint: context.evidenceFingerprint, reason: "failed" })).toEqual({ status: "stale", changed: false });
    expect((await service().inspect(OTHER, source.id)).source).toBeNull();
    await db.query("update bank_messages set raw=raw||' Fictional corrected evidence' where id=$1", [source.id]);
    expect(await service().noMoney(OWNER, source.id, { requestId: "stale-source", evidenceFingerprint: context.evidenceFingerprint, reason: "failed" })).toEqual({ status: "stale", changed: false });
    expect((await bank().getMessage(OWNER, source.id))?.status).toBe("needs_label");
    expect(await rows("select id from bank_payment_resolutions")).toEqual([]);
  });

  it.each(["resolution", "accounting"] as const)("rolls all classification and accounting back when the %s insert fails", async point => {
    const source = await pending("out", "9.00", { fee: "0.25" }), context = await service().inspect(OWNER, source.id);
    await db.exec("create function fixture_reject_resolution_write() returns trigger language plpgsql as $$begin raise exception 'Synthetic interrupted payment resolution';end$$;");
    await db.exec(point === "resolution" ? "create trigger fixture_reject_resolution before insert on bank_payment_resolutions for each row execute function fixture_reject_resolution_write()" : "create trigger fixture_reject_resolution_event before insert on accounting_events for each row execute function fixture_reject_resolution_write()");
    const input = { requestId: "rollback-resolution", evidenceFingerprint: context.evidenceFingerprint, reason: "failed" as const };
    await expect(service().noMoney(OWNER, source.id, input)).rejects.toThrow("Synthetic interrupted payment resolution");
    expect(await bank().getMessage(OWNER, source.id)).toEqual(source);
    expect((await state()).revision).toBe(0);
    expect(await rows("select revision from accounting_events")).toEqual([]);
    expect(await rows("select id from bank_payment_resolutions")).toEqual([]);
    expect(await rows("select category,amount::text from transactions")).toEqual([{ category: "Fees", amount: "0.25" }]);
    await db.exec("drop trigger if exists fixture_reject_resolution on bank_payment_resolutions; drop trigger if exists fixture_reject_resolution_event on accounting_events");
    expect(await service().noMoney(OWNER, source.id, input)).toEqual({ status: "saved", changed: true });
  });

  it.each(["incoming", "outgoing"] as const)("links only actual returned principal against the exact original from %s focus", async focus => {
    const original = await purchase(), incoming = await pending("in", "25.00");
    const { result } = await returned(original, incoming, `return-${focus}`, focus === "incoming" ? incoming : original);
    expect(result).toEqual({ status: "saved", changed: true });
    expect((await bank().getMessage(OWNER, incoming.id))?.status).toBe("returned");
    expect((await bank().getMessage(OWNER, original.id))).toEqual(original);
    const current = await state();
    expect(current.settlements).toHaveLength(1);
    expect(current.settlements[0].returns[0].principalMinor).toBe(2500);
    expect(buildAccountingView(current, "GHS").totals).toEqual({ incomeMinor: 0, spentMinor: 7600 });
    expect(await rows("select type,category,amount::text from transactions order by category")).toEqual([{ type: "expense", category: "Fees", amount: "1.00" }, { type: "expense", category: "Food", amount: "100.00" }]);
    expect(await loadPaymentResolutionNotice(settings, OWNER, incoming.id)).toContain("returned principal");
    expect(await loadPaymentResolutionNotice(settings, OWNER, original.id)).toContain("Only the returned amount");
  });

  it("supports several partial returns and never allocates more than the remaining original principal", async () => {
    const original = await purchase(), first = await pending("in", "25.00");
    await returned(original, first, "first-partial");
    const tooMuch = await pending("in", "76.00"), tooMuchContext = await service().inspect(OWNER, tooMuch.id);
    expect(await service().returned(OWNER, tooMuch.id, { requestId: "over-original-cap", evidenceFingerprint: tooMuchContext.evidenceFingerprint, originalId: `bank:${original.id}`, principalMinor: 7600 })).toEqual({ status: "protected", changed: false });
    expect((await bank().getMessage(OWNER, tooMuch.id))?.status).toBe("needs_label");
    const second = await pending("in", "75.00");
    expect((await returned(original, second, "second-partial")).result).toEqual({ status: "saved", changed: true });
    const current = await state();
    expect(current.settlements[0].returns.map(row => row.principalMinor).sort()).toEqual([2500, 7500]);
    expect(buildAccountingView(current, "GHS").totals).toEqual({ incomeMinor: 0, spentMinor: 100 });
  });

  it("requires an explicitly selected original/return and a matching currency instead of guessing", async () => {
    const first = await purchase(), second = await purchase(), incoming = await pending("in", "25.00");
    const context = await service().inspect(OWNER, incoming.id);
    expect(context.originals).toHaveLength(2);
    expect(await service().returned(OWNER, incoming.id, { requestId: "unknown-original", evidenceFingerprint: context.evidenceFingerprint, originalId: "missing-original", principalMinor: 2500 })).toEqual({ status: "protected", changed: false });
    const outgoing = await service().inspect(OWNER, first.id);
    expect(await service().returned(OWNER, first.id, { requestId: "missing-return-choice", evidenceFingerprint: outgoing.evidenceFingerprint, originalId: `bank:${first.id}`, principalMinor: 2500 })).toEqual({ status: "protected", changed: false });
    const foreign = await pending("in", "25.00", { currency: "USD" }), foreignContext = await service().inspect(OWNER, foreign.id);
    expect(foreignContext.originals).toEqual([]);
    expect(await service().returned(OWNER, foreign.id, { requestId: "wrong-currency", evidenceFingerprint: foreignContext.evidenceFingerprint, originalId: `bank:${second.id}`, principalMinor: 2500 })).toEqual({ status: "protected", changed: false });
    expect((await state()).settlements).toEqual([]);
  });

  it("replays exact return intent but rejects a changed original, amount or request key", async () => {
    const original = await purchase(), other = await purchase("90.00"), incoming = await pending("in", "25.00");
    const { deps, input } = await returned(original, incoming);
    expect(await deps.returned(OWNER, incoming.id, input)).toEqual({ status: "duplicate", changed: false });
    for (const patch of [{ originalId: `bank:${other.id}` }, { principalMinor: 1000 }, { requestId: "different-confirmation" }]) {
      expect(await deps.returned(OWNER, incoming.id, { ...input, ...patch })).toEqual({ status: "stale", changed: false });
    }
    expect((await state()).revision).toBe(1);
    expect(await rows("select id from bank_payment_resolutions")).toHaveLength(1);
  });

  it("safely reopens a no-money resolution with its immutable reason history and fee intact", async () => {
    const source = await pending("out", "9.00", { fee: "0.25" });
    await noMoney(source);
    const context = await service().inspect(OWNER, source.id), input = { requestId: "reopen-non-movement", evidenceFingerprint: context.evidenceFingerprint };
    expect(await service().reopen(OWNER, source.id, input)).toEqual({ status: "saved", changed: true });
    expect(await bank().getMessage(OWNER, source.id)).toEqual(source);
    expect((await state()).movements.find(row => row.sourceId === source.id)?.status).toBe("review");
    expect(buildAccountingView(await state(), "GHS").totals).toEqual({ incomeMinor: 0, spentMinor: 25 });
    expect((await rows<{ source_snapshot: BankMessage; reopened: boolean }>("select source_snapshot,reopened_at is not null as reopened from bank_payment_resolutions"))[0]).toEqual({ source_snapshot: source, reopened: true });
    expect(await loadPaymentResolutionNotice(settings, OWNER, source.id)).toBeNull();
    expect((await service().reopen(OWNER, source.id, input)).changed).toBe(false);
    expect((await state()).revision).toBe(2);
  });

  it("safely removes just the reopened return link while preserving the original expense and fee", async () => {
    const original = await purchase(), incoming = await pending("in", "25.00");
    await returned(original, incoming);
    const context = await service().inspect(OWNER, incoming.id);
    expect(await service().reopen(OWNER, incoming.id, { requestId: "reopen-return", evidenceFingerprint: context.evidenceFingerprint })).toEqual({ status: "saved", changed: true });
    expect((await state()).settlements).toEqual([]);
    expect((await bank().getMessage(OWNER, incoming.id))?.status).toBe("needs_label");
    expect(await bank().getMessage(OWNER, original.id)).toEqual(original);
    expect(buildAccountingView(await state(), "GHS").totals).toEqual({ incomeMinor: 0, spentMinor: 10100 });
  });

  it("does not reopen over a later explicit classification or give a stale affirmative notice", async () => {
    const source = await pending(); await noMoney(source);
    const current = await state(), movement = current.movements.find(row => row.sourceId === source.id)!;
    await saveAccountingAction(settings, OWNER, { type: "classify_movement", expectedRevision: current.revision, requestId: "later-explicit-classification", movement: { movementId: movement.id, sourceFingerprint: movement.sourceFingerprint }, status: "confirmed", category: "Food" });
    const context = await service().inspect(OWNER, source.id);
    expect(await service().reopen(OWNER, source.id, { requestId: "must-not-overwrite", evidenceFingerprint: context.evidenceFingerprint })).toEqual({ status: "protected", changed: false });
    expect(await loadPaymentResolutionNotice(settings, OWNER, source.id)).toContain("needs checking");
    expect((await state()).movements.find(row => row.id === movement.id)?.status).toBe("confirmed");
  });

  it("checks live original/fee facts on replay and compact entry without hydrating all accounting", async () => {
    const original = await purchase(), incoming = await pending("in", "25.00");
    const { deps, input } = await returned(original, incoming);
    statements.length = 0;
    expect(await loadPaymentResolutionNotice(settings, OWNER, incoming.id)).toContain("returned principal");
    expect(statements).toHaveLength(3);
    expect(statements.join(" ")).not.toContain("alfred_accounting_source_version");
    expect(statements.join(" ")).not.toContain("finance_import_receipts");
    await db.query("update transactions set amount=150.00 where transaction_id=$1", [original.transactionId]);
    expect(await loadPaymentResolutionNotice(settings, OWNER, incoming.id)).toContain("needs checking");
    expect(await deps.returned(OWNER, incoming.id, input)).toEqual({ status: "stale", changed: false });
    const context = await deps.inspect(OWNER, incoming.id);
    expect((await deps.reopen(OWNER, incoming.id, { requestId: "changed-principal-no-reopen", evidenceFingerprint: context.evidenceFingerprint })).changed).toBe(false);
    expect((await rows<{ amount: string }>("select amount::text from transactions where transaction_id=$1", [original.transactionId]))[0].amount).toBe("150.00");
  });

  it("rejects a return confirmation after source changes and cannot link a foreign original or incoming source", async () => {
    const original = await purchase(), incoming = await pending("in", "25.00"), context = await service().inspect(OWNER, incoming.id);
    const foreign = await pending("out", "100.00", { ownerId: OTHER, status: "recorded", occurredAt: EARLIER });
    expect(await service().returned(OWNER, incoming.id, { requestId: "foreign-original", evidenceFingerprint: context.evidenceFingerprint, originalId: `bank:${foreign.id}`, principalMinor: 2500 })).toEqual({ status: "protected", changed: false });
    expect(await service().returned(OTHER, incoming.id, { requestId: "foreign-return", evidenceFingerprint: context.evidenceFingerprint, originalId: `bank:${original.id}`, principalMinor: 2500 })).toEqual({ status: "stale", changed: false });
    await db.query("update bank_messages set amount=26.00 where id=$1", [incoming.id]);
    expect(await service().returned(OWNER, incoming.id, { requestId: "stale-return", evidenceFingerprint: context.evidenceFingerprint, originalId: `bank:${original.id}`, principalMinor: 2500 })).toEqual({ status: "stale", changed: false });
    expect((await state()).settlements).toEqual([]);
    expect((await bank().getMessage(OTHER, foreign.id))?.status).toBe("recorded");
    expect((await bank().getMessage(OWNER, incoming.id))?.status).toBe("needs_label");
    expect(await rows("select id from bank_payment_resolutions")).toEqual([]);
  });

  it("rolls back a returned-source classification and link together if its audit insert fails", async () => {
    const original = await purchase(), incoming = await pending("in", "25.00"), context = await service().inspect(OWNER, incoming.id);
    await db.exec("create function fixture_reject_resolution_write() returns trigger language plpgsql as $$begin raise exception 'Synthetic interrupted return';end$$;create trigger fixture_reject_resolution before insert on bank_payment_resolutions for each row execute function fixture_reject_resolution_write()");
    const input = { requestId: "rollback-return-link", evidenceFingerprint: context.evidenceFingerprint, originalId: `bank:${original.id}`, principalMinor: 2500 };
    await expect(service().returned(OWNER, incoming.id, input)).rejects.toThrow("Synthetic interrupted return");
    expect(await bank().getMessage(OWNER, incoming.id)).toEqual(incoming);
    expect(await bank().getMessage(OWNER, original.id)).toEqual(original);
    expect((await state()).revision).toBe(0);
    expect((await state()).settlements).toEqual([]);
    expect(await rows("select revision from accounting_events")).toEqual([]);
    await db.exec("drop trigger fixture_reject_resolution on bank_payment_resolutions");
    expect(await service().returned(OWNER, incoming.id, input)).toEqual({ status: "saved", changed: true });
  });

  it("retains earlier partial returns when only the latest return is reopened", async () => {
    const original = await purchase(), first = await pending("in", "25.00");
    await returned(original, first, "keep-first-return");
    const second = await pending("in", "50.00");
    await returned(original, second, "reopen-second-return");
    const context = await service().inspect(OWNER, second.id);
    expect(await service().reopen(OWNER, second.id, { requestId: "reopen-only-second", evidenceFingerprint: context.evidenceFingerprint })).toEqual({ status: "saved", changed: true });
    const current = await state();
    expect(current.settlements).toHaveLength(1);
    expect(current.settlements[0].returns.map(item => item.principalMinor)).toEqual([2500]);
    expect((await bank().getMessage(OWNER, first.id))?.status).toBe("returned");
    expect((await bank().getMessage(OWNER, second.id))?.status).toBe("needs_label");
    expect(buildAccountingView(current, "GHS").totals).toEqual({ incomeMinor: 0, spentMinor: 7600 });
  });

  it("treats changed live fee evidence as stale rather than replaying or reopening an old assurance", async () => {
    const source = await pending("out", "9.00", { fee: "0.25" });
    const { deps, input } = await noMoney(source);
    await db.query("update transactions set status='deleted' where transaction_id=$1", [source.feeTransactionId]);
    expect(await loadPaymentResolutionNotice(settings, OWNER, source.id)).toContain("needs checking");
    expect(await deps.noMoney(OWNER, source.id, input)).toEqual({ status: "stale", changed: false });
    const context = await deps.inspect(OWNER, source.id);
    expect(await deps.reopen(OWNER, source.id, { requestId: "changed-fee-no-reopen", evidenceFingerprint: context.evidenceFingerprint })).toEqual({ status: "stale", changed: false });
    expect((await bank().getMessage(OWNER, source.id))?.status).toBe("not_completed");
    expect((await rows<{ status: string }>("select status from transactions where transaction_id=$1", [source.feeTransactionId]))[0].status).toBe("deleted");
  });

  it("preserves a later unrelated account edit when a resolution is explicitly reopened", async () => {
    const source = await pending(); await noMoney(source);
    const current = await state();
    await saveAccountingAction(settings, OWNER, { type: "create_account", expectedRevision: current.revision, requestId: "later-unrelated-account", account: { id: "new-wallet", label: "Fictional later wallet", provider: "Fictional", currency: "GHS", includeInCash: true } });
    const context = await service().inspect(OWNER, source.id);
    expect(await service().reopen(OWNER, source.id, { requestId: "reopen-preserve-account", evidenceFingerprint: context.evidenceFingerprint })).toEqual({ status: "saved", changed: true });
    expect((await state()).accounts).toHaveLength(1);
    expect((await state()).accounts[0].label).toBe("Fictional later wallet");
    expect((await bank().getMessage(OWNER, source.id))?.status).toBe("needs_label");
  });
});
