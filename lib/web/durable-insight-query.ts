import { z } from "zod";
import type { SupabaseSettings, UserProfile } from "@/lib/config";
import type { BillRecord } from "@/lib/finance/bills";
import { comparableInsightRange, type DisplayInsightFacts, type DisplayRenewalFacts } from "@/lib/finance/display-insight-facts";
import { endOfMonth, isRealDate } from "@/lib/finance/dates";
import { DURABLE_FRESH_CTE, tryReadDurableBundle, type DurableBundle } from "@/lib/finance/accounting/durable-read";

export type DurableInsightData = {
  insights: DisplayInsightFacts;
  renewals: DisplayRenewalFacts[];
  budgetSpending: { period: string; currency: string; category: string; spentMinor: number }[];
  reviewIds: string[];
  days: { date: string; minor: number }[];
};
const array = (select: string) => `coalesce((select jsonb_agg(to_jsonb(item)) from (${select}) item),'[]'::jsonb)`;
const scope = (alias: string) => `${alias}.owner_id=$1::uuid and ${alias}.definition=$2::text and ${alias}.token=(fresh.publication->>'token')::bigint and ${alias}.epoch=(fresh.publication->>'epoch')::bigint`;
const expenseFact = (alias: string) => `jsonb_build_object('description',${alias}.payload->>'description','minor',${alias}.amount_minor,'category',${alias}.category)`;

/** Each resource is selected from one fresh generation. Only aggregates and bounded evidence leave SQL. */
export const DURABLE_INSIGHT_SQL = `with ${DURABLE_FRESH_CTE},
 options as (select $5::jsonb as value),
 ledger as materialized (
   select r.*,(r.payload->>'transactionOrdinal')::bigint as transaction_ordinal from alfred_display.rows r cross join fresh
   where fresh.publication is not null and ${scope("r")} and r.kind='ledger'
 ), own as materialized (select * from ledger where currency=$3::text),
 current as materialized (
   select r.* from own r cross join options where r.date>=options.value#>>'{range,start}' and r.date<=options.value#>>'{range,end}'
 ), expenses as materialized (select * from current where direction='out'),
 previous as materialized (
   select r.* from own r cross join options where r.direction='out' and r.date>=options.value#>>'{previous,start}' and r.date<=options.value#>>'{previous,end}'
 ), category_facts as (
   select category,sum(amount_minor) as minor,count(*)::integer as count from expenses group by category
 ), repeat_groups as (
   select payload->>'descriptionKey' as description_key,(array_agg(payload->>'descriptionLabel' order by transaction_ordinal))[1] as description,
     sum(amount_minor) as minor,count(*)::integer as count,min(transaction_ordinal) as first_ordinal
   from expenses where category<>'Fees' group by payload->>'descriptionKey' having count(*)>=3
 ), budget_groups as materialized (
   select substring(date,1,7) as period,currency,category,sum(amount_minor) as spent_minor,min(transaction_ordinal) as first_ordinal
   from ledger where direction='out' group by substring(date,1,7),currency,category
 ), renewal_rows as materialized (
   select r.*,r.payload#>>'{renewalGroup,id}' as group_id from own r cross join options
   where direction='out' and amount_minor>0 and date<=$4::text and nullif(r.payload#>>'{renewalGroup,id}','') is not null
     and not exists(select 1 from jsonb_array_elements_text(options.value->'savedNames') saved(name) where saved.name=r.payload#>>'{renewalGroup,nameKey}')
 ), renewal_groups as (
   select group_id,(array_agg(payload#>>'{renewalGroup,name}' order by transaction_ordinal))[1] as name,
     min(transaction_ordinal) as first_ordinal,count(*)::integer as payment_count from renewal_rows group by group_id
 ), renewal_days as (
   select group_id,date,row_number() over(partition by group_id order by date desc) as rank from (select distinct group_id,date from renewal_rows) days
 ), renewal_payments as (
   select *,row_number() over(partition by group_id order by date desc,transaction_ordinal desc) as rank from renewal_rows
 )
 select case when fresh.publication is null then null else jsonb_build_object(
   'token',fresh.publication->>'token','manifest',fresh.publication->'manifest','data',jsonb_build_object(
     'insights',jsonb_build_object(
       'ownerId',$1::text,'currency',$3::text,'range',(select value->'range' from options),'today',$4::text,
       'expenseCount',(select count(*) from expenses),'spentMinor',coalesce((select sum(amount_minor) from expenses),0),
       'incomeMinor',coalesce((select sum(amount_minor) from current where direction='in'),0),
       'categories',${array(`select c.category,c.minor,c.count,(select ${expenseFact("r")} from expenses r where r.category=c.category order by r.amount_minor desc,r.transaction_ordinal limit 1) as biggest from category_facts c`)},
       'repeats',${array("select description,count,minor from repeat_groups order by minor desc,first_ordinal limit 2")},
       'fees',jsonb_build_object('count',(select count(*) from expenses where category='Fees'),'minor',coalesce((select sum(amount_minor) from expenses where category='Fees'),0)),
       'biggest',(select ${expenseFact("r")} from expenses r order by r.amount_minor desc,r.transaction_ordinal limit 1),
       'weekend',jsonb_build_object('count',(select count(*) from expenses where extract(isodow from date::date) in (6,7)),'minor',coalesce((select sum(amount_minor) from expenses where extract(isodow from date::date) in (6,7)),0)),
       'previous',jsonb_build_object('count',(select count(*) from previous),'minor',coalesce((select sum(amount_minor) from previous),0),'categories',${array("select category,sum(amount_minor) as minor from previous group by category")}),
       'budgetSpending',${array("select $1::text as \"ownerId\",period,currency,category,spent_minor as \"spentMinor\" from budget_groups cross join options where currency=$3::text and period=substring(options.value#>>'{range,start}',1,7) order by first_ordinal")}
     ),
     'renewals',${array(`select g.group_id as id,g.name,$3::text as currency,g.first_ordinal as "firstOrdinal",g.payment_count as "paymentCount",
       coalesce((select jsonb_agg(d.date order by d.date) from renewal_days d where d.group_id=g.group_id and d.rank<=4),'[]'::jsonb) as "recentDates",
       coalesce((select jsonb_agg(jsonb_build_object('date',p.date,'ordinal',p.transaction_ordinal,'minor',p.amount_minor,'amount',p.payload->>'amount') order by p.date,p.transaction_ordinal) from renewal_payments p where p.group_id=g.group_id and p.rank<=4),'[]'::jsonb) as "recentPayments"
       from renewal_groups g order by g.first_ordinal`)},
     'budgetSpending',${array("select period,currency,category,spent_minor as \"spentMinor\" from budget_groups order by first_ordinal")},
     'days',${array("select date,sum(amount_minor) as minor from expenses where date<=$4::text group by date order by date")},
     'reviewIds',coalesce((select jsonb_agg(r.id order by r.ordinal) from alfred_display.rows r cross join options where ${scope("r")} and r.kind='movement' and r.status='review' and r.id in(select jsonb_array_elements_text(options.value->'waitingMovementIds'))),'[]'::jsonb)
   )
 ) end as bundle from fresh`;

const money = z.number().int().safe(), count = z.number().int().nonnegative().safe();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/), currency = z.string().regex(/^[A-Z]{3}$/);
const range = z.object({ start: day, end: day });
const expense = z.object({ description: z.string(), minor: money, category: z.string() });
const budgetSpending = z.object({ period: z.string().regex(/^\d{4}-\d{2}$/), currency, category: z.string(), spentMinor: money });
const factsSchema = z.object({
  insights: z.object({ ownerId: z.string(), currency, range, today: day, expenseCount: count, spentMinor: money, incomeMinor: money,
    categories: z.array(z.object({ category: z.string(), minor: money, count, biggest: expense.nullable() })),
    repeats: z.array(z.object({ description: z.string(), count, minor: money })).max(2),
    fees: z.object({ count, minor: money }), biggest: expense.nullable(), weekend: z.object({ count, minor: money }),
    previous: z.object({ count, minor: money, categories: z.array(z.object({ category: z.string(), minor: money })) }),
    budgetSpending: z.array(budgetSpending.extend({ ownerId: z.string() })),
  }),
  renewals: z.array(z.object({ id: z.string(), name: z.string(), currency, firstOrdinal: count, paymentCount: count,
    recentDates: z.array(day).max(4), recentPayments: z.array(z.object({ date: day, ordinal: count, minor: money, amount: z.string() })).max(4) })),
  budgetSpending: z.array(budgetSpending), reviewIds: z.array(z.string()).max(20), days: z.array(z.object({ date: day, minor: money })).max(31),
});

/** null means feature off/schema absent. A dirty projection queues work and throws Updating. */
export async function readDurableInsightFacts(settings: SupabaseSettings, profile: UserProfile, today: string, savedBills: BillRecord[], waitingMovementIds: string[] = []): Promise<DurableBundle<DurableInsightData> | null> {
  if (!isRealDate(today) || !/^[A-Z]{3}$/.test(profile.currency)) throw new Error("The financial display date or currency is invalid.");
  const ids = z.array(z.string().min(1).max(512)).max(20).parse(waitingMovementIds);
  const range = { start: `${today.slice(0, 7)}-01`, end: endOfMonth(today) };
  const options = { range, previous: comparableInsightRange(range, today), savedNames: [...new Set(savedBills.map(row => row.name.trim().toLowerCase()))], waitingMovementIds: [...new Set(ids)] };
  const bundle = await tryReadDurableBundle<unknown>(settings, profile.profileId, DURABLE_INSIGHT_SQL, [profile.currency, today, JSON.stringify(options)]);
  if (!bundle) return null;
  const data = factsSchema.parse(bundle.data);
  if (data.insights.ownerId !== profile.profileId || data.insights.currency !== profile.currency || data.insights.today !== today
    || data.insights.range.start !== range.start || data.insights.range.end !== range.end || data.reviewIds.some(id => !ids.includes(id))) throw new Error("The financial display facts could not be verified.");
  return { ...bundle, data };
}
