import { createECDH } from "node:crypto";
import type { SupabaseSettings } from "@/lib/config";
import { query } from "@/lib/supabase/connection";
import { decodeBase64url, pushConfiguration, type PushEnvironment } from "./push";
import { loadRecoveryStatus, recoveryConfiguration, type RecoveryStatus } from "./recovery";
import type { Execute } from "./store";

export type OperatorReadiness = {
  signingKeys: boolean;
  deliveryEnabled: boolean;
  recoveryConfigured: boolean;
  database: "not-checked" | "available" | "incomplete" | "unavailable";
  recovery: "not-checked" | RecoveryStatus["reason"];
};

/** Returns booleans only. Private keys and configuration fingerprints stay local. */
export function operatorEnvironment(env: PushEnvironment = process.env): OperatorReadiness {
  const configuration = pushConfiguration(env);
  let signingKeys = false;
  if (configuration.ready && configuration.config) {
    try {
      const pair = createECDH("prime256v1");
      pair.setPrivateKey(decodeBase64url(configuration.config.privateKey));
      signingKeys = pair.getPublicKey().equals(Buffer.from(decodeBase64url(configuration.config.publicKey)));
    } catch { /* Invalid points/scalars are configuration failures, never output. */ }
  }
  return {
    signingKeys,
    deliveryEnabled: env.ALFRED_PUSH_DELIVERY_ENABLED === "true",
    recoveryConfigured: recoveryConfiguration(env).configured,
    database: "not-checked",
    recovery: "not-checked",
  };
}

const requiredTables = ["notification_preferences", "push_subscriptions", "notification_deliveries", "bank_notice_receipts", "collector_event_receipts", "notification_recovery_health", "collector_health"];
const requiredFunctions = [
  "public.alfred_notifications_schema_20261103_v1()",
  "public.alfred_record_bank_notice(uuid,uuid,text,text,boolean,text,uuid,boolean,jsonb)",
  "public.alfred_claim_collector_event(uuid,text,text)",
  "public.alfred_complete_collector_event(uuid,text,text,uuid,uuid[])",
  "public.alfred_release_collector_event(uuid,text,text,uuid)",
  "public.alfred_record_collector_health(uuid,uuid,text,integer,integer,integer,integer,integer,timestamp with time zone,timestamp with time zone)",
  "public.alfred_forget_collector_health(uuid,uuid)",
  "public.alfred_record_bank_activity_notice(uuid,uuid,text,text,boolean,text,uuid,boolean,jsonb,jsonb)",
  "public.alfred_bank_notice_readiness(uuid,uuid,timestamp with time zone)",
];

/** Explicit operator-only check: catalog metadata and one operational heartbeat;
 * no financial rows, subscription payloads, dispatcher calls or database writes. */
export async function operatorDatabase(
  settings: SupabaseSettings,
  options: { env?: PushEnvironment; now?: Date; execute?: Execute } = {},
): Promise<Pick<OperatorReadiness, "database" | "recovery">> {
  const execute = options.execute ?? query;
  try {
    const rows = await execute<{ complete: boolean }>(settings, `select
      to_regclass('public.alfred_schema_migrations') is not null
      and not exists (
        select 1 from unnest($1::text[]) expected(name)
        left join pg_namespace n on n.nspname='public'
        left join pg_class c on c.relnamespace=n.oid and c.relname=expected.name
        where c.oid is null or not c.relrowsecurity
      ) and not exists (
        select 1 from unnest($2::text[]) expected(signature)
        where to_regprocedure(expected.signature) is null
      ) as complete`, [requiredTables, requiredFunctions]);
    if (rows[0]?.complete !== true) return { database: "incomplete", recovery: "not-checked" };
    const recovery = await loadRecoveryStatus(settings, { ...options, execute });
    return { database: "available", recovery: recovery.reason };
  } catch {
    return { database: "unavailable", recovery: "not-checked" };
  }
}

export function formatOperatorReadiness(report: OperatorReadiness): string[] {
  const recovery = {
    "not-checked": "not checked",
    "not-configured": "not configured",
    "schema-unavailable": "could not be read (database/schema/access check needed)",
    "never-completed": "no completed check-in",
    "configuration-changed": "check-in belongs to a previous configuration",
    failed: "latest processing failed",
    stale: "last check-in is too old",
    ready: "recent completed check-in observed",
  }[report.recovery];
  return [
    "Alfred automations — read-only server checks",
    `Push signing keys: ${report.signingKeys ? "valid matching pair" : "needs configuration"}`,
    `Push delivery: ${report.deliveryEnabled ? "enabled" : "off"}`,
    `Recovery configuration: ${report.recoveryConfigured ? "configured" : "needs configuration"}`,
    `Database schema: ${report.database === "not-checked" ? "not checked (use --database with an authorized connection)" : report.database}`,
    `Scheduled processing: ${recovery}`,
    "Scheduler registration and device display are not proved by these checks.",
    "No keys, preferences, subscriptions, schedules or financial records were changed.",
  ];
}

export function operatorChecksPass(report: OperatorReadiness): boolean {
  return report.signingKeys && report.deliveryEnabled && report.recoveryConfigured &&
    (report.database === "not-checked" || (report.database === "available" && report.recovery === "ready"));
}
