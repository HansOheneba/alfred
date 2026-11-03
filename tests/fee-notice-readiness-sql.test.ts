import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// An in-memory SQL rehearsal only: no application connection or environment load.
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const event = "11111111-1111-4111-8111-111111111111";
const principal = "22222222-2222-4222-8222-222222222222";
const originalMigration = "20261103233000_payment_activity_notices.sql";
const forwardMigration = "20261103235000_fee_notice_readiness.sql";
let db: PGlite;
let createdAt: Date;

async function readiness(checkedAt = createdAt, who = owner, id = event) {
  return (await db.query<{ state: string; ready_at: Date | null }>(
    "select * from public.alfred_bank_notice_readiness($1::uuid,$2::uuid,$3::timestamptz)",
    [who, id, checkedAt.toISOString()],
  )).rows;
}

async function generatedFee() {
  await db.query(`insert into transactions(owner_id,transaction_id,status,type,category,description,amount,currency,source_update_id)
    values($1,$2,'active','expense','Fees','Synthetic generated fee',1,'GHS',$3)`,
  [owner, principal, `bank:${event}`]);
  await db.query("update bank_messages set status='recorded',transaction_id=$1 where id=$2", [principal, event]);
}

async function writeNotice() {
  const row = (await db.query<{
    status: string; transaction_id: string | null; requires: boolean; financial: boolean;
    purpose: unknown; source: unknown;
  }>(`select b.status,b.transaction_id,
    (b.kind in ('payment','unknown','card_hold') and b.status='needs_label') as requires,
    (b.fee_transaction_id is not null or (b.status='recorded' and b.transaction_id is not null)
      or b.status in ('transfer','lent','borrowed','repaid','paid_back','invested')) as financial,
    case when t.transaction_id is not null then jsonb_build_object('ownerId',t.owner_id::text,'transactionId',t.transaction_id::text,
      'category',t.category,'description',t.description,'recordStatus',t.status) end as purpose,
    jsonb_build_object('direction',b.direction,'kind',b.kind,'amount',b.amount::text,'fee',b.fee::text,
      'currency',b.currency,'counterparty',b.counterparty,'readBy',b.read_by,'feeTransactionId',b.fee_transaction_id::text,
      'principalType',t.type,'principalAmount',t.amount::text,'principalCurrency',t.currency) as source
    from bank_messages b left join transactions t on t.owner_id=b.owner_id and t.transaction_id=b.transaction_id and t.status='active'
    where b.id=$1 and b.owner_id=$2`, [event, owner])).rows[0];
  return (await db.query<{ written: boolean }>(`select public.alfred_record_bank_activity_notice(
    $1::uuid,$2::uuid,$3,$4,$5,$6,$7::uuid,$8,$9::jsonb,$10::jsonb) as written`,
  [owner, event, `bank_notice_${createHash("sha256").update(`${owner}\0${event}`).digest("hex")}`,
    "Synthetic payment activity", row.financial, row.status, row.transaction_id, row.requires,
    row.purpose == null ? null : JSON.stringify(row.purpose), JSON.stringify(row.source)])).rows[0].written;
}

async function counts() {
  return (await db.query<{ messages: number; receipts: number }>(`select
    (select count(*)::int from messages) as messages,
    (select count(*)::int from bank_notice_receipts) as receipts`)).rows[0];
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create schema auth;
    create function auth.uid() returns uuid language sql as $$select null::uuid$$;
    create table profiles(id uuid primary key);
    create table conversations(id uuid primary key default gen_random_uuid(),owner_id uuid unique references profiles(id));
    create table messages(id uuid primary key default gen_random_uuid(),conversation_id uuid,owner_id uuid,
      channel text,role text,body text,client_id text,intent text,meta jsonb);
    create unique index msg_client on messages(owner_id,client_id,role) where client_id is not null;
    create table bank_messages(id uuid primary key,owner_id uuid,channel text,direction text,kind text,status text,
      amount numeric(12,2),fee numeric(12,2) default 0,currency text default 'GHS',counterparty text default '',
      read_by text default 'rules',transaction_id uuid,fee_transaction_id uuid,
      created_at timestamptz default now(),occurred_at timestamptz default now());
    create table transactions(owner_id uuid,transaction_id uuid primary key,category text,description text,status text,
      type text,amount numeric(12,2),currency text default 'GHS',source_update_id text not null);`);
  for (const name of ["20261103110000_notifications.sql", "20261103113000_bank_notice_receipts.sql", originalMigration, forwardMigration]) {
    await db.exec(await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8"));
  }
});

beforeEach(async () => {
  await db.exec("truncate profiles,conversations,messages,bank_messages,transactions,notification_preferences,bank_notice_receipts cascade");
  await db.query("insert into profiles values($1),($2)", [owner, other]);
  await db.query("insert into conversations(owner_id) values($1),($2)", [owner, other]);
  await db.query(`insert into notification_preferences(owner_id,payment_mentions,payment_mentions_since,outgoing_mentions,outgoing_mentions_since)
    values($1,true,now()-interval '1 hour',true,now()-interval '1 hour')`, [owner]);
  createdAt = (await db.query<{ at: Date }>("select date_trunc('milliseconds',clock_timestamp()) as at")).rows[0].at;
  await db.query(`insert into bank_messages(id,owner_id,channel,direction,kind,status,amount,created_at)
    values($1,$2,'mac','out','payment','needs_label',1,$3::timestamptz)`, [event, owner, createdAt.toISOString()]);
});

afterAll(async () => { await db.close(); });

describe("server-observed fee notice readiness", () => {
  it("waits through 179.999 seconds and becomes ready at the exact 180-second boundary", async () => {
    const deadline = new Date(createdAt.getTime() + 180_000);
    for (const offset of [0, 179_999]) {
      expect(await readiness(new Date(createdAt.getTime() + offset))).toEqual([{ state: "waiting", ready_at: deadline }]);
    }
    expect(await readiness(deadline)).toEqual([{ state: "ready", ready_at: deadline }]);
  });

  it("uses server creation time even for a much older SMS occurrence", async () => {
    await db.exec("update bank_messages set occurred_at=now()-interval '12 hours'");
    expect((await readiness())[0].state).toBe("waiting");
  });

  it("returns no row for a missing alert, foreign owner or null clock", async () => {
    expect(await readiness(createdAt, other)).toEqual([]);
    expect(await readiness(createdAt, owner, principal)).toEqual([]);
    expect((await db.query("select * from alfred_bank_notice_readiness($1::uuid,$2::uuid,null::timestamptz)", [owner, event])).rows).toEqual([]);
  });

  it.each([
    ["direction='in'", "incoming"], ["counterparty='Synthetic shop'", "named outgoing"],
    ["amount=10.01", "over the fee bound"], ["amount=0", "zero"], ["amount=-1", "negative"],
    ["kind='card_hold'", "card hold"], ["kind='transfer_own',status='transfer'", "transfer"],
    ["status='skipped'", "excluded"],
  ])("does not wait outside the unresolved small-bare bucket: %s (%s)", async (change) => {
    await db.exec(`update bank_messages set ${change}`);
    expect(await readiness()).toEqual([{ state: "ready", ready_at: createdAt }]);
  });

  it.each(["payment", "hold_settle"])("includes the ten-unit boundary for %s", async (kind) => {
    await db.query("update bank_messages set amount=10,kind=$1", [kind]);
    expect((await readiness())[0].state).toBe("waiting");
  });

  it("does not infer a parent payment or suppress a notice from a separate fee-transaction link", async () => {
    const separateFee = "33333333-3333-4333-8333-333333333333";
    await db.query(`insert into bank_messages(id,owner_id,channel,direction,kind,status,amount,counterparty)
      values($1,$2,'mac','out','payment','needs_label',100,'Synthetic parent payment')`, [principal, owner]);
    await db.query(`insert into transactions(owner_id,transaction_id,status,type,category,description,amount,currency,source_update_id)
      values($1,$2,'active','expense','Fees','Synthetic parent fee',1,'GHS',$3)`, [owner, separateFee, `bank:${principal}:fee`]);
    await db.query("update bank_messages set fee_transaction_id=$1 where id=$2", [separateFee, event]);
    expect((await readiness())[0].state).toBe("waiting");
    expect((await readiness(new Date(createdAt.getTime() + 180_000)))[0].state).toBe("ready");
  });

  it("suppresses only the exact owned active generated expense-fee principal", async () => {
    await generatedFee();
    expect(await readiness()).toEqual([{ state: "suppressed", ready_at: null }]);
    expect(await readiness(new Date(createdAt.getTime() + 181_000))).toEqual([{ state: "suppressed", ready_at: null }]);
    expect(await writeNotice()).toBe(false);
    expect(await counts()).toEqual({ messages: 0, receipts: 0 });
  });

  it.each(["needs_label", "matched"])("does not treat a %s fee link as a confirmed standalone fee", async (status) => {
    await generatedFee();
    await db.query("update bank_messages set status=$1", [status]);
    expect((await readiness())[0].state).toBe("ready");
  });

  it.each([
    ["owner_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'", "foreign owner"],
    ["status='deleted'", "inactive"], ["type='income'", "income"], ["category='Food'", "other category"],
    ["amount=2", "other amount"], ["amount=-1", "negative amount"], ["currency='USD'", "other currency"],
    ["source_update_id='manual'", "manual source"],
    ["source_update_id='bank:22222222-2222-4222-8222-222222222222'", "other bank source"],
    ["source_update_id='bank:11111111-1111-4111-8111-111111111111:fee'", "separate fee source"],
  ])("does not suppress a mismatched principal: %s (%s)", async (change) => {
    await generatedFee();
    await db.exec(`update transactions set ${change}`);
    expect((await readiness())[0].state).toBe("ready");
  });

  it("does not suppress an unlinked nearby fee or a named principal", async () => {
    await generatedFee();
    await db.exec("update bank_messages set transaction_id=null,status='needs_label'");
    expect((await readiness())[0].state).toBe("waiting");
    await db.query("update bank_messages set transaction_id=$1,status='recorded',counterparty='Synthetic shop'", [principal]);
    expect((await readiness())[0].state).toBe("ready");
  });

  it("rejects direct writer bypass while waiting, then recovers once without financial mutations", async () => {
    const before = (await db.query("select * from bank_messages")).rows;
    expect(await writeNotice()).toBe(false);
    expect(await counts()).toEqual({ messages: 0, receipts: 0 });
    expect((await db.query("select * from bank_messages")).rows).toEqual(before);
    await db.exec("update bank_messages set created_at=now()-interval '181 seconds'");
    expect(await writeNotice()).toBe(true);
    expect(await writeNotice()).toBe(false);
    await db.exec("delete from messages");
    expect(await writeNotice()).toBe(false);
    expect(await counts()).toEqual({ messages: 0, receipts: 1 });
    expect((await db.query("select * from transactions")).rows).toEqual([]);
  });

  it("permits an immediately linked non-fee principal and immediate incoming alerts", async () => {
    await generatedFee();
    await db.exec("update transactions set category='Food'");
    expect(await writeNotice()).toBe(true);
    await db.exec("truncate messages,bank_notice_receipts;update bank_messages set direction='in',status='needs_label',transaction_id=null");
    expect(await writeNotice()).toBe(true);
  });

  it("preserves consent and source fences after readiness, and leaves the legacy ABI in place", async () => {
    await db.exec("update bank_messages set created_at=now()-interval '181 seconds';update notification_preferences set outgoing_mentions=false");
    expect(await writeNotice()).toBe(false);
    await db.exec("update notification_preferences set outgoing_mentions=true,outgoing_mentions_since=now()+interval '1 minute'");
    expect(await writeNotice()).toBe(false);
    expect(await counts()).toEqual({ messages: 0, receipts: 0 });
    expect((await db.query<{ present: boolean }>("select to_regprocedure('public.alfred_record_bank_notice(uuid,uuid,text,text,boolean,text,uuid,boolean,jsonb)') is not null as present")).rows[0].present).toBe(true);
  });

  it("is server-only and replaying the forward migration does not rewrite existing records", async () => {
    await db.exec("update bank_messages set created_at=now()-interval '181 seconds'");
    expect(await writeNotice()).toBe(true);
    const before = (await db.query("select row_to_json(b) as data from bank_messages b union all select row_to_json(m) from messages m")).rows;
    await db.exec(await readFile(new URL(`../supabase/migrations/${forwardMigration}`, import.meta.url), "utf8"));
    expect((await db.query("select row_to_json(b) as data from bank_messages b union all select row_to_json(m) from messages m")).rows).toEqual(before);
    for (const role of ["anon", "authenticated"]) {
      for (const signature of ["public.alfred_bank_notice_readiness(uuid,uuid,timestamptz)", "public.alfred_record_bank_activity_notice(uuid,uuid,text,text,boolean,text,uuid,boolean,jsonb,jsonb)"]) {
        expect((await db.query<{ allowed: boolean }>("select has_function_privilege($1,$2,'execute') as allowed", [role, signature])).rows[0].allowed).toBe(false);
      }
    }
    expect(await writeNotice()).toBe(false);
  });
});
