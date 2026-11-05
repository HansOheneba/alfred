import type { SupabaseSettings } from "@/lib/config";
import { DURABLE_FRESH_CTE,tryReadDurableBundle } from "@/lib/finance/accounting/durable-read";

const scope="r.owner_id=$1::uuid and r.definition=$2::text and r.token=(fresh.publication->>'token')::bigint and r.epoch=(fresh.publication->>'epoch')::bigint";
export const DURABLE_BUDGET_SPENDING_SQL=`with ${DURABLE_FRESH_CTE}
select case when fresh.publication is null then null else jsonb_build_object('token',fresh.publication->>'token','manifest',fresh.publication->'manifest','data',coalesce((
 select jsonb_agg(to_jsonb(grouped)) from(select substring(date,1,7)as period,currency,category,sum(amount_minor)as "spentMinor" from alfred_display.rows r where ${scope} and r.kind='ledger' and r.direction='out' group by substring(date,1,7),currency,category) grouped),'[]'::jsonb)) end as bundle from fresh`;
export const DURABLE_ACCOUNT_FACTS_SQL=`with ${DURABLE_FRESH_CTE}
select case when fresh.publication is null then null else jsonb_build_object('token',fresh.publication->>'token','manifest',fresh.publication->'manifest','data',jsonb_build_object('reviewIds',coalesce((select jsonb_agg(r.id order by r.ordinal) from alfred_display.rows r where ${scope} and r.kind='movement' and r.status='review' and r.id=any($3::text[])),'[]'::jsonb))) end as bundle from fresh`;
export async function readDurableBudgetSpending(settings:SupabaseSettings,ownerId:string){
 const result=await tryReadDurableBundle<{period:string;currency:string;category:string;spentMinor:number}[]>(settings,ownerId,DURABLE_BUDGET_SPENDING_SQL);
 if(result&&!Array.isArray(result.data))throw new Error('The budget display could not be verified.');
 if(result?.data.some(row=>!Number.isSafeInteger(row.spentMinor)))throw new Error('The budget total could not be displayed safely.');
 return result;
}
export async function readDurableAccountFacts(settings:SupabaseSettings,ownerId:string,waitingIds:string[]=[]){
 if(waitingIds.length>20)throw new Error('Choose at most twenty waiting records.');
 return tryReadDurableBundle<{reviewIds:string[]}>(settings,ownerId,DURABLE_ACCOUNT_FACTS_SQL,[waitingIds]);
}
