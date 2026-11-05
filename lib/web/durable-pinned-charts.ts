import { z } from "zod";
import type { SupabaseSettings, UserProfile } from "@/lib/config";
import { formatChartFacts, planChart, type ChartFacts, type ChartPlan, type DrawnChart } from "@/lib/finance/charts";
import { chartQuerySchema, MAX_PINS, type PinnedChart } from "@/lib/finance/pins";
import { DURABLE_FRESH_CTE, tryReadDurableBundle, type DurableBundle } from "@/lib/finance/accounting/durable-read";

const array = (sql: string) => `coalesce((select jsonb_agg(to_jsonb(item)) from (${sql}) item),'[]'::jsonb)`;
/** Eight descriptions share one immutable publication and return aggregates, never historical details. */
export const DURABLE_PINNED_CHARTS_SQL = `with ${DURABLE_FRESH_CTE},
 plans as materialized (select * from jsonb_to_recordset($3::jsonb) as p(pin_index integer,id text,measure text,bucket_by text,category text,start_date text,end_date text,previous_start text,previous_end text,frames jsonb,previous_frames jsonb)),
 ledger as materialized (
   select r.*,(r.payload->>'transactionOrdinal')::bigint as tx_ordinal from alfred_display.rows r cross join fresh
   where fresh.publication is not null and r.owner_id=$1::uuid and r.definition=$2::text
     and r.token=(fresh.publication->>'token')::bigint and r.epoch=(fresh.publication->>'epoch')::bigint and r.kind='ledger'
 ), relevant as materialized (
   select p.pin_index,p.bucket_by,r.*,case when p.measure='net' and r.direction='out' then -r.amount_minor else r.amount_minor end as minor,
     case when p.bucket_by='category' then r.category else r.payload->>'merchantKey' end as label_key
   from plans p join ledger r on (p.measure='net' or r.direction=case when p.measure='income' then 'in' else 'out' end) and (p.category is null or r.category=p.category)
 ), spans as (
   select pin_index,'current'::text as phase,start_date,end_date from plans
   union all select pin_index,'previous',previous_start,previous_end from plans where previous_start is not null
 ), phased as materialized (
   select r.*,s.phase from relevant r join spans s on s.pin_index=r.pin_index and r.date>=s.start_date and r.date<=s.end_date where r.currency=$4::text
 ), frames as (
   select p.pin_index,'current'::text as phase,f.value from plans p cross join lateral jsonb_array_elements(p.frames) f
   union all select p.pin_index,'previous',f.value from plans p cross join lateral jsonb_array_elements(p.previous_frames) f
 ), time_tallies as (
   select f.pin_index,f.phase,f.value->>'key' as key,f.value->>'label' as label,f.value->'range' as range,
     coalesce(sum(r.minor),0) as minor,count(r.id)::integer as count,(f.value->>'key')::bigint as first_ordinal
   from frames f left join phased r on r.pin_index=f.pin_index and r.phase=f.phase and r.date>=f.value#>>'{range,start}' and r.date<=f.value#>>'{range,end}'
   group by f.pin_index,f.phase,f.value
 ), categorical as materialized (
   select pin_index,phase,label_key as key,(array_agg(case when bucket_by='category' then category else payload->>'descriptionLabel' end order by tx_ordinal))[1] as label,
     sum(minor) as minor,count(*)::integer as count,min(tx_ordinal) as first_ordinal,
     (array_agg((payload->>'merchantLabelRank')::bigint order by tx_ordinal))[1] as label_rank
   from phased where bucket_by in ('category','merchant') group by pin_index,phase,label_key
 ), combined as (
   select coalesce(c.pin_index,p.pin_index) as pin_index,coalesce(c.key,p.key) as key,coalesce(c.label,p.label) as label,
     coalesce(c.minor,0) as minor,coalesce(c.count,0) as count,coalesce(p.minor,0) as previous_minor,coalesce(p.count,0) as previous_count,
     coalesce(c.label_rank,p.label_rank) as label_rank,case when c.key is null then 1 else 0 end as previous_only,coalesce(c.first_ordinal,p.first_ordinal) as first_ordinal
   from (select * from categorical where phase='current') c full join (select * from categorical where phase='previous') p on p.pin_index=c.pin_index and p.key=c.key
 ), merchant_ranked as materialized (
   select c.*,row_number() over(partition by c.pin_index order by c.minor desc,c.previous_minor desc,c.label_rank,c.previous_only,c.first_ordinal) as rank
   from combined c join plans p on p.pin_index=c.pin_index where p.bucket_by='merchant'
 ), output_tallies as (
   select * from time_tallies
   union all select c.pin_index,c.phase,c.key,c.label,null::jsonb,c.minor,c.count,c.first_ordinal from categorical c join plans p on p.pin_index=c.pin_index where p.bucket_by='category'
   union all select m.pin_index,'current',m.key,m.label,null::jsonb,m.minor,m.count,m.rank from merchant_ranked m where m.rank<=7
   union all select m.pin_index,'previous',m.key,m.label,null::jsonb,m.previous_minor,m.previous_count,m.rank from merchant_ranked m join plans p on p.pin_index=m.pin_index where m.rank<=7 and p.previous_start is not null
 )
 select case when fresh.publication is null then null else jsonb_build_object('token',fresh.publication->>'token','manifest',fresh.publication->'manifest','data',${array(`select p.id,
   jsonb_build_object(
     'merchantMetadataValid',p.bucket_by<>'merchant' or not exists(select 1 from phased r where r.pin_index=p.pin_index and (jsonb_typeof(r.payload->'merchantKey') is distinct from 'string' or jsonb_typeof(r.payload->'merchantLabelRank') is distinct from 'number')),
     'current',${array("select key,label,minor,count,range from output_tallies t where t.pin_index=p.pin_index and t.phase='current' order by first_ordinal")},
     'previous',${array("select key,label,minor,count,range from output_tallies t where t.pin_index=p.pin_index and t.phase='previous' order by first_ordinal")},
     'totalMinor',coalesce((select sum(minor) from phased where pin_index=p.pin_index and phase='current'),0),
     'previousTotalMinor',coalesce((select sum(minor) from phased where pin_index=p.pin_index and phase='previous'),0),
     'merchantRest',jsonb_build_object('groups',(select count(*) from merchant_ranked where pin_index=p.pin_index and rank>7),'minor',coalesce((select sum(minor) from merchant_ranked where pin_index=p.pin_index and rank>7),0),'count',coalesce((select sum(count) from merchant_ranked where pin_index=p.pin_index and rank>7),0)),
     'otherCurrencies',coalesce((select jsonb_agg(currency order by first_ordinal) from (select r.currency,min(r.tx_ordinal) as first_ordinal from relevant r where r.pin_index=p.pin_index and r.currency<>$4::text and r.date>=p.start_date and r.date<=p.end_date group by r.currency) currencies),'[]'::jsonb)
   ) as facts from plans p order by p.pin_index`)}) end as bundle from fresh`;

const integer = z.number().int().safe(), count = integer.nonnegative();
const span = z.object({ start: z.string(), end: z.string() });
const tally = z.object({ key: z.string(), label: z.string(), minor: integer, count, range: span.nullable().optional() });
const rowsSchema = z.array(z.object({ id: z.string(), facts: z.object({ current: z.array(tally), previous: z.array(tally), totalMinor: integer, previousTotalMinor: integer,
  merchantMetadataValid: z.literal(true), merchantRest: z.object({ groups: count, minor: integer, count }), otherCurrencies: z.array(z.string().regex(/^[A-Z]{3}$/)) }) })).max(MAX_PINS);

export async function readDurablePinnedCharts(settings: SupabaseSettings, profile: UserProfile, today: string, pins: PinnedChart[]): Promise<DurableBundle<{ id: string; chart: DrawnChart }[]> | null> {
  if (pins.length > MAX_PINS || pins.some(pin => pin.ownerId !== profile.profileId) || new Set(pins.map(pin => pin.id)).size !== pins.length) throw new Error("The pinned charts could not be verified.");
  const planned: { id: string; plan: ChartPlan }[] = [];
  for (const pin of pins) {
    if (!chartQuerySchema.safeParse(pin.query).success) continue;
    const resolved = planChart(pin.query, today);
    if (resolved.ok) planned.push({ id: pin.id, plan: resolved.plan });
  }
  const options = planned.map(({ id, plan }, pin_index) => ({ pin_index, id, measure: plan.measure, bucket_by: plan.by, category: plan.query.category ?? null,
    start_date: plan.range.start, end_date: plan.range.end, previous_start: plan.before?.start ?? null, previous_end: plan.before?.end ?? null, frames: plan.frames, previous_frames: plan.previousFrames }));
  const bundle = await tryReadDurableBundle<unknown>(settings, profile.profileId, DURABLE_PINNED_CHARTS_SQL, [JSON.stringify(options), profile.currency]);
  if (!bundle) return null;
  const verified = rowsSchema.safeParse(bundle.data);
  if (!verified.success) throw new Error("The pinned chart facts could not be verified.");
  const parsed = verified.data;
  if (parsed.length !== planned.length || parsed.some((row, index) => row.id !== planned[index].id)) throw new Error("The pinned chart results could not be verified.");
  return { ...bundle, data: parsed.map(({ id, facts }, index) => {
    const plan = planned[index].plan;
    if (plan.by === "merchant" && (facts.current.length > 7 || facts.previous.length > 7)) throw new Error("The merchant chart exceeded its display limit.");
    const clean: ChartFacts = { ...facts, current: facts.current.map(({ range, ...row }) => ({ ...row, ...(range ? { range } : {}) })), previous: facts.previous.map(({ range, ...row }) => ({ ...row, ...(range ? { range } : {}) })) };
    return { id, chart: formatChartFacts(plan, clean, profile.currency, today) };
  }) };
}
