import type { SupabaseSettings, UserProfile } from "@/lib/config";
import { DURABLE_FRESH_CTE, tryReadDurableBundle, type DurableBundle } from "@/lib/finance/accounting/durable-read";
import { RANGE_LABELS, buildSankeyModel, monthlySeries, presetRange, weeklyPace, type LedgerRow, type RangePreset } from "@/lib/finance/analytics";
import { addDays } from "@/lib/finance/dates";
import type { OverviewReport, OverviewSummary } from "./overview-summary";
import { overviewYearRange } from "./overview-summary";
import type { OverviewTransactionQuery } from "./overview-transactions";

const array = (select: string) => `coalesce((select jsonb_agg(to_jsonb(item)) from (${select}) item),'[]'::jsonb)`;
export const DURABLE_LEDGER_CTES = `${DURABLE_FRESH_CTE}, options as (select $5::jsonb as value), ledger as materialized (
  select r.* from alfred_display.rows r cross join fresh
  where fresh.publication is not null and r.owner_id=$1::uuid and r.definition=$2::text
    and r.token=(fresh.publication->>'token')::bigint and r.epoch=(fresh.publication->>'epoch')::bigint and r.kind='ledger'
), own as materialized (select * from ledger where currency=$3::text), periods as (
  select input.key,case when input.key='all' then date_trunc('month',least($4::date,coalesce((select min(date::date) from own),$4::date)))::date else input.start::date end as start,input.end::date as end
  from options cross join jsonb_to_recordset(options.value->'periods') as input(key text,start text,"end" text)
), matching as materialized (
  select r.* from own r cross join options join periods p on p.key=options.value#>>'{query,preset}'
  where r.date>=p.start::text and r.date<=p.end::text
    and (options.value#>>'{query,type}'='all' or r.direction=case when options.value#>>'{query,type}'='expense' then 'out' else 'in' end)
    and (options.value#>>'{query,category}'='all' or r.category=options.value#>>'{query,category}')
    and (options.value#>>'{query,search}'='' or position(options.value#>>'{query,search}' in r.payload->>'descriptionSearch')>0 or position(options.value#>>'{query,search}' in r.payload->>'categorySearch')>0)
), selected as (
  select * from matching cross join options order by case options.value#>>'{query,sort}' when 'date-asc' then rank_date_asc when 'date-desc' then rank_date_desc when 'amount-asc' then rank_amount_asc else rank_amount_desc end
  limit 15 offset (select (value->>'offset')::integer from options)
)`;
const detailRows = `coalesce((select jsonb_agg(payload - array['transactionOrdinal','descriptionKey','descriptionLabel','descriptionSearch','categorySearch','paymentLabel','merchantKey','merchantLabelRank','renewalGroup'] order by case (select value#>>'{query,sort}' from options) when 'date-asc' then rank_date_asc when 'date-desc' then rank_date_desc when 'amount-asc' then rank_amount_asc else rank_amount_desc end) from selected),'[]'::jsonb)`;
const pageData = `jsonb_build_object('rows',${detailRows},'total',(select count(*) from matching),'categories',${array("select distinct r.category from own r cross join options join periods p on p.key=options.value#>>'{query,preset}' where r.date>=p.start::text and r.date<=p.end::text order by r.category")})`;
export const DURABLE_OVERVIEW_PAGE_SQL = `with ${DURABLE_LEDGER_CTES}
select case when fresh.publication is null then null else jsonb_build_object('token',fresh.publication->>'token','manifest',fresh.publication->'manifest','data',${pageData}) end as bundle from fresh`;

export const DURABLE_OVERVIEW_SQL = `with ${DURABLE_LEDGER_CTES}, ranged as materialized (
 select p.key,r.* from own r join periods p on r.date>=p.start::text and r.date<=p.end::text
), category_groups as (
 select key,category,direction,sum(amount_minor)::bigint as minor,count(*)::integer as count from ranged group by key,category,direction
), description_groups as (
 select key,category,payload->>'descriptionKey' as description_key,(array_agg(payload->>'descriptionLabel' order by ordinal))[1] as label,
   sum(amount_minor)::bigint as minor,count(*)::integer as count,min(ordinal) as first_ordinal
 from ranged where direction='out' group by key,category,payload->>'descriptionKey'
), descriptions as (
 select *,row_number() over(partition by key,category order by minor desc,first_ordinal) as rank from description_groups
)
select case when fresh.publication is null then null else jsonb_build_object('token',fresh.publication->>'token','manifest',fresh.publication->'manifest','data',jsonb_build_object(
 'page',${pageData},'currencyCount',(select count(*) from own),
 'periods',${array(`select p.key,jsonb_build_object('start',p.start::text,'end',p.end::text) as range,
   jsonb_build_object('start',(p.start-(p.end-p.start+1))::text,'end',(p.start-1)::text) as previous,
   coalesce((select sum(amount_minor) from ranged where key=p.key and direction='out'),0)::bigint as spent,
   coalesce((select sum(amount_minor) from ranged where key=p.key and direction='in'),0)::bigint as earned,
   coalesce((select sum(amount_minor) from own where date>=(p.start-(p.end-p.start+1))::text and date<p.start::text and direction='out'),0)::bigint as "previousSpent",
   coalesce((select sum(amount_minor) from own where date>=(p.start-(p.end-p.start+1))::text and date<p.start::text and direction='in'),0)::bigint as "previousEarned",
   ${array("select category,direction,minor,count from category_groups where key=p.key")} as categories,
   ${array("select payload->>'paymentLabel' as account,sum(amount_minor)::bigint as minor,count(*)::integer as count from ranged where key=p.key and direction='out' and amount_minor>0 group by payload->>'paymentLabel'")} as accounts,
   ${array("select date,sum(amount_minor)::bigint as minor from ranged where key=p.key and direction='out' group by date")} as days,
   ${array("select (extract(isodow from date::date)-1)::integer as weekday,sum(amount_minor)::bigint as minor from ranged where key=p.key and direction='out' group by 1")} as weekdays,
   ${array("select category,label,minor,count,first_ordinal as ordinal from descriptions where key=p.key and rank<=6 order by minor desc,first_ordinal")} as descriptions
 from periods p`)},
 'months',${array("select substring(date,1,7) as month,coalesce(sum(amount_minor) filter(where direction='out'),0)::bigint as spent,coalesce(sum(amount_minor) filter(where direction='in'),0)::bigint as income from own cross join options where date>=options.value#>>'{yearRange,start}' and date<=options.value#>>'{yearRange,end}' group by substring(date,1,7)")},
 'categoryMonths',${array("select category,substring(date,1,7) as month,coalesce(sum(amount_minor) filter(where direction='out'),0)::bigint as spent from own cross join options where date>=options.value#>>'{yearRange,start}' and date<=options.value#>>'{yearRange,end}' group by category,substring(date,1,7)")},
 'allCategories',${array("select category,min(ordinal) as ordinal from own group by category order by min(ordinal)")},
 'pace',jsonb_build_object('thisWeekMinor',coalesce((select sum(amount_minor) from own cross join options where direction='out' and date>=options.value#>>'{pace,weekStart}' and date<=$4::text),0),'lastWeekSameStretchMinor',coalesce((select sum(amount_minor) from own cross join options where direction='out' and date>=options.value#>>'{pace,lastStart}' and date<=options.value#>>'{pace,lastEnd}'),0))
)) end as bundle from fresh`;

type CategoryFact = { category: string; direction: string; minor: number; count: number };
export type DurableOverviewFacts = {
 page: { rows: LedgerRow[]; total: number; categories: string[] }; currencyCount: number;
 periods: { key: RangePreset; range: { start: string; end: string }; previous: { start: string; end: string }; spent: number; earned: number; previousSpent: number; previousEarned: number;
   categories: CategoryFact[]; accounts: { account: string; minor: number; count: number }[]; days: { date: string; minor: number }[]; weekdays: { weekday: number; minor: number }[];
   descriptions: { category: string; label: string; minor: number; count: number; ordinal: number }[] }[];
 months: { month: string; spent: number; income: number }[]; categoryMonths: { category: string; month: string; spent: number }[]; allCategories: { category: string; ordinal: number }[];
 pace: { thisWeekMinor: number; lastWeekSameStretchMinor: number };
};
export function durableOverviewOptions(today: string, query: OverviewTransactionQuery, offset = 0) {
 const periods = (Object.keys(RANGE_LABELS) as RangePreset[]).map(key => ({ key, ...presetRange(key,today) }));
 const pace = weeklyPace([],today,"GHS");
 return { periods, offset, query: { preset: query.preset, search: query.filters.search.trim().toLowerCase(), category: query.category ?? query.filters.category, type: query.filters.type, sort: query.filters.sort }, yearRange: overviewYearRange(today), pace: { weekStart: pace.weekStart, lastStart: addDays(pace.weekStart,-7), lastEnd: addDays(today,-7) } };
}
export async function readDurableOverview(settings: SupabaseSettings, profile: UserProfile, today: string, query: OverviewTransactionQuery): Promise<DurableBundle<DurableOverviewFacts> | null> {
 return tryReadDurableBundle<DurableOverviewFacts>(settings,profile.profileId,DURABLE_OVERVIEW_SQL,[profile.currency,today,JSON.stringify(durableOverviewOptions(today,query))]);
}
export async function readDurableOverviewPage(settings: SupabaseSettings, profile: UserProfile, today: string, query: OverviewTransactionQuery, offset: number): Promise<DurableBundle<DurableOverviewFacts["page"]> | null> {
 return tryReadDurableBundle<DurableOverviewFacts["page"]>(settings,profile.profileId,DURABLE_OVERVIEW_PAGE_SQL,[profile.currency,today,JSON.stringify(durableOverviewOptions(today,query,offset))]);
}

/** Zero-fill calendar series after aggregating in SQL; no historical details enter the process. */
export function overviewSummaryFromFacts(bundle: DurableBundle<DurableOverviewFacts>, today: string, currency: string, setup: OverviewSummary["setup"]): OverviewSummary {
 const facts=bundle.data, year=overviewYearRange(today), frames=monthlySeries([],year,currency);
 const byMonth=new Map(facts.months.map(row=>[row.month,row]));
 const monthly=frames.map(frame=>({...frame,spent:byMonth.get(frame.month)?.spent??0,income:byMonth.get(frame.month)?.income??0}));
 const categoryTrends=Object.fromEntries(facts.allCategories.map(({category})=>[category,frames.slice(-6).map(frame=>({label:frame.label,spent:facts.categoryMonths.find(row=>row.category===category&&row.month===frame.month)?.spent??0}))]));
 const reports=Object.fromEntries(facts.periods.map(fact=>{
   const categories=fact.categories.filter(row=>row.direction==='out').map(({category,minor,count})=>({category,minor,count})).sort((a,b)=>b.minor-a.minor||a.category.localeCompare(b.category));
   const moneyRow=(row:CategoryFact):LedgerRow=>({id:row.category,date:fact.range.start,type:row.direction==='out'?'expense':'income',minor:row.minor,amount:String(row.minor/100),currency,category:row.category,description:'',paymentMethod:''});
   const income=fact.categories.filter(row=>row.direction==='in').map(moneyRow),expenses=fact.categories.filter(row=>row.direction==='out').map(moneyRow);
   const days=new Map(fact.days.map(day=>[day.date,day.minor])); let running=0;
   const end=today<fact.range.end&&today>=fact.range.start?today:fact.range.end;
   const daily:OverviewReport['daily']=[];
   for(let date=fact.range.start;date<=end;date=addDays(date,1)){const spent=days.get(date)??0;running+=spent;daily.push({date,label:`${Number(date.slice(8,10))} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(date.slice(5,7))-1]}`,spent,cumulative:running});}
   return [fact.key,{range:fact.range,previous:fact.previous,spent:fact.spent,earned:fact.earned,previousSpent:fact.previousSpent,previousEarned:fact.previousEarned,categories,
     accounts:fact.accounts.sort((a,b)=>b.minor-a.minor||a.account.localeCompare(b.account)),sankey:buildSankeyModel(income,expenses),daily,
     weekdays:['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map((label,weekday)=>({label,spent:fact.weekdays.find(day=>day.weekday===weekday)?.minor??0})),
     transactionCategories:[...new Set(fact.categories.map(row=>row.category))].sort(),categoryDetails:Object.fromEntries(categories.map(({category,minor,count})=>[category,{minor,count,descriptions:fact.descriptions.filter(row=>row.category===category).map(({label,minor,count})=>({label,minor,count}))}]))} satisfies OverviewReport];
 })) as Record<RangePreset,OverviewReport>;
 const pace=weeklyPace([],today,currency); Object.assign(pace,facts.pace); pace.changePercent=pace.lastWeekSameStretchMinor>0?Math.round(((pace.thisWeekMinor-pace.lastWeekSameStretchMinor)/pace.lastWeekSameStretchMinor)*100):null;
 return {reports,categoryTrends,monthly,pace,totalRowCount:bundle.manifest.ledger.count,currencyRowCount:facts.currencyCount,otherCurrencyCount:bundle.manifest.ledger.count-facts.currencyCount,setup};
}
