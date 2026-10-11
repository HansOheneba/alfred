import { loadEnvFile } from "node:process";

import { getSettings } from "@/lib/env";
import { createSheetsFinanceStore } from "@/lib/google/finance-store";

try {
  loadEnvFile();
} catch {
  // Next.js loads env files for the app. Scripts load .env when it exists.
}

async function main(): Promise<void> {
  const settings = getSettings();
  if (!settings.google) {
    throw new Error("Google Sheets is not configured. Set the service account and spreadsheet variables.");
  }
  const store = createSheetsFinanceStore(settings.google);
  await store.ensureReady();
  console.log("Spreadsheet worksheets and headers are ready. Existing rows were not overwritten.");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Sheet setup failed.";
  console.error(message);
  process.exitCode = 1;
});
