import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildAccountingDisplayModel } from "@/lib/finance/accounting/display-builder";
import type { AccountingResult } from "@/lib/finance/accounting/persisted-store";
import { toLedgerRows } from "@/lib/finance/analytics";
import { projectAccountingTransactions } from "@/lib/finance/accounting/view";
import { withLedgerReceipts } from "@/lib/finance/accounting/receipts";
import { buildOverviewSummary } from "@/lib/web/overview-summary";
import { DURABLE_OVERVIEW_SQL, DURABLE_OVERVIEW_PAGE_SQL, durableOverviewOptions, overviewSummaryFromFacts, type DurableOverviewFacts } from "@/lib/web/durable-overview";
import { filterOverviewTransactions, type OverviewTransactionQuery } from "@/lib/web/overview-transactions";
import type { Ledger } from "@/lib/web/ledger";
import type { DurableBundle } from "@/lib/finance/accounting/durable-read";
import { populatedPerformanceFixture } from "./populated-performance-fixture";

const mocks=vi.hoisted(()=>({query:vi.fn()}));vi.mock("@/lib/supabase/connection",()=>({query:mocks.query}));
const OWNER="00000000-0000-4000-8000-000000000001",OTHER="00000000-0000-4000-8000-000000000002",TODAY="2026-11-05";
const fixture=populatedPerformanceFixture();
const result:AccountingResult={state:{...fixture.state,ownerId:OWNER,movements:fixture.state.movements.map(row=>({...row,ownerId:OWNER}))},rawTransactions:fixture.raw.map(row=>({...row,userId:OWNER})),availability:"ready",sourceVersion:"fictional-stable-version"};
const model=buildAccountingDisplayModel(result),rows=withLedgerReceipts(toLedgerRows(projectAccountingTransactions(result.rawTransactions,result.state)),result.state,OWNER);
const ledger:Ledger={today:TODAY,currency:"GHS",rows,budgets:[],goals:[],insights:[],owed:[],owe:[],bank:{connected:false,lastUsedAt:null,lastEmptyAt:null,accountNames:[],needsLabel:[],balances:[]}};
const query:OverviewTransactionQuery={preset:"this_month",category:null,filters:{search:"",type:"all",category:"all",sort:"date-desc"}};
let db:PGlite;
beforeAll(async()=>{
 db=new PGlite();
 await db.exec(`create schema alfred_display;create table alfred_display.publications(owner_id uuid primary key,document jsonb);create table alfred_display.rows(owner_id uuid,definition text,token bigint,epoch bigint,kind text,id text,ordinal integer,date text,currency text,category text,direction text,amount_minor bigint,rank_date_asc bigint,rank_date_desc bigint,rank_amount_asc bigint,rank_amount_desc bigint,payload jsonb);create function alfred_display.manifest(owner uuid,definition text)returns jsonb language sql stable as $$select document from alfred_display.publications where owner_id=owner$$;`);
 await db.query("insert into alfred_display.publications values($1::uuid,$2::jsonb)",[OWNER,JSON.stringify({token:"1",epoch:"0",manifest:model.manifest})]);
 await db.query(`insert into alfred_display.rows select $1::uuid,'accounting-display-v1',1,0,value->>'kind',value->>'id',(value->>'ordinal')::integer,value->>'date',value->>'currency',value->>'category',value->>'direction',(value->>'amountMinor')::bigint,(value->>'rankDateAsc')::bigint,(value->>'rankDateDesc')::bigint,(value->>'rankAmountAsc')::bigint,(value->>'rankAmountDesc')::bigint,value->'payload' from jsonb_array_elements($2::jsonb)`,[OWNER,JSON.stringify(model.rows.filter(row=>row.kind==='ledger'))]);
},30_000);
afterAll(async()=>{await db.close();});
async function read(input=query,offset=0,pageOnly=false,owner=OWNER){return(await db.query<{bundle:DurableBundle<DurableOverviewFacts>}>(pageOnly?DURABLE_OVERVIEW_PAGE_SQL:DURABLE_OVERVIEW_SQL,[owner,'accounting-display-v1','GHS',TODAY,JSON.stringify(durableOverviewOptions(TODAY,input,offset))])).rows[0].bundle;}
describe("durable normalized Overview SQL",()=>{
 it("preserves exact full canonical analytics and returns only fifteen details",async()=>{
  const bundle=await read();
  expect(bundle.data.page.rows).toHaveLength(15);expect(bundle.data.page.total).toBe(rows.length);
  expect(overviewSummaryFromFacts(bundle,TODAY,'GHS',buildOverviewSummary(ledger).setup)).toEqual(buildOverviewSummary(ledger));
  expect(bundle.data.page.rows).toEqual(filterOverviewTransactions([...rows.filter(row=>row.type==='expense'),...rows.filter(row=>row.type==='income')],query.filters).slice(0,15));
  expect(JSON.stringify(bundle.data.page.rows)).not.toMatch(/transactionOrdinal|descriptionKey|renewalGroup|sourceText/);
 });
 it.each(['date-desc','date-asc','amount-desc','amount-asc'] as const)("applies complete-history %s sorting before an indexed page",async sort=>{
  const input={...query,filters:{...query.filters,sort}};
  const bundle=await read(input,15,true) as unknown as DurableBundle<DurableOverviewFacts['page']>;
  const full=filterOverviewTransactions([...rows.filter(row=>row.type==='expense'),...rows.filter(row=>row.type==='income')],input.filters);
  expect(bundle.data.rows).toEqual(full.slice(15,30));expect(bundle.data.total).toBe(full.length);
 });
 it("treats wildcard symbols as literal search text and never returns foreign-owner facts",async()=>{
  const filtered=await read({...query,filters:{...query.filters,search:'%_'}});
  expect(filtered.data.page.total).toBe(0);expect(filtered.data.page.rows).toEqual([]);
  expect(await read(query,0,false,OTHER)).toBeNull();
 });
});
