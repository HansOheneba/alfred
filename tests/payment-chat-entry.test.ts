import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessageRecord } from "@/lib/accounts/messages";
import type { query } from "@/lib/supabase/connection";
import { includePaymentChatEntry, loadPaymentChatEntry } from "@/app/chat/payment-entry";
import { linkedPaymentReplyContext, paymentLinkId, paymentSignInReturn } from "@/app/chat/payment-link";
import { toThreadMessage } from "@/lib/accounts/thread";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const bank = "11111111-1111-4111-8111-111111111111", principal = "22222222-2222-4222-8222-222222222222";
// All reads are injected into the in-memory database below, never a live pool.
const settings = { projectRef: "synthetic-only", host: "localhost", user: "synthetic", database: "synthetic", password: "not-a-real-credential" } as unknown as Parameters<typeof query>[0];
let db: PGlite;
const loadTransfer = vi.fn(async () => null);
const execute = (async (_settings, sql, values) => (await db.query(sql, [...(values ?? [])])).rows) as typeof query;
const load = (id: unknown = bank, user = owner) => loadPaymentChatEntry(settings, user, id, { execute, loadTransfer });

beforeEach(async () => {
  vi.clearAllMocks(); db = new PGlite();
  await db.exec(`create table bank_messages(id uuid primary key,owner_id uuid,channel text,direction text,kind text,amount numeric,fee numeric,currency text,counterparty text,occurred_at timestamptz,created_at timestamptz,status text,transaction_id uuid,fee_transaction_id uuid,read_by text);
    create table transactions(owner_id uuid,transaction_id uuid,category text,description text,status text,type text,amount numeric,currency text);
    create table messages(id uuid primary key,owner_id uuid,role text,client_id text,created_at timestamptz);
    insert into bank_messages values('${bank}','${owner}','mac','in','payment',1,0,'GHS','Fictional sender','2026-11-04T11:09:00Z','2026-11-04T11:09:02Z','needs_label',null,null,'rules');`);
});
afterEach(async () => { await db.close(); });

describe("owned read-only notification Chat entry", () => {
  it("opens a current purpose question before the durable notice exists, without writing or replaying it", async () => {
    const before = (await db.query("select * from bank_messages")).rows;
    const first = await load(), again = await load();
    expect(first).toEqual(again);
    expect(first.state).toBe("ready");
    if (first.state !== "ready") throw Error("Expected fictional entry");
    expect(first.message.body).toContain("GH₵1.00");
    expect(first.message.body).toContain("What was this for?");
    expect(first.message.paymentNotice).toEqual({ bankMessageId: bank, requiresPurpose: true });
    expect(first.message.ledgerChanged).toBe(false);
    expect((await db.query("select * from bank_messages")).rows).toEqual(before);
    expect((await db.query("select * from messages")).rows).toEqual([]);
    expect(loadTransfer).toHaveBeenCalledWith(settings, owner, bank);
  });

  it("uses current source classification instead of a stale saved question and retains its stable identity", async () => {
    const key = `bank_notice_${createHash("sha256").update(`${owner}\0${bank}`).digest("hex")}`;
    await db.query("insert into messages values($1,$2,'assistant',$3,'2026-11-04T11:09:03Z')", [principal, owner, key]);
    await db.query("update bank_messages set kind='transfer_own',status='transfer'");
    const result = await load();
    expect(result.state).toBe("ready");
    if (result.state !== "ready") throw Error("Expected fictional entry");
    expect(result.message.id).toBe(principal);
    expect(result.message.body).toContain("between your own accounts");
    expect(result.message.paymentNotice?.requiresPurpose).toBe(false);
    expect((await db.query("select * from messages")).rows).toHaveLength(1);
  });

  it("shows a current skipped acknowledgement without resurrecting the old purpose question", async () => {
    await db.exec("update bank_messages set status='skipped'");
    const result = await load();
    expect(result.state).toBe("ready");
    if (result.state !== "ready") throw Error("Expected fictional entry");
    expect(result.message.body).toContain("currently set aside");
    expect(result.message.paymentNotice?.requiresPurpose).toBe(false);
  });

  it.each(["not_completed", "returned"])("loads a current %s resolution without transfer hydration or an open-purpose question", async status => {
    const direction = status === "returned" ? "in" : "out";
    await db.query("update bank_messages set status=$1,direction=$2", [status, direction]);
    const loadResolution = vi.fn(async () => "A verified fictional source resolution, not new income.");
    const result = await loadPaymentChatEntry(settings, owner, bank, { execute, loadTransfer, loadResolution });
    expect(result.state).toBe("ready");
    if (result.state !== "ready") throw Error("Expected fictional entry");
    expect(result.message.body).toBe("A verified fictional source resolution, not new income.");
    expect(result.message.intent).toBe(direction === "in" ? "automation:incoming-payment" : "automation:outgoing-payment");
    expect(result.message.paymentNotice?.requiresPurpose).toBe(false);
    expect(loadResolution).toHaveBeenCalledExactlyOnceWith(settings, owner, bank);
    expect(loadTransfer).not.toHaveBeenCalled();
  });

  it("joins purpose evidence only to the authenticated owner's active principal", async () => {
    await db.query("update bank_messages set transaction_id=$1,status='recorded'", [principal]);
    await db.query("insert into transactions values($1,$2,'PRIVATE OTHER CATEGORY','PRIVATE OTHER DETAIL','active','income',1,'GHS')", [other, principal]);
    const result = await load();
    expect(JSON.stringify(result)).not.toContain("PRIVATE OTHER");
    await db.query("insert into transactions values($1,$2,'Salary','Fictional salary','active','income',1,'GHS')", [owner, principal]);
    const owned = await load();
    expect(JSON.stringify(owned)).toContain("Salary");
  });

  it("does not distinguish missing, foreign or unsupported sources", async () => {
    expect(await load(bank, other)).toEqual({ state: "unavailable" });
    expect(await load(principal)).toEqual({ state: "unavailable" });
    await db.exec("update bank_messages set channel='manual'");
    expect(await load()).toEqual({ state: "unavailable" });
  });

  it.each(["not-a-uuid", "../../private", [bank, principal], undefined])("rejects an invalid locator without any source read (%s)", async id => {
    const read = vi.fn();
    expect(await loadPaymentChatEntry(settings, owner, id, { execute: read })).toEqual({ state: "unavailable" });
    expect(read).not.toHaveBeenCalled();
  });

  it("includes a target older than recent history once and replaces stale copies in place", async () => {
    const entry = await load();
    if (entry.state !== "ready") throw Error("Expected fictional entry");
    const newer: ChatMessageRecord = { ...entry.message, id: "newer", clientId: "newer", body: "Later unrelated question", createdAt: "2026-11-04T12:00:00Z", paymentNotice: undefined };
    const combined = includePaymentChatEntry([newer], entry);
    expect(combined.map(row => row.body)).toEqual([entry.message.body, newer.body]);
    const repeated = includePaymentChatEntry([...combined, { ...entry.message, id: "stale-copy", body: "Old stale question" }], entry);
    expect(repeated).toEqual(combined);
  });
});

describe("notification navigation and exact reply binding", () => {
  it("canonicalizes the locator and accepts only the fixed local post-login route", () => {
    expect(paymentLinkId(bank.toUpperCase())).toBe(bank);
    expect(paymentSignInReturn(`/chat?payment=${bank.toUpperCase()}`)).toBe(`/chat?payment=${bank}`);
    for (const value of ["https://evil.example", "//evil.example", `/chat?payment=${bank}&next=https://evil.example`, "/accounts", undefined]) {
      expect(paymentSignInReturn(value)).toBe("/");
    }
  });
  it("keeps the selected old payment when a newer alert arrives, while retries retain their original context", async () => {
    const entry = await load();
    if (entry.state !== "ready") throw Error("Expected fictional entry");
    const selected = entry.message.paymentNotice;
    const newer = { ...toThreadMessage(entry.message), id: "newer", clientId: "newer", paymentNotice: { bankMessageId: principal, requiresPurpose: true } };
    expect(linkedPaymentReplyContext([toThreadMessage(entry.message), newer], undefined, selected)).toEqual(selected);
    const retry = { ...newer, role: "user" as const, clientId: "retry", paymentNotice: undefined };
    expect(linkedPaymentReplyContext([retry, newer], "retry", selected)).toBeUndefined();
    expect(linkedPaymentReplyContext([newer], undefined, null)).toBeNull();
  });
});
