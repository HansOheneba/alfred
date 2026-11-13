for (const key of [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "ANTHROPIC_API_KEY",
  "ALFRED_MODEL",
  "ALFRED_STRONG_MODEL",
  "GOOGLE_SERVICE_ACCOUNT_EMAIL",
  "GOOGLE_PRIVATE_KEY",
  "GOOGLE_SHEETS_SPREADSHEET_ID",
  "AUTHORIZED_TELEGRAM_USER_IDS",
  "VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
  "VAPID_SUBJECT",
  "ALFRED_PUSH_DELIVERY_ENABLED",
  "ALFRED_NOTIFICATION_SCHEDULES_ENABLED",
  "ALFRED_NOTIFICATION_CRON_SECRET",
  "ALFRED_NOTIFICATION_RECOVERY_SCHEDULE_ID",
  "ALFRED_NOTIFICATION_RECOVERY_INTERVAL_SECONDS",
]) {
  delete process.env[key];
}

// Schema readiness is cached per process; each test controls its own database mock.
import { beforeEach } from "vitest";
import { resetSchemaReadyCache } from "@/lib/supabase/finance-capabilities";
import { resetAccountingDisplayCache } from "@/lib/finance/accounting/display-cache";
beforeEach(() => { resetSchemaReadyCache(); resetAccountingDisplayCache(); });
