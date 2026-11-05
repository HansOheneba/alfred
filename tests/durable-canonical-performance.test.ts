import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SupabaseSettings } from "@/lib/config";
import { buildAccountingDisplayModel } from "@/lib/finance/accounting/display-builder";
import { displayRowsForPublication } from "@/lib/finance/accounting/display-worker";
import { ACCOUNTING_DISPLAY_DEFINITION } from "@/lib/finance/accounting/display-model";
import { resetAccountingDisplayCache } from "@/lib/finance/accounting/display-cache";
import { loadAccountingReadModel, loadAccountingProjectionSource } from "@/lib/finance/accounting/persisted-store";
import { tryLoadDurableAccountsView } from "@/lib/finance/accounting/durable-accounts";
import { projectAccountsReadView } from "@/lib/finance/accounting/read-view";
import { applyAccountingAction } from "@/lib/finance/accounting/reducer";
import { emptyAccountingState, type CashMovement } from "@/lib/finance/accounting/types";

const transport = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/supabase/connection", () => ({ query: transport.query }));
const OWNER = "90000000-0000-4000-8000-000000000001", AT = "2026-11-05T12:00:00.000Z";
const settings = {} as SupabaseSettings, selected = { currency: "GHS", section: "activity" as const, page: 0 };
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const rounded = (value: number) => Number(value.toFixed(3));
const summarize = (samples: number[]) => { const order = [...samples].sort((a,b) => a-b); return { samplesMs: samples.map(rounded), medianMs: rounded(order[Math.floor(order.length/2)]), minMs: rounded(order[0]), maxMs: rounded(order.at(-1)!) }; };
let db: PGlite, forbidSources = false, captureBytes = false;
let trace: { sql: string; sqlMs: number; responseBytes?: number }[] = [];
const report: Record<string, unknown> = { scope: "Same coherent fictional SQL dataset; actual uncached canonical source loader/projector versus actual durable publication and Accounts SQL. Local PGlite execution only, not HTTP, browser, production or a fresh database-process/cache measurement.",
  fixture: { owner: "fictional-only", savedMovements: 2315, snapshots: 2277, accounts: 8, rawTransactions: 2, bankMessages: 6, importedSources: 2307, transfers: 200, auditBeforeCopies: 4 },
  method: "Three newly allocated stateless wrapper objects and seven repeat samples per path, within one Node/PGlite process. Canonical path always bypasses the accounting display cache. PR58 cache path resets before each of its three cold wrappers, then resets/primes once outside timing before seven warmed cache hits. Module/schema-readiness and DB caches remain warm for both. DB statistics analyzed before measurement. Durable role cannot SELECT the five sources or execute the old hash. SQL byte probes are separate from timed samples to avoid timing JSON-size instrumentation. Publication/rebuild timing reported separately. Summed per-query durations include concurrent/queued waits and overlap; they are not elapsed wall time." };
async function seed() {
  await db.query("insert into auth.users(id) values($1::uuid)", [OWNER]);
  const accounts = Array.from({ length: 8 }, (_, i) => ({ id: `fictional-account:${i}`, label: `Fictional account ${i}`, provider: "Fictional bank", currency: "GHS", includeInCash: i !== 7, createdAt: AT }));
  const initial = { ...emptyAccountingState(OWNER), accounts };
  await db.query("insert into accounting_states(owner_id,revision,state) values($1::uuid,0,$2::jsonb)", [OWNER, JSON.stringify(initial)]);
  await db.query(`insert into transactions(owner_id,transaction_id,created_at,transaction_date,user_id,type,amount,currency,category,description,payment_method,notes,status,updated_at,source_update_id)
    select $1::uuid,('91000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,$2::timestamptz+i*interval '1 second','2026-11-05',$1::text,
      case when i=1 then 'expense' else 'income' end,10*i,'GHS',case when i=1 then 'Food' else 'Other income' end,'Fictional native '||i,'Fictional cash','','active',$2::timestamptz,'fictional-native:'||i from generate_series(1,2) i`, [OWNER, AT]);
  await db.query(`insert into bank_messages(id,owner_id,source,channel,text_hash,direction,kind,amount,fee,currency,counterparty,balance,occurred_at,status,raw,read_by)
    select ('92000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,$1::uuid,'momo','manual','fictional-hash:'||i,case when i%2=0 then 'in' else 'out' end,'payment',10*i,0,'GHS','Fictional bank '||i,null,$2::timestamptz+i*interval '1 minute','needs_label',repeat('Fictional bank alert only. ',8),'rules' from generate_series(1,6) i`, [OWNER, AT]);
  await db.query("insert into finance_import_receipts(owner_id,id,archive_id,archive,summary,before_state,after_state,source_version_after) values($1::uuid,'fictional-coherent-import',$2,jsonb_build_object('archiveId',$2::text),'{}',$3::jsonb,$3::jsonb,'fixture')", [OWNER,"a".repeat(64),JSON.stringify(initial)]);
  const imported: CashMovement[] = Array.from({ length: 2307 }, (_, i) => {
    const id = `fictional-import:${String(i).padStart(5,"0")}`, day = `2026-${i%3===0?"10":"11"}-${String(1+Math.floor(i/2)%28).padStart(2,"0")}`;
    return { id, ownerId: OWNER, accountId: accounts[i%8].id, direction: i%2 ? "in" : "out", status: i>=400 && i%31===0 ? "review" : "confirmed", sourceStatus: i>=400 && i%31===0 ? "review" : "confirmed",
      amountMinor: 500+Math.floor(i/2)%10*100, feeMinor: i%17===0?10:0, taxMinor: i%29===0?5:0, currency:"GHS", date:day, occurredAt:`${day}T12:00:00.000Z`,
      description:`Fictional imported merchant ${i%19}`, category:i%5===0?"Transport":"Food", sourceCategory:i%5===0?"Transport":"Food", sourceId:id, sourceKind:"manual", sourceFingerprint:`fictional-fingerprint:${i}`,
      legacyTransactionId:null,feeTransactionId:null,legacyClassification:null,sourceText:"Fictional historical evidence only. ".repeat(6),sourceLabel:"Fictional archive",
      importProvenance:{namespace:"fictional-coherent",sourceId:id} };
  });
  await db.query("insert into imported_finance_sources(owner_id,movement_id,receipt_id,movement) select $1::uuid,movement->>'id','fictional-coherent-import',movement from jsonb_array_elements($2::jsonb) movement", [OWNER,JSON.stringify(imported)]);
  const source = await loadAccountingProjectionSource(settings,OWNER);
  let state = source.state;
  state.movements = state.movements.map((row,i) => ({...row,accountId:row.accountId??accounts[i%8].id,status:row.id.startsWith("fictional-import:")&&Number(row.id.split(":")[1])<400?"transfer":row.status}));
  state.transfers = Array.from({length:200},(_,i) => ({id:`fictional-transfer:${i}`,createdAt:AT,outgoing:{movementId:imported[2*i].id,sourceFingerprint:imported[2*i].sourceFingerprint},incoming:{movementId:imported[2*i+1].id,sourceFingerprint:imported[2*i+1].sourceFingerprint}}));
  state.snapshots = Array.from({length:2277},(_,i) => ({id:`fictional-snapshot:${i}`,accountId:accounts[i%8].id,balanceMinor:100000+i*100,occurredAt:new Date(Date.parse("2026-11-01T00:00:00.000Z")+i*60000).toISOString(),sourceId:`fictional-statement:${i}`,sourceMovementId:null}));
  for(let i=0;i<4;i++)state=applyAccountingAction(state,{type:"update_account",accountId:accounts[0].id,changes:{label:`Fictional edited account ${i}`},expectedRevision:state.revision,requestId:`fictional-history:${i}`},AT);
  await db.query("update accounting_states set revision=$2,state=$3::jsonb where owner_id=$1::uuid",[OWNER,state.revision,JSON.stringify(state)]);
  report.fullSavedStateBytes=bytes(state);
  await db.exec("analyze transactions;analyze bank_messages;analyze imported_finance_sources;analyze accounting_states;analyze account_rule_states");
}
function wrapper() {
  return {
    canonical: async () => projectAccountsReadView(await loadAccountingProjectionSource(settings,OWNER),selected),
    pr58DisplayCache: async () => projectAccountsReadView(await loadAccountingReadModel(settings,OWNER),selected),
    durable: async () => {const value=await tryLoadDurableAccountsView(settings,OWNER,selected);if(!value)throw new Error("Expected a fresh durable model");return value;},
  };
}
beforeAll(async () => {
  db=new PGlite();
  await db.exec("create role anon;create role authenticated;create schema auth;create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}'::jsonb);");
  const migrations=readdirSync("supabase/migrations").filter(name=>name.endsWith(".sql")).sort();
  for(const name of migrations)await db.exec(readFileSync(`supabase/migrations/${name}`,"utf8"));
  report.migrationCount=migrations.length;
  transport.query.mockImplementation(async (_settings,sql:string,values:unknown[]=[])=>{
    if(forbidSources&&/\b(?:transactions|bank_messages|imported_finance_sources|accounting_states|account_rule_states)\b|alfred_accounting_source_version/i.test(sql))throw new Error("A durable hit attempted a complete source read");
    const start=performance.now(),result=await db.query(sql,values),sqlMs=performance.now()-start;
    trace.push({sql,sqlMs,...(captureBytes?{responseBytes:bytes(result.rows)}:{})});return result.rows;
  });
  await seed();
  const token=randomUUID();await db.query("select alfred_display.enqueue($1::uuid,$2::text)",[OWNER,ACCOUNTING_DISPLAY_DEFINITION]);
  const job=(await db.query<{result:{ownerId:string}}>("select alfred_display.claim($1::text,$2::uuid,120) as result",[ACCOUNTING_DISPLAY_DEFINITION,token])).rows[0].result;expect(job.ownerId).toBe(OWNER);
  const started=performance.now();
  const baseline=(await db.query<{result:unknown}>("select alfred_display.capture($1::uuid,$2::text,$3::uuid) as result",[OWNER,ACCOUNTING_DISPLAY_DEFINITION,token])).rows[0].result;
  const source=await loadAccountingProjectionSource(settings,OWNER),model=buildAccountingDisplayModel(source);
  const published=(await db.query<{result:{status:string}}>("select alfred_display.publish($1::uuid,$2::text,$3::uuid,$4::jsonb,$5::jsonb,$6::jsonb) as result",[OWNER,ACCOUNTING_DISPLAY_DEFINITION,token,JSON.stringify(baseline),JSON.stringify(model.manifest),JSON.stringify(displayRowsForPublication(model.rows))])).rows[0].result;
  expect(published.status).toBe("saved");expect(source.state.movements).toHaveLength(2315);expect(source.state.snapshots).toHaveLength(2277);
  expect(source.rawTransactions).toHaveLength(2);expect(source.bankMessages).toHaveLength(6);expect(source.state.movements.some(row=>row.sourceMissing)).toBe(false);
  report.canonicalRebuildAndPublicationMs=rounded(performance.now()-started);report.normalizedRows=model.rows.length;
  await db.exec("analyze alfred_display.rows;create role canonical_bench_reader bypassrls;grant usage on schema alfred_display to canonical_bench_reader;grant select on all tables in schema alfred_display to canonical_bench_reader;grant execute on function alfred_display.manifest(uuid,text),alfred_display.readiness() to canonical_bench_reader;");
  await db.exec("set role canonical_bench_reader");
  for(const table of ["transactions","bank_messages","imported_finance_sources","accounting_states","account_rule_states"])await expect(db.query(`select 1 from public.${table} limit 0`)).rejects.toThrow(/permission denied/i);
  await expect(db.query("select public.alfred_accounting_source_version($1::uuid)",[OWNER])).rejects.toThrow(/permission denied/i);
  await db.exec("reset role");vi.stubEnv("ALFRED_DURABLE_DISPLAY","true");
},60_000);
afterAll(async()=>{vi.unstubAllEnvs();await db?.exec("reset role");await db?.close();const output=process.env.ALFRED_DURABLE_CANONICAL_PERFORMANCE_OUTPUT;if(output)await writeFile(output,`${JSON.stringify(report,null,2)}\n`);});

describe("same coherent SQL source before/after local Accounts benchmark",()=>{
  it("matches complete canonical results for three stateless wrappers and seven repeat reads per path",async()=>{
    const oracle=await wrapper().canonical();expect(oracle.counts).toEqual({movements:2315,snapshots:2277,transfers:200,settlements:0});expect(oracle.page.rows).toHaveLength(25);
    const result:Record<string,unknown>={};
    for(const path of ["canonical","pr58DisplayCache","durable"] as const){
      forbidSources=path==="durable";await db.exec(forbidSources?"set role canonical_bench_reader":"reset role");
      const cold:number[]=[],warm:number[]=[],queries:number[]=[],sqlTimes:number[]=[];
      for(let i=0;i<10;i++){
        const read=wrapper();
        if(path==="pr58DisplayCache"&&i<3)resetAccountingDisplayCache();
        if(path==="pr58DisplayCache"&&i===3){resetAccountingDisplayCache();await read.pr58DisplayCache();}
        trace=[];const start=performance.now(),value=await read[path](),elapsed=performance.now()-start;
        expect(value).toEqual(oracle);(i<3?cold:warm).push(elapsed);queries.push(trace.length);sqlTimes.push(trace.reduce((total,row)=>total+row.sqlMs,0));
        if(path==="durable"||(path==="pr58DisplayCache"&&i>=3))expect(trace).toHaveLength(1);
      }
      captureBytes=true;trace=[];const probed=await wrapper()[path]();captureBytes=false;
      result[path]={statelessWrappers:summarize(cold),warmRepeats:summarize(warm),queryCounts:queries,sumOfOverlappingQueryDurationsMs:summarize(sqlTimes),sqlResponseCompactJsonBytes:trace.reduce((sum,row)=>sum+(row.responseBytes??0),0),dtoCompactJsonBytes:bytes(probed),byteProbeScope:path==="pr58DisplayCache"?"Warmed process display-cache hit after explicit priming":"Same path as timed samples",sqlSources:[...new Set(trace.map(row=>row.sql.match(/(?:from|join)\s+public\.([a-z_]+)/i)?.[1]??(row.sql.includes("alfred_accounting_source_version")?"legacy-source-hash":"private-display-gate")))]};
    }
    report.results=result;
    expect((result.durable as {sqlResponseCompactJsonBytes:number}).sqlResponseCompactJsonBytes).toBeLessThan((result.canonical as {sqlResponseCompactJsonBytes:number}).sqlResponseCompactJsonBytes/20);
    report.parity="Exact Accounts DTO equality, including complete balances/reconciliation/attention/counts and25page rows; canonical source arrays are real matching SQL inputs.";
  },60_000);
});
