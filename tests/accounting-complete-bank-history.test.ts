import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSupabaseBankStore, listAccountingBankMessages } from "@/lib/bank/store";
import { loadAccountingProjectionSource, loadAccountingState } from "@/lib/finance/accounting/persisted-store";
import { applyAccountingAction } from "@/lib/finance/accounting/reducer";
import { hydrateAccountingSources, sourceMovements } from "@/lib/finance/accounting/sources";
import { emptyAccountingState, type AccountingState } from "@/lib/finance/accounting/types";
import { accountingReportRows } from "@/lib/finance/accounting/view";
import { accountBalances } from "@/lib/finance/accounting/accounts";
import { listRawTransactions } from "@/lib/supabase/finance-store";
import type { SupabaseSettings } from "@/lib/config";

const backend = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/supabase/connection", () => ({ query: backend.query }));
const OWNER = "10000000-0000-4000-8000-000000000001", OTHER = "10000000-0000-4000-8000-000000000002";
const AT = "2026-11-01T12:00:00.000Z", settings = {} as SupabaseSettings;
const bankId = (index: number) => `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const transactionId = (index: number) => `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
let db: PGlite;
let saved: AccountingState;
async function seedNotices(count: number, ownerId = OWNER, offset = 0) {
  await db.query(`insert into public.bank_messages(id,owner_id,source,channel,external_id,text_hash,direction,kind,amount,fee,currency,counterparty,balance,occurred_at,status,raw,read_by)
    select ('20000000-0000-4000-8000-'||lpad((i+$3)::text,12,'0'))::uuid,$1::uuid,'momo','manual','fictional-external-'||(i+$3), 'fictional-hash-'||(i+$3),
      case when i=2 then 'in' else 'out' end,'payment',case when i<=2 then 100 else 5 end,case when i=1 then 2 else 0 end,'GHS','Fictional merchant '||i,1000+i,
      $2::timestamptz+i*interval '1 minute',case when i<=2 then 'recorded' else 'needs_label' end,'Fictional immutable bank alert '||i,'rules'
    from generate_series(1,$4::integer) i`, [ownerId, AT, offset, count]);
}
async function store(state: AccountingState) {
  await db.query("insert into public.accounting_states(owner_id,revision,state) values($1::uuid,$2,$3::jsonb) on conflict(owner_id) do update set revision=excluded.revision,state=excluded.state", [OWNER, state.revision, JSON.stringify(state)]);
}
async function principalRows() {
  await db.query(`insert into public.transactions(owner_id,transaction_id,created_at,transaction_date,user_id,type,amount,currency,category,description,payment_method,notes,status,updated_at,source_update_id)
    values($1::uuid,$2::uuid,$5::timestamptz,'2026-11-01',$1::text,'expense',100,'GHS','Food','Fictional outgoing','Fictional wallet','','active',$5::timestamptz,$6),
      ($1::uuid,$3::uuid,$5::timestamptz,'2026-11-01',$1::text,'income',100,'GHS','Other income','Fictional incoming','Fictional wallet','','active',$5::timestamptz,$7),
      ($1::uuid,$4::uuid,$5::timestamptz,'2026-11-01',$1::text,'expense',2,'GHS','Fees','Fictional transfer fee','Fictional wallet','','active',$5::timestamptz,$8)`,
    [OWNER, transactionId(1), transactionId(2), transactionId(3), AT, `bank:${bankId(1)}`, `bank:${bankId(2)}`, `bank:${bankId(1)}:fee`]);
  await db.query("update public.bank_messages set transaction_id=case when id=$2::uuid then $4::uuid else $5::uuid end,fee_transaction_id=case when id=$2::uuid then $6::uuid else null end where owner_id=$1::uuid and id in ($2::uuid,$3::uuid)", [OWNER, bankId(1), bankId(2), transactionId(1), transactionId(2), transactionId(3)]);
}
beforeAll(async () => {
  db = new PGlite();
  await db.exec("create role anon;create role authenticated;create schema auth;create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}'::jsonb);");
  // Existing source/financial schemas only: this regression does not depend on the new display migration.
  for (const name of readdirSync("supabase/migrations").filter(name => name.endsWith(".sql") && name <= "20261105144649_custom_categories.sql").sort()) await db.exec(readFileSync(`supabase/migrations/${name}`, "utf8"));
  backend.query.mockImplementation(async (_settings, sql: string, values: unknown[] = []) => (await db.query(sql, values)).rows);
}, 30_000);
beforeEach(async () => {
  await db.exec("truncate auth.users cascade");
  await db.query("insert into auth.users(id) values($1::uuid),($2::uuid)", [OWNER, OTHER]);
  await seedNotices(220); await seedNotices(4, OTHER, 1000); await principalRows();
  const messages = await listAccountingBankMessages(settings, OWNER), raw = await listRawTransactions(settings, OWNER);
  const fresh = sourceMovements(OWNER, raw, messages);
  const base = emptyAccountingState(OWNER);
  base.accounts = ["cash", "reserve"].map(id => ({ id, label: `Fictional ${id}`, provider: "Fictional", currency: "GHS", includeInCash: true, createdAt: AT }));
  base.movements = fresh.map(row => ({ ...row, accountId: row.id === `bank:${bankId(2)}` ? "reserve" : "cash" }));
  saved = hydrateAccountingSources(base, fresh);
  const ref = (index: number) => { const row = saved.movements.find(row => row.id === `bank:${bankId(index)}`)!; return { movementId: row.id, sourceFingerprint: row.sourceFingerprint }; };
  saved = applyAccountingAction(saved, { type: "classify_movement", expectedRevision: saved.revision, requestId: "fictional-old-manual-category", movement: ref(3), category: "Fictional custom", status: "confirmed" }, AT);
  saved = applyAccountingAction(saved, { type: "pair_transfer", expectedRevision: saved.revision, requestId: "fictional-old-transfer", id: "fictional-transfer", outgoing: ref(1), incoming: ref(2) }, AT);
  await store(saved); backend.query.mockClear();
});
afterAll(async () => { await db?.close(); });

describe("complete accounting bank evidence, separate from the bounded review inbox", () => {
  it("keeps all220owner notices, manual overrides, old transfer legs and source snapshots while the inbox remains200", async () => {
    const inbox = await createSupabaseBankStore(settings).listMessages(OWNER);
    expect(inbox).toHaveLength(200); expect(inbox.some(row => row.id === bankId(1))).toBe(false);
    const source = await loadAccountingProjectionSource(settings, OWNER);
    expect(source.bankMessages).toHaveLength(220); expect(source.bankMessages!.every(row => row.ownerId === OWNER)).toBe(true);
    expect(source.state.movements).toHaveLength(220); expect(source.state.movements.some(row => row.sourceMissing)).toBe(false);
    expect(source.state.movements.find(row => row.id === `bank:${bankId(3)}`)).toMatchObject({ category: "Fictional custom", categoryOrigin: "manual", status: "confirmed" });
    expect(source.state.movements.filter(row => [bankId(1), bankId(2)].includes(row.sourceId)).map(row => row.status)).toEqual(["transfer", "transfer"]);
    const balances = accountBalances(source.state, "GHS"); expect(balances.missingCount).toBe(0); expect(balances.totalMinor).toBe(222200);
    const report = accountingReportRows(source.state);
    expect(report.filter(row => row.type === "income")).toEqual([]);
    expect(report.filter(row => row.type === "expense").reduce((sum, row) => sum + row.minor, 0)).toBe(700);
    const full = await loadAccountingState(settings, OWNER);
    expect(full.bankMessages).toHaveLength(220); expect(full.state.audit.at(-1)?.before.movements).toHaveLength(220);
    expect((await db.query<{ state: AccountingState }>("select state from accounting_states where owner_id=$1", [OWNER])).rows[0].state).toEqual(saved);
  });
  it("adding notice221 cannot evict an older source or turn a reported account balance unknown", async () => {
    await seedNotices(1, OWNER, 300);
    const current = await loadAccountingProjectionSource(settings, OWNER);
    expect(current.bankMessages).toHaveLength(221); expect(current.state.movements).toHaveLength(221);
    expect(current.state.movements.find(row => row.id === `bank:${bankId(3)}`)).toMatchObject({ category: "Fictional custom", status: "confirmed" });
    expect(accountBalances(current.state, "GHS").missingCount).toBe(0);
    expect(await createSupabaseBankStore(settings).listMessages(OWNER)).toHaveLength(200);
  });
  it("real deletion becomes stale evidence; exact reappearance restores the saved fingerprint-bound override", async () => {
    const old = (await db.query<{ data: unknown }>("select to_jsonb(b) as data from bank_messages b where id=$1", [bankId(3)])).rows[0].data;
    await db.query("delete from bank_messages where owner_id=$1 and id=$2", [OWNER, bankId(3)]);
    const missing = await loadAccountingProjectionSource(settings, OWNER);
    expect(missing.state.movements.find(row => row.id === `bank:${bankId(3)}`)).toMatchObject({ status: "excluded", sourceMissing: true });
    await db.query("insert into bank_messages select (jsonb_populate_record(null::bank_messages,$1::jsonb)).*", [JSON.stringify(old)]);
    const restored = await loadAccountingProjectionSource(settings, OWNER);
    expect(restored.state.movements.find(row => row.id === `bank:${bankId(3)}`)).toMatchObject({ category: "Fictional custom", categoryOrigin: "manual", status: "confirmed" });
    expect(restored.state.movements.find(row => row.id === `bank:${bankId(3)}`)?.sourceMissing).toBeUndefined();
  });
  it("old changed transfer evidence invalidates both principal exclusions while retaining its fee exactly once", async () => {
    await db.query("update bank_messages set raw=raw||' Fictional corrected evidence' where owner_id=$1 and id=$2", [OWNER, bankId(1)]);
    const changed = await loadAccountingProjectionSource(settings, OWNER), report = accountingReportRows(changed.state);
    expect(report.some(row => row.type === "income" && row.minor === 10000)).toBe(true);
    expect(report.some(row => row.type === "expense" && row.minor === 10000)).toBe(true);
    expect(report.filter(row => row.category === "Fees").map(row => row.minor)).toEqual([200]);
  });
  it("old skipped-source confirmed fees respond to fee-only edits even when the parent fingerprint is unchanged", async () => {
    await db.query("update bank_messages set status='skipped' where owner_id=$1 and id=$2", [OWNER, bankId(1)]);
    const before = await loadAccountingProjectionSource(settings, OWNER);
    expect(accountingReportRows(before.state).filter(row => row.category === "Fees").map(row => row.minor)).toEqual([200]);
    await db.query("update transactions set status='deleted' where owner_id=$1 and transaction_id=$2", [OWNER, transactionId(3)]);
    const after = await loadAccountingProjectionSource(settings, OWNER);
    const parent = (state: AccountingState) => state.movements.find(row => row.id === `bank:${bankId(1)}`)!;
    expect(parent(after.state).sourceFingerprint).toBe(parent(before.state).sourceFingerprint);
    expect(parent(before.state).confirmedFeeMinor).toBe(200); expect(parent(after.state).confirmedFeeMinor).toBe(0);
    expect(accountingReportRows(after.state).filter(row => row.category === "Fees")).toEqual([]);
  });
});
