import { createHash } from "node:crypto";

import type { SupabaseSettings } from "@/lib/config";
import { query } from "@/lib/supabase/connection";

export type ExportCoverage = {
  dataset: string;
  status: "supported" | "preserved" | "excluded" | "unavailable";
  reason: string;
  count?: number;
};

type NativeRow = Record<string, unknown>;
export type AlfredNativeExport = {
  schema: 1;
  identityFieldsExcluded?: readonly string[];
  tables: Record<string, NativeRow[]>;
  settings: {
    profile: {
      preferred_name: string;
      currency: string;
      timezone: string;
      communication_preference: string;
      financial_goals: string;
      account_names: string;
      created_at: string;
      updated_at: string;
    } | null;
    reminderPreferences: NativeRow | null;
  };
  /** The original validated archives are evidence, never ownership or connection configuration. */
  retainedArchives: { archiveId: string; archive: Record<string, unknown> }[];
};

// Every column is named deliberately. Adding a secret-bearing column to a table
// cannot silently add it to an export. Numeric amounts are text to avoid a float
// round trip. No LIMIT is used: an oversized export fails the archive size check
// instead of pretending a truncated export is complete.
const TABLES = {
  transactions: {
    table: "transactions",
    columns: "id::text, transaction_id, created_at, transaction_date::text, type, amount::text, currency, category, description, payment_method, notes, status, updated_at, source_update_id",
    order: "transaction_date, transaction_id",
  },
  bankMessages: {
    table: "bank_messages",
    columns: "id, source, channel, external_id, text_hash, direction, kind, amount::text, fee::text, currency, counterparty, balance::text, occurred_at, status, transaction_id, fee_transaction_id, asked_at, raw, created_at, announced_at, read_by",
    order: "occurred_at, id",
  },
  bankPaymentResolutions: {
    table: "bank_payment_resolutions",
    columns: "id, bank_message_id, kind, reason, request_id, source_fingerprint, resolved_source_fingerprint, bank_evidence_fingerprint, live_facts_fingerprint, source_snapshot, original_movement_id, original_source_fingerprint, principal_minor::text, settlement_id, accounting_revision::text, created_at, reopened_at",
    order: "created_at, id",
  },
  accountRuleStates: { table:"account_rule_states",columns:"revision,state,updated_at",order:"owner_id" },
  accountRuleEvents: { table:"account_rule_events",columns:"revision,request_id,action_fingerprint,before_state,after_state,created_at",order:"revision" },
  accountingStates: { table: "accounting_states", columns: "revision, state, updated_at", order: "owner_id" },
  accountingEvents: {
    table: "accounting_events",
    columns: "revision, request_id, action_fingerprint, action, before_state, after_state, created_at",
    order: "revision",
  },
  budgets: { table: "budgets", columns: "budget_id, period, category, amount::text, currency, created_at, updated_at", order: "budget_id" },
  savingsGoals: {
    table: "savings_goals",
    columns: "goal_id, name, target_amount::text, current_amount::text, currency, target_date, status, created_at, updated_at",
    order: "goal_id",
  },
  loans: { table: "loans", columns: "id, person, person_key, kind, amount::text, currency, occurred_at, note, bank_message_id, created_at", order: "occurred_at, id" },
  labelUndo: { table: "label_undo", columns: "changes, created_at", order: "created_at" },
  people: { table: "people", columns: "person_key, name, note, updated_at", order: "person_key" },
  payeeRules: { table: "payee_rules", columns: "payee_key, category, description, kind, updated_at", order: "payee_key" },
  aboutMe: { table: "about_me", columns: "id, note, account, created_at", order: "created_at, id" },
  bills: { table: "bills", columns: "id, name, next_date::text, amount::text, currency, cadence, active, reminded_for::text, created_at, updated_at", order: "next_date, id" },
  investments: {
    table: "investments",
    columns: "id, name, kind, provider, currency, invested_before::text, principal::text, rate::text, started_on::text, matures_on::text, reminded_at, payee_key, status, import_notifications_paused, import_cost_basis_unknown, created_at, updated_at",
    order: "created_at, id",
  },
  investmentHoldings: { table: "investment_holdings", columns: "id, investment_id, symbol, quantity::text, cost::text, updated_at", order: "investment_id, symbol" },
  investmentValues: { table: "investment_values", columns: "id, investment_id, value::text, as_of, source, created_at", order: "investment_id, as_of, id" },
  investmentContributions: { table: "investment_contributions", columns: "id, investment_id, amount::text, currency, occurred_on::text, bank_message_id, note, created_at", order: "investment_id, occurred_on, id" },
  messages: { table: "messages", columns: "id, channel, role, body, created_at, client_id, intent, meta", order: "created_at, id" },
  importedSources: { table: "imported_finance_sources", columns: "movement_id, receipt_id, movement", order: "movement_id" },
  importReceipts: {
    table: "finance_import_receipts",
    columns: "id, archive_id, summary, before_state, after_state, imported_at, undone_at, source_version_after, notifications_resumed_at",
    order: "imported_at, id",
  },
} as const;

const REQUIRED_TABLES = [...new Set([
  "profiles", "reminder_preferences", "finance_import_native_origins", ...Object.values(TABLES).map((entry) => entry.table),
])];

const NATIVE_PROVENANCE_KEYS: Record<string, string> = {
  budgets: "budget_id", savings_goals: "goal_id", bills: "id", investments: "id", investment_holdings: "id", investment_values: "id", investment_contributions: "id",
  loans: "id", people: "person_key", payee_rules: "payee_key", about_me: "id", messages: "id",
};

function rowsSql(table: string, columns: string, order: string): string {
  // These names come exclusively from the static table definition above.
  const key = NATIVE_PROVENANCE_KEYS[table];
  const provenance = key ? ` || coalesce((select jsonb_build_object('importProvenance',jsonb_build_object('namespace',origin.namespace,'sourceId',origin.source_key))
      from public.finance_import_native_origins origin where origin.owner_id = $1::uuid and origin.table_name = '${table}' and origin.record_key = export_row.${key}::text), '{}'::jsonb)` : "";
  return `(select coalesce(jsonb_agg(to_jsonb(export_row)${provenance}), '[]'::jsonb) from
    (select ${columns} from public.${table} where owner_id = $1::uuid order by ${order}) export_row)`;
}

export const ALFRED_EXPORT_SNAPSHOT_SQL = `select jsonb_build_object(
  'schema', 1,
  'tables', jsonb_build_object(
    ${Object.entries(TABLES).map(([name, entry]) => `'${name}', ${rowsSql(entry.table, entry.columns, entry.order)}`).join(",\n    ")}
  ),
  'settings', jsonb_build_object(
    'profile', (select to_jsonb(export_profile) from
      (select preferred_name, currency, timezone, communication_preference, financial_goals, account_names, created_at, updated_at
       from public.profiles where id = $1::uuid) export_profile),
    'reminderPreferences', (select to_jsonb(export_reminders) from
      (select morning_enabled, commute_enabled, evening_enabled, morning_minute, commute_minute, evening_minute, updated_at
       from public.reminder_preferences where owner_id = $1::uuid) export_reminders)
  ),
  'retainedArchives', (select coalesce(jsonb_agg(jsonb_build_object('archiveId',archive_id,'archive',archive) order by archive_id),'[]'::jsonb)
    from public.finance_import_receipts where owner_id = $1::uuid)
) as native`;

const EXCLUSIONS: ExportCoverage[] = [
  { dataset: "authentication-and-connections", status: "excluded", reason: "Passwords, tokens, OTPs, sessions, SMS forwarding credentials, Telegram account bindings, push subscription endpoints/keys and machine-specific connection settings are never exported." },
  { dataset: "pending-actions-and-delivery-state", status: "excluded", reason: "Unconfirmed executable actions, ingestion claims, rate limits and notification delivery markers are operational state. Importing history never configures future SMS collection or sends pending actions." },
  { dataset: "market-price-cache", status: "excluded", reason: "Shared market prices and exchange-rate caches are not user-owned records; all personal holdings and reported values are included." },
  { dataset: "assistant-deployment-guidance", status: "excluded", reason: "Deployment-admin tone guidance is not an owner-editable finance record. User communication preferences, notebook notes and financial goals are included." },
  { dataset: "legacy-unowned-ledger-rows", status: "excluded", reason: "Only rows scoped to this authenticated profile are exported. Legacy rows without an owner are not attributed using an archive ID or a Telegram ID." },
  { dataset: "source-account-identity", status: "excluded", reason: "Source ownerId, userId, owner_id and user_id fields are removed recursively, including historical accounting audits and previously imported evidence. Destination ownership always comes from its signed-in session." },
];

const OWNER_KEYS = ["ownerId", "userId", "owner_id", "user_id"] as const;
const EXCLUDED_NESTED_KEYS = new Set(["ownerid", "userid", "password", "passphrase", "secret", "apikey", "accesstoken", "refreshtoken", "ingesttoken", "bottoken", "webhooksecret", "privatekey", "authorization", "cookie", "cookies", "session", "sessionid", "sessions", "otp", "otpcode", "pushsubscription", "pushsubscriptions", "pushendpoint", "p256dh", "auth", "authkey", "machinepath", "localpath", "filepath", "cwd", "homedir", "token"]);
const excludedKey = (key: string) => EXCLUDED_NESTED_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/g, ""));

/** Scrub identity links in nested native/audit evidence without altering finance values or source IDs. */
export function scrubNativeOwnership<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => scrubNativeOwnership(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !excludedKey(key)).map(([key, item]) => [key, scrubNativeOwnership(item)])) as T;
  }
  return value;
}

function exportNativeSnapshot(raw: AlfredNativeExport): AlfredNativeExport {
  const native = scrubNativeOwnership(raw);
  native.identityFieldsExcluded = OWNER_KEYS;
  native.retainedArchives = native.retainedArchives.map((entry) => ({
    archiveId: entry.archiveId,
    // Identity scrubbing may change previously imported dataset checksums. Keep
    // the original manifest as source provenance, not a purported valid nested
    // ZIP. Fresh checksums in this export cover the redacted evidence exactly.
    archive: {
      sourceManifest: entry.archive.manifest ?? entry.archive.sourceManifest ?? null,
      datasets: entry.archive.datasets ?? {},
      ownershipRedacted: true,
    },
  }));
  return native;
}

const RESTORED_NATIVE: Record<string, string> = {
  accountRuleStates:"Rules and explicit bindings append into the shared account-rule store with imported account IDs remapped. Source aggregate revision and audit history remain evidence; manual overrides and non-matching movements are not rewritten.",
  budgets: "Native budgets are restored with stable source identity; existing budget conflicts are previewed and never silently overwritten.",
  savingsGoals: "Native savings goals, including completed and deleted history, are restored with stable source identity.",
  bills: "Native bills are restored with reminders paused. Original active and delivery fields remain in the native evidence.",
  investments: "Native investment records are restored with import notifications paused; the original maturity/reminder settings remain in the evidence.",
  investmentHoldings: "Native holdings are restored with exact quantity/cost strings and links to imported investments.",
  investmentValues: "All native reported investment values are restored with their investment references and source history.",
  investmentContributions: "Native contributions are restored with their investment references. Original bank-message links are retained as raw evidence rather than bound to destination ingestion records.",
  loans: "Native lent, repaid, borrowed and paid-back loan records are restored with stable IDs. Original bank-message links remain in the archive and are not bound to destination ingestion records.",
  people: "Native person notes are restored without replacing conflicting destination notes.",
  payeeRules: "Native payee rules are restored without replacing conflicting destination rules.",
  aboutMe: "General notebook notes are restored. Account-exclusion notes remain raw evidence and do not silently alter future destination SMS classification.",
  messages: "Native conversation history is restored as historical records; importing it does not replay actions or send messages.",
};

const PRESERVED_NATIVE: Record<string, string> = {
  bankPaymentResolutions: "Explicit no-money-moved reasons and returned-principal links, including immutable source evidence and audit fingerprints, remain lossless native evidence. The shared accounting core restores the resulting excluded movements and valid refund links; historical bank-message IDs and executable resolution actions are never replayed into destination ingestion records.",
};

function nativeCoverage(native: AlfredNativeExport): ExportCoverage[] {
  const coverage: ExportCoverage[] = Object.entries(native.tables).map(([dataset, records]) => ({
    dataset: `alfred.native.${dataset}`,
    status: RESTORED_NATIVE[dataset] ? "supported" : "preserved",
    count: dataset === "aboutMe" ? records.filter((row) => row.account === null).length : records.length,
    reason: RESTORED_NATIVE[dataset] ?? PRESERVED_NATIVE[dataset] ?? "Complete owner-scoped native source/audit records are retained as evidence. The accounting adapter populates supported finance records; raw ingestion and historical mutation state are not replayed.",
  }));
  coverage.push({
    dataset: "alfred.native.aboutMe.accountExclusions", status: "preserved",
    count: (native.tables.aboutMe ?? []).filter((row) => row.account !== null).length,
    reason: "Notebook records that exclude another person's bank account remain in native evidence; import does not change destination SMS collection or account exclusion settings.",
  });
  return coverage;
}

/**
 * Read-only native snapshot. It does not ensure/create accounts, migrate tables,
 * send notifications, read an LLM, or reconfigure data collection. The single
 * data query gets one PostgreSQL statement snapshot across every finance table.
 */
export async function buildAlfredExport(settings: SupabaseSettings, ownerId: string) {
  const availability = await query<{ table_name: string; ready: boolean }>(settings,
    "select table_name, to_regclass('public.' || table_name) is not null as ready from unnest($1::text[]) as requested(table_name)",
    [REQUIRED_TABLES],
  );
  const ready = new Set(availability.filter((row) => row.ready).map((row) => row.table_name));
  const missing = REQUIRED_TABLES.filter((name) => !ready.has(name));
  if (missing.length) throw new Error(`Data export requires the reviewed finance and portability migrations. Missing tables: ${missing.join(", ")}.`);
  const rows = await query<{ native: AlfredNativeExport }>(settings, ALFRED_EXPORT_SNAPSHOT_SQL, [ownerId]);
  const raw = rows[0]?.native;
  if (!raw?.settings.profile) throw new Error("This signed-in profile has no exportable finance settings.");
  const native = exportNativeSnapshot(raw);
  const coverage = nativeCoverage(native);
  coverage.push(
    { dataset: "structured-secrets-and-machine-paths", status: "excluded", reason: "Credential, session, push-subscription and machine-path fields in nested JSON evidence are removed by field name. User-authored free text is retained as finance evidence." },
    { dataset: "alfred.native.settings", status: "supported", count: 1, reason: "Safe profile fields are restored only into empty/default destination fields; conflicting settings are previewed. Reminder enable/delivery state and account-name classification are preserved as evidence and do not configure destination collection or notifications." },
    { dataset: "alfred.native.settings.reminderPreferences", status: "preserved", count: native.settings.reminderPreferences ? 1 : 0, reason: "Original reminder preferences remain in native evidence. Import does not enable reminders or replay notification deliveries." },
    { dataset: "alfred.native.settings.account_names", status: "preserved", count: native.settings.profile?.account_names ? 1 : 0, reason: "Source account-name classification is retained as evidence; import does not change which future destination SMS messages are classified as own-account transfers." },
    { dataset: "alfred.native.retainedArchives", status: "preserved", count: native.retainedArchives.length, reason: "Original validated imported archives are retained, including unsupported records and import provenance. Nested evidence counts toward archive limits." },
    ...EXCLUSIONS,
  );
  return {
    datasets: { "alfred.native": native },
    coverage,
    timezone: native.settings.profile!.timezone,
    currency: native.settings.profile!.currency,
    namespace: `alfred:${createHash("sha256").update(`alfred:${ownerId}`).digest("hex")}`,
  };
}
