import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadStoredOwnTransferNotice } from "@/lib/bank/stored-transfer-notice";
import { savedOwnTransferNotices } from "@/lib/bank/own-transfers";
import type { BankMessage } from "@/lib/bank/store";
import { sourceMovements } from "@/lib/finance/accounting/sources";
import { emptyAccountingState, type AccountingState } from "@/lib/finance/accounting/types";
import type { TransactionRecord } from "@/lib/finance/types";
import type { query } from "@/lib/supabase/connection";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OUT = "11111111-1111-4111-8111-111111111111", IN = "22222222-2222-4222-8222-222222222222", EXTRA = "33333333-3333-4333-8333-333333333333", TX = "44444444-4444-4444-8444-444444444444";
const AT = "2026-11-04T11:09:00.000Z";
const settings = { projectRef: "synthetic-only", host: "localhost", user: "synthetic", database: "synthetic", password: "not-a-live-credential" } as unknown as Parameters<typeof query>[0];
const message = (id: string, direction: BankMessage["direction"]): BankMessage => ({ id, ownerId: OWNER, source: direction === "out" ? "hubtel" : "momo", channel: "mac", externalId: id, direction, kind: "transfer_own", amount: "1.00", fee: "0.00", currency: "GHS", counterparty: direction === "out" ? "Fictional wallet" : "Credit.Inv", balance: "99.00", occurredAt: AT, status: "transfer", transactionId: null, feeTransactionId: null, askedAt: null, raw: "Fictional source only", readBy: "rules" });
let db: PGlite, state: AccountingState, messages: BankMessage[], trace: string[], projected: unknown[];
const execute = (async (_settings, sql, values) => {
  trace.push(sql);
  const result = (await db.query(sql, [...(values ?? [])])).rows;
  projected = result;
  return result;
}) as typeof query;
const load = (bankId = OUT, owner = OWNER) => loadStoredOwnTransferNotice(settings, owner, bankId, { execute });
async function saveState(next = state) { await db.query("insert into accounting_states values($1,$2::jsonb) on conflict(owner_id) do update set state=excluded.state", [OWNER, JSON.stringify(next)]); }
async function seedMessage(item: BankMessage) {
  await db.query(`insert into bank_messages values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`, [item.id,item.ownerId,item.source,item.channel,item.externalId,item.direction,item.kind,item.amount,item.fee,item.currency,item.counterparty,item.balance,item.occurredAt,item.status,item.transactionId,item.feeTransactionId,item.askedAt,item.raw,item.readBy]);
}
function rebuild(principals: TransactionRecord[] = []) {
  state.movements = sourceMovements(OWNER, principals, messages).map(item => ({ ...item, accountId: item.direction === "out" ? "hubtel-wallet" : "momo-wallet", status: "transfer" }));
  state.transfers = [{ id: "fictional-saved-pair", outgoing: { movementId: `bank:${OUT}`, sourceFingerprint: state.movements.find(item => item.sourceId === OUT)!.sourceFingerprint }, incoming: { movementId: `bank:${IN}`, sourceFingerprint: state.movements.find(item => item.sourceId === IN)!.sourceFingerprint }, createdAt: AT }];
}

beforeEach(async () => {
  trace = []; projected = []; db = new PGlite();
  await db.exec(`create table accounting_states(owner_id uuid primary key,state jsonb);
    create table bank_messages(id uuid primary key,owner_id uuid,source text,channel text,external_id text,direction text,kind text,amount numeric,fee numeric,currency text,counterparty text,balance numeric,occurred_at timestamptz,status text,transaction_id uuid,fee_transaction_id uuid,asked_at timestamptz,raw text,read_by text);
    create table transactions(id bigint primary key,owner_id uuid,transaction_id uuid,created_at timestamptz,transaction_date date,type text,amount numeric,currency text,category text,description text,payment_method text,notes text,status text,updated_at timestamptz,source_update_id text);`);
  state = emptyAccountingState(OWNER);
  state.accounts = [
    { id: "hubtel-wallet", label: "Fictional Hubtel wallet", provider: "Hubtel", currency: "GHS", includeInCash: true, createdAt: AT },
    { id: "momo-wallet", label: "Fictional MTN MoMo", provider: "MTN", currency: "GHS", includeInCash: true, createdAt: AT },
  ];
  messages = [message(OUT, "out"), message(IN, "in")]; rebuild();
  for (const item of messages) await seedMessage(item);
  await saveState();
});
afterEach(async () => { await db.close(); });

describe("compact current stored transfer notice", () => {
  it("matches the existing validated notice with one coherent read and no source/history writes", async () => {
    const before = (await db.query("select * from bank_messages order by id")).rows;
    expect(await load()).toEqual(savedOwnTransferNotices(state, messages).get(OUT));
    expect(trace).toHaveLength(1);
    expect(trace[0]).not.toMatch(/imported_finance_sources|finance_import_receipts|account_rules|source_version|\bupdate\b|\binsert\b/i);
    expect((await db.query("select * from bank_messages order by id")).rows).toEqual(before);
    expect((await db.query<{ state: AccountingState }>("select state from accounting_states")).rows[0].state).toEqual(state);
    expect(await load(IN)).toEqual(savedOwnTransferNotices(state, messages).get(IN));
  });

  it("projects only the pair even with a large saved history and audit", async () => {
    const sample = state.movements[0];
    state.movements.push(...Array.from({ length: 3500 }, (_, index) => ({ ...sample, id: `unrelated:${index}`, sourceId: `unrelated:${index}` })));
    state.audit = [{ id: "large-old-audit", requestId: "fictional", action: "fixture", actionFingerprint: "fictional", at: AT, revision: 1, before: { ...state, movements: state.movements } }];
    await saveState();
    expect((await load())?.state).toBe("paired");
    expect(trace).toHaveLength(1);
    const compact = projected[0] as { movements: unknown[]; accounts: unknown[]; bank_rows: unknown[] };
    expect(compact.movements).toHaveLength(2); expect(compact.accounts).toHaveLength(2); expect(compact.bank_rows).toHaveLength(2);
    expect(JSON.stringify(compact)).not.toContain("large-old-audit");
    expect(JSON.stringify(compact).length).toBeLessThan(6000);
  });

  it.each(["raw", "amount", "currency", "direction", "status"])("rejects a current %s source edit rather than trusting a saved fingerprint", async field => {
    const values: Record<string, string> = { raw: "Corrected fictional text", amount: "2.00", currency: "USD", direction: "in", status: "skipped" };
    await db.query(`update bank_messages set ${field}=$1 where id=$2`, [values[field], OUT]);
    expect(await load()).toBeNull();
  });

  it("rejects wrong owners, missing sources and malformed locators", async () => {
    expect(await load(OUT, OTHER)).toBeNull();
    const count = trace.length;
    expect(await load("not-a-bank-id")).toBeNull();
    expect(trace).toHaveLength(count);
    await db.query("delete from bank_messages where id=$1", [IN]);
    expect(await load()).toBeNull();
  });

  it.each(["missing-account", "same-account", "changed-status", "fingerprint", "duplicate-movement", "overlapping-link", "settlement"])("fails closed for %s saved metadata", async mutation => {
    if (mutation === "missing-account") state.accounts.pop();
    if (mutation === "same-account") state.movements[1].accountId = state.movements[0].accountId;
    if (mutation === "changed-status") state.movements[0].status = "review";
    if (mutation === "fingerprint") state.transfers[0].outgoing.sourceFingerprint = "stale";
    if (mutation === "duplicate-movement") state.movements.push({ ...state.movements[0] });
    if (mutation === "overlapping-link") state.transfers.push({ ...state.transfers[0], id: "other-link", outgoing: { movementId: "bank:other", sourceFingerprint: "other" } });
    if (mutation === "settlement") state.settlements.push({ id: "settlement", kind: "refund", original: state.transfers[0].outgoing, returns: [], createdAt: AT });
    await saveState(); expect(await load()).toBeNull();
  });

  it("reconstructs an owned principal exactly and rejects later edits and competing bank references", async () => {
    const principal: TransactionRecord = { transactionId: TX, createdAt: AT, transactionDate: "2026-11-04", userId: OWNER, type: "expense", amount: "1.00", currency: "GHS", category: "Transfer", description: "Fictional principal", paymentMethod: "", notes: "", status: "active", updatedAt: AT, sourceUpdateId: `bank:${OUT}`, rowNumber: 17 };
    messages[0].transactionId = TX;
    await db.query("update bank_messages set transaction_id=$1 where id=$2", [TX, OUT]);
    await db.query("insert into transactions values(17,$1,$2,$3,'2026-11-04','expense',1,'GHS','Transfer','Fictional principal','','','active',$3,$4)", [OWNER, TX, AT, `bank:${OUT}`]);
    rebuild([principal]); await saveState();
    expect(await load()).toEqual(savedOwnTransferNotices(state, messages).get(OUT));
    await db.query("update transactions set description='Changed principal' where transaction_id=$1", [TX]);
    expect(await load()).toBeNull();
    await db.query("update transactions set description='Fictional principal' where transaction_id=$1", [TX]);
    await seedMessage({ ...message(EXTRA, "out"), transactionId: TX });
    expect(await load()).toBeNull();
  });

  it("never queries a full source, archive or rules loader", async () => {
    const failed = vi.fn(async () => { throw Error("Synthetic unavailable database"); });
    await expect(loadStoredOwnTransferNotice(settings, OWNER, OUT, { execute: failed })).rejects.toThrow("Synthetic unavailable");
    expect(failed).toHaveBeenCalledOnce();
  });
});
