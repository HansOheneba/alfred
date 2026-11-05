import { z } from "zod";
import { loadAccountingReadModel } from "./persisted-store";
import type { SupabaseSettings } from "@/lib/config";
import { emptyActivityFilters } from "@/app/accounts/activity-tools";
import { balanceForCurrency, type AccountsModelManifest } from "./accounts-model";
import { DURABLE_FRESH_CTE, tryReadDurableBundle } from "./durable-read";
import { AccountsReadViewError, projectAccountsReadView, type AccountsReadPage, type AccountsReadQuery, type AccountsReadView } from "./read-view";

// Every fact lookup is constrained to the same fresh owner/cohort in this statement.
const scope = (alias: string) => `${alias}.owner_id=$1::uuid and ${alias}.definition=$2::text and ${alias}.token=(fresh.publication->>'token')::bigint and ${alias}.epoch=(fresh.publication->>'epoch')::bigint`;
const currentMovement = (id: string) => `(select movement.payload->'movement' from alfred_display.rows movement where ${scope("movement")} and movement.kind='movement' and movement.id=${id})`;
const f = (name: string) => `coalesce($3::jsonb->'filters'->>'${name}','')`;
const q = (name: string) => `coalesce($3::jsonb->>'${name}','')`;
const reportMatch = `exists(select 1 from jsonb_array_elements(r.payload->'reportMatches') entry where
  (${f("category")}='' or entry->>'category'=${f("category")}) and
  (${f("type")}='all' or entry->>'type'=${f("type")}) and
  (${f("currency")}='' or entry->>'currency'=${f("currency")}) and
  (${q("needle")}='' or strpos(entry->>'searchText',${q("needle")})>0))`;

/** SQL consumes normalized facts; it never reads or reconstructs financial source history. */
export function accountsDurableQuery(query: AccountsReadQuery): string {
  if (query.section === "settlement-plan") return settlementPlanQuery;
  let kind: string, where = "true", order = "r.ordinal", payload = "selected.payload";
  switch (query.section) {
    case "activity":
    case "attention": {
      kind = "movement";
      const rank = { "date-asc": "rank_date_asc", "date-desc": "rank_date_desc", "amount-asc": "rank_amount_asc", "amount-desc": "rank_amount_desc" }[query.filters?.sort ?? "date-desc"];
      order = `r.${rank}`;
      where = `(${f("account")}='' or r.account_id=${f("account")} or (${f("account")}='unassigned' and r.account_id is null))
        and (${f("status")}='' or r.status=${f("status")}) and (${f("start")}='' or r.date>=${f("start")}) and (${f("end")}='' or r.date<=${f("end")})
        and (${f("currency")}='' or r.currency=${f("currency")})
        and (case when ${f("category")}<>'' or ${f("type")}<>'all' then ${reportMatch}
          else (${q("needle")}='' or ${reportMatch} or strpos(r.search_text,${q("needle")})>0) end)
        ${query.section === "attention" ? "and r.needs_attention" : ""}`;
      payload = "selected.payload->'movement'";
      break;
    }
    case "movement": kind = "movement"; where = `r.id=${q("movementId")}`; payload = "selected.payload->'movement'"; break;
    case "similar": kind = "movement"; where = `r.needs_attention and r.group_key=${q("groupKey")} and r.status<>'transfer' and coalesce(r.payload->'movement'->>'linked','false')='false'`; payload = "selected.payload->'movement'"; break;
    case "targets": kind = "movement"; where = `r.status='confirmed' and (${q("direction")}='' or r.direction=${q("direction")}) and (${q("accountId")}='' or r.account_id=${q("accountId")}) and (${q("targetNeedle")}='' or strpos(r.search_text,${q("targetNeedle")})>0)`; payload = "selected.payload->'movement'"; break;
    case "snapshots": kind = "snapshot"; order = "r.rank_date_desc"; where = `(${q("accountId")}='' or r.account_id=${q("accountId")})`; break;
    case "transfers": kind = "transfer"; payload = `jsonb_build_object('link',selected.payload->'link','outgoing',${currentMovement("selected.payload#>>'{link,outgoing,movementId}'")},'incoming',${currentMovement("selected.payload#>>'{link,incoming,movementId}'")})`; break;
    case "settlements": kind = "settlement"; payload = `(selected.payload->'summary') || jsonb_build_object('original',${currentMovement("selected.payload#>>'{link,original,movementId}'")})`; break;
    case "returns": kind = "return"; where = `r.relation_id=${q("settlementId")}`; payload = `jsonb_build_object('movement',${currentMovement("selected.payload->>'movementId'")},'reference',selected.payload->'reference','principalMinor',selected.payload->'principalMinor')`; break;
    case "evidence": kind = "evidence"; where = `r.id=${q("movementId")}`; break;
    default: throw new AccountsReadViewError("Check the account view options and try again.");
  }
  return `with ${DURABLE_FRESH_CTE},
    eligible as materialized (select r.ordinal,r.payload,${order} as sort_rank from alfred_display.rows r cross join fresh where ${scope("r")} and r.kind='${kind}' and (${where})),
    counted as (select count(*)::bigint as total from eligible),
    paging as (select least(($3::jsonb->>'page')::bigint,greatest(0,(total+24)/25-1)) as page,total from counted),
    selected as materialized (select e.payload,e.sort_rank,e.ordinal from eligible e
      order by e.sort_rank,e.ordinal limit 25 offset (select page*25 from paging)),
    page_rows as (select coalesce(jsonb_agg(${payload} order by selected.sort_rank,selected.ordinal),'[]'::jsonb) as rows from selected cross join fresh)
    select case when fresh.publication is null then null else jsonb_build_object('token',fresh.publication->>'token','manifest',fresh.publication->'manifest',
      'data',jsonb_build_object('section',$3::jsonb->>'section','page',paging.page,'total',paging.total,'rows',page_rows.rows)) end as bundle
    from fresh cross join paging cross join page_rows`;
}

const settlementPlanQuery = `with ${DURABLE_FRESH_CTE},
  candidates as materialized (select r.payload from alfred_display.rows r cross join fresh where ${scope("r")} and r.kind='settlement' and r.relation_id=${q("movementId")}),
  matches as (select payload->'link' as link from candidates where payload#>>'{link,kind}'=${q("kind")}),
  plan as (select count(*) as matches,max(jsonb_array_length(link->'returns')) as return_count,(jsonb_agg(link)->0) as existing from matches),
  used as (select coalesce(sum((entry->>'principalMinor')::numeric),0) as principal from candidates cross join lateral jsonb_array_elements(payload#>'{link,returns}') entry)
  select case when fresh.publication is null then null else jsonb_build_object('token',fresh.publication->>'token','manifest',fresh.publication->'manifest',
    'data',jsonb_build_object('section','settlement-plan','page',0,'total',1,'conflict',plan.matches>1 or coalesce(plan.return_count,0)>100,
      'rows',jsonb_build_array(jsonb_build_object('existing',case when plan.existing is null then null else jsonb_build_object('id',plan.existing->'id','kind',plan.existing->'kind','original',plan.existing->'original','returns',plan.existing->'returns') end,'usedPrincipalMinor',used.principal)))) end as bundle
  from fresh cross join plan cross join used`;

const pageSchema = z.object({ section: z.string(), page: z.number().int().nonnegative().safe(), total: z.number().int().nonnegative().safe(), rows: z.array(z.unknown()).max(25), conflict: z.boolean().optional() });
function verifiedManifest(value: AccountsModelManifest, ownerId: string, revision: number, sourceVersion: string | null): AccountsModelManifest {
  if (value?.kind !== "accounts-model" || value.schemaVersion !== 1 || value.ownerId !== ownerId || value.revision !== revision || value.sourceVersion !== sourceVersion
    || !Array.isArray(value.accountFacts) || !Array.isArray(value.accounts) || !Array.isArray(value.audit) || value.audit.length > 50 || !value.counts || !value.facets || !value.attentionCounts || !Array.isArray(value.attentionGroups)) throw new Error("The account display could not be verified.");
  return value;
}

/** null means feature off/schema absent; a ready but dirty/missing model explicitly reports updating. */
export async function tryLoadDurableAccountsView(settings: SupabaseSettings, ownerId: string, query: AccountsReadQuery): Promise<AccountsReadView | null> {
  if (!Number.isSafeInteger(query.page) || query.page < 0) throw new AccountsReadViewError("Check the account view options and try again.");
  const filters = { ...emptyActivityFilters, ...query.filters };
  const bundle = await tryReadDurableBundle<unknown>(settings, ownerId, accountsDurableQuery(query), [JSON.stringify({ ...query, filters, needle: filters.search.trim().toLowerCase(), targetNeedle: query.search?.trim().toLowerCase() ?? "" })]);
  if (!bundle) return null;
  const manifest = verifiedManifest(bundle.manifest.accounts, ownerId, bundle.manifest.revision, bundle.manifest.sourceVersion);
  if (query.expectedRevision !== undefined || query.expectedSourceVersion !== undefined) {
    if (query.expectedRevision === undefined || query.expectedSourceVersion === undefined) throw new AccountsReadViewError("Check the account view options and try again.");
    if (query.expectedRevision !== manifest.revision || query.expectedSourceVersion !== manifest.sourceVersion) throw new AccountsReadViewError("Financial records or source evidence changed. Reload the latest account view.", 409);
  }
  const page = pageSchema.parse(bundle.data);
  if (page.section !== query.section || page.rows.length > page.total) throw new Error("The account page could not be verified.");
  if (page.conflict) throw new AccountsReadViewError("The saved return links need review before adding another return.", 409);
  if (query.section === "evidence") {
    const row = page.rows[0] as { sourceFingerprint?: unknown } | undefined;
    if (!row) throw new AccountsReadViewError("That payment is unavailable in your account.");
    if (row.sourceFingerprint !== query.fingerprint) throw new AccountsReadViewError("The payment's source evidence changed. Reload its latest details.", 409);
  }
  return { kind: "accounts-read", ownerId, revision: manifest.revision, sourceVersion: manifest.sourceVersion, availability: manifest.availability,
    currency: query.currency, accounts: manifest.accounts, balances: balanceForCurrency(manifest.accountFacts, query.currency),
    attentionCounts: manifest.attentionCounts, attentionGroups: manifest.attentionGroups, counts: manifest.counts, audit: manifest.audit,
    facets: { currencies: [...new Set([query.currency, ...manifest.facets.currencies])].sort(), categories: manifest.facets.categories },
    page: { section: page.section, page: page.page, pageSize: 25, total: page.total, rows: page.rows } as AccountsReadPage };
}

/** Durable mode is optional; only off/absent schema retains the established canonical read. */
export async function loadAccountsReadView(settings: SupabaseSettings, ownerId: string, query: AccountsReadQuery): Promise<AccountsReadView> {
  const durable = await tryLoadDurableAccountsView(settings, ownerId, query);
  if (durable) return durable;
  const result = await loadAccountingReadModel(settings, ownerId);
  if (result.state.ownerId !== ownerId) throw new AccountsReadViewError("Those financial records are unavailable in your account.", 403);
  return projectAccountsReadView(result, query);
}
