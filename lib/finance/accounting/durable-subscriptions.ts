import { z } from "zod";
import type { SupabaseSettings } from "@/lib/config";
import type { BillRecord } from "../bills";
import { upcomingBills } from "../bill-schedule";
import { formatDisplayRenewals } from "../display-insight-facts";
import { isRealDate } from "../dates";
import type { SubscriptionsData } from "@/app/accounts/subscriptions-actions";
import { DURABLE_FRESH_CTE, tryReadDurableBundle } from "./durable-read";

const scope = "r.owner_id=$1::uuid and r.definition=$2::text and r.token=(fresh.publication->>'token')::bigint and r.epoch=(fresh.publication->>'epoch')::bigint";
/** Subscriptions use only primary accounting reports, independently of Overview's legacy/raw overlay. */
export const DURABLE_SUBSCRIPTIONS_SQL = `with ${DURABLE_FRESH_CTE},
  primary_rows as materialized (
    select r.payload->'subscriptionReport' as report,(r.payload->>'subscriptionReportOrdinal')::bigint as ordinal,r.payload->'subscriptionRenewalGroup' as service
    from alfred_display.rows r cross join fresh where ${scope} and r.kind='movement' and r.payload->'subscriptionReport' is not null and r.payload->'subscriptionReport'<>'null'::jsonb
  ), renewal_rows as materialized (
    select report->>'date' as date,report->>'amount' as amount,(report->>'minor')::bigint as minor,ordinal,service->>'id' as group_id,service->>'name' as name
    from primary_rows where report->>'type'='expense' and report->>'currency'=$3::text and (report->>'minor')::bigint>0 and report->>'date'<=$4::text
      and nullif(service->>'id','') is not null
      and not exists(select 1 from jsonb_array_elements_text($5::jsonb) saved(name) where saved.name=service->>'nameKey')
  ), groups as (
    select group_id,(array_agg(name order by ordinal))[1] as name,min(ordinal) as first_ordinal,count(*)::integer as payment_count from renewal_rows group by group_id
  ), days as (
    select group_id,date,row_number() over(partition by group_id order by date desc) as rank from(select distinct group_id,date from renewal_rows) unique_days
  ), payments as (
    select *,row_number() over(partition by group_id order by date desc,ordinal desc) as rank from renewal_rows
  ) select case when fresh.publication is null then null else jsonb_build_object('token',fresh.publication->>'token','manifest',fresh.publication->'manifest',
    'data',coalesce((select jsonb_agg(jsonb_build_object('id',g.group_id,'name',g.name,'currency',$3::text,'firstOrdinal',g.first_ordinal,'paymentCount',g.payment_count,
      'recentDates',coalesce((select jsonb_agg(d.date order by d.date) from days d where d.group_id=g.group_id and d.rank<=4),'[]'::jsonb),
      'recentPayments',coalesce((select jsonb_agg(jsonb_build_object('date',p.date,'ordinal',p.ordinal,'minor',p.minor,'amount',p.amount) order by p.date,p.ordinal) from payments p where p.group_id=g.group_id and p.rank<=4),'[]'::jsonb)) order by g.first_ordinal) from groups g),'[]'::jsonb)) end as bundle from fresh`;
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/), count = z.number().int().nonnegative().safe();
const renewalFacts = z.array(z.object({ id: z.string(), name: z.string(), currency: z.string().regex(/^[A-Z]{3}$/), firstOrdinal: count, paymentCount: count,
  recentDates: z.array(day).max(4), recentPayments: z.array(z.object({ date: day, ordinal: count, minor: z.number().int().safe(), amount: z.string() })).max(4) }));
export async function tryLoadDurableSubscriptions(settings: SupabaseSettings, ownerId: string, currency: string, today: string, bills: BillRecord[]): Promise<SubscriptionsData | null> {
  if (!isRealDate(today) || !/^[A-Z]{3}$/.test(currency)) throw new Error("The subscription date or currency is invalid.");
  const names = [...new Set(bills.map(bill => bill.name.trim().toLowerCase()))];
  const bundle = await tryReadDurableBundle<unknown>(settings, ownerId, DURABLE_SUBSCRIPTIONS_SQL, [currency, today, JSON.stringify(names)]);
  if (!bundle) return null;
  if (bundle.manifest.accounts.subscriptionFactsVersion !== 1) throw new Error("The subscription display could not be verified.");
  const facts = renewalFacts.parse(bundle.data);
  if (facts.some(row => row.currency !== currency)) throw new Error("The subscription display could not be verified.");
  return { bills, currency, today, upcoming: upcomingBills(bills, today), suggestions: formatDisplayRenewals(facts, today, currency) };
}
