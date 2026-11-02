import type { SupabaseSettings } from "@/lib/config";

/** Catalog-only checks: absent or earlier draft schemas must disable writes before loading data.
 * Version markers are stamped last by the reviewed migrations, after their permission revokes.
 * A future incompatible ABI must use a new marker name and token, rather than reuse this version.
 */
export const ACCOUNT_RULE_SCHEMA_TOKEN = "alfred.account-rules:20261102:v1";
export const PORTABILITY_SCHEMA_TOKEN = "alfred.finance-portability:20261102:v1";
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const marker = (name: string, token: string) => `obj_description(to_regprocedure('public.${name}()'),'pg_proc')=${literal(token)}`;
const columns = (table: string, fields: Record<string, string>) => `not exists(select 1 from (values ${Object.entries(fields).map(([name,type])=>`(${literal(name)},${literal(type)})`).join(",")}) required(name,type) where not exists(select 1 from pg_attribute a where a.attrelid=to_regclass('public.${table}') and a.attname=required.name and a.atttypid=to_regtype(required.type) and a.attnum>0 and not a.attisdropped))`;
const ownedTable = (table: string) => `exists(select 1 from pg_class c where c.oid=to_regclass('public.${table}') and c.relkind='r' and c.relrowsecurity and has_table_privilege(current_user,c.oid,'SELECT') and has_table_privilege(current_user,c.oid,'INSERT') and has_table_privilege(current_user,c.oid,'UPDATE') and has_table_privilege(current_user,c.oid,'DELETE') and not has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') and not has_table_privilege('authenticated',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') and not has_any_column_privilege('anon',c.oid,'INSERT,UPDATE,REFERENCES') and not has_any_column_privilege('authenticated',c.oid,'INSERT,UPDATE,REFERENCES'))`;
const fn = (name: string, args: string[], result: string) => `exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=${literal(name)} and p.pronargs=${args.length} ${args.map((type,index)=>`and p.proargtypes[${index}]=to_regtype(${literal(type)})`).join(" ")} and p.prorettype=to_regtype(${literal(result)}) and p.prokind='f' and not p.prosecdef and has_function_privilege(current_user,p.oid,'EXECUTE') and not has_function_privilege('anon',p.oid,'EXECUTE') and not has_function_privilege('authenticated',p.oid,'EXECUTE'))`;
const all = (checks: string[]) => checks.map(check=>`(${check})`).join(" and ");
const index = (name: string, keys: string[], predicate: string) => `exists(select 1 from pg_index i where i.indexrelid=to_regclass('public.${name}') and i.indisunique and i.indisvalid and i.indnkeyatts=${keys.length} ${keys.map((key,offset)=>`and pg_get_indexdef(i.indexrelid,${offset+1},true)=${literal(key)}`).join(" ")} and lower(regexp_replace(pg_get_expr(i.indpred,i.indrelid),'[[:space:]()]','','g'))=${literal(predicate)})`;

const ruleChecks = [
  marker("alfred_account_rules_schema_20261102_v1",ACCOUNT_RULE_SCHEMA_TOKEN),
  fn("alfred_account_rules_schema_20261102_v1",[],"text"),
  ownedTable("account_rule_states"),ownedTable("account_rule_events"),
  columns("account_rule_states",{owner_id:"uuid",revision:"int8",state:"jsonb",updated_at:"timestamptz"}),
  columns("account_rule_events",{owner_id:"uuid",revision:"int8",request_id:"text",action_fingerprint:"text",before_state:"jsonb",after_state:"jsonb",created_at:"timestamptz"}),
  fn("alfred_account_rule_document_valid",["jsonb","uuid"],"bool"),
  fn("alfred_write_account_rules",["uuid","int8","text","text","jsonb"],"jsonb"),
  fn("alfred_accounting_source_version",["uuid"],"text"),
];
export const ACCOUNT_RULES_READY_SQL = `select to_regclass('public.account_rule_states') is not null and ${all(ruleChecks)} as ready`;

const portabilityChecks = [
  ...ruleChecks,
  marker("alfred_portability_schema_20261102_v1",PORTABILITY_SCHEMA_TOKEN),
  fn("alfred_portability_schema_20261102_v1",[],"text"),
  ...["finance_import_previews","finance_import_receipts","imported_finance_sources","finance_import_native_origins"].map(ownedTable),
  columns("finance_import_previews",{owner_id:"uuid",id:"text",archive_id:"text",activation_of:"text",activation_key:"text",source_version:"text",native_version:"text",native_plan:"jsonb",expected_revision:"int8",base_hash:"text",before_state:"jsonb",next_state:"jsonb",sources:"jsonb",archive:"jsonb",summary:"jsonb",expires_at:"timestamptz",created_at:"timestamptz"}),
  columns("finance_import_receipts",{owner_id:"uuid",id:"text",archive_id:"text",activation_of:"text",activation_key:"text",archive:"jsonb",summary:"jsonb",before_state:"jsonb",after_state:"jsonb",source_version_after:"text",native_plan:"jsonb",native_before:"jsonb",native_inserted:"jsonb",native_after_version:"text",imported_at:"timestamptz",undone_at:"timestamptz",notifications_resumed_at:"timestamptz"}),
  columns("imported_finance_sources",{owner_id:"uuid",movement_id:"text",receipt_id:"text",movement:"jsonb"}),
  columns("finance_import_native_origins",{owner_id:"uuid",table_name:"text",record_key:"text",namespace:"text",source_key:"text",receipt_id:"text"}),
  columns("investments",{import_notifications_paused:"bool",import_cost_basis_unknown:"bool"}),
  fn("alfred_confirm_finance_import",["uuid","text"],"jsonb"),
  fn("alfred_undo_finance_import",["uuid","text"],"jsonb"),
  fn("alfred_resume_import_investment_notifications",["uuid","text"],"jsonb"),
  fn("alfred_portability_native_version",["uuid"],"text"),
  fn("alfred_portability_lock_native",["uuid"],"void"),
  fn("alfred_apply_import_native",["uuid","jsonb","text"],"jsonb"),
  fn("alfred_undo_import_native",["uuid","public.finance_import_receipts"],"bool"),
  fn("alfred_finance_import_receipt",["public.finance_import_receipts"],"jsonb"),
  fn("alfred_bound_finance_import_previews",[],"trigger"),
  index("finance_import_receipts_active_archive",["owner_id","archive_id"],"undone_atisnullandactivation_ofisnull"),
  index("finance_import_receipts_active_activation",["owner_id","activation_key"],"undone_atisnullandactivation_keyisnotnull"),
  `exists(select 1 from pg_trigger t where t.tgrelid=to_regclass('public.finance_import_previews') and t.tgname='finance_import_previews_bound_before_insert' and not t.tgisinternal and t.tgenabled in ('O','A') and t.tgfoid=to_regprocedure('public.alfred_bound_finance_import_previews()') and (t.tgtype::int & 7)=7)`,
];
export const PORTABILITY_READY_SQL = `select to_regclass('public.finance_import_previews') is not null and ${all(portabilityChecks)} as ready`;

// Readiness only changes when a migration is applied, so a positive result is reused briefly
// instead of re-running these catalog checks on every dashboard and chat load. A negative
// result is never cached, so a newly applied migration is picked up on the next request.
const READY_TTL_MS = 5 * 60 * 1000;
const readyUntil = new Map<string, number>();
export async function schemaReady(settings: SupabaseSettings, sql: string, now = Date.now()): Promise<boolean> {
  const key = `${settings.host}:${settings.projectRef}:${sql}`;
  if ((readyUntil.get(key) ?? 0) > now) return true;
  // Loaded on use so this catalog module stays free of a database client at import time.
  const { query } = await import("@/lib/supabase/connection");
  const rows = await query<{ ready: boolean }>(settings, sql);
  const ready = rows[0]?.ready === true;
  if (ready) readyUntil.set(key, now + READY_TTL_MS); else readyUntil.delete(key);
  return ready;
}
export function resetSchemaReadyCache() { readyUntil.clear(); }
