for (const key of [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_MODEL",
  "GOOGLE_SERVICE_ACCOUNT_EMAIL",
  "GOOGLE_PRIVATE_KEY",
  "GOOGLE_SHEETS_SPREADSHEET_ID",
  "AUTHORIZED_TELEGRAM_USER_IDS",
]) {
  delete process.env[key];
}

// Schema readiness is cached per process; each test controls its own database mock.
import { beforeEach } from "vitest";
import { resetSchemaReadyCache } from "@/lib/supabase/finance-capabilities";
beforeEach(() => resetSchemaReadyCache());
