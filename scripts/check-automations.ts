import { getDatabaseSettings } from "@/lib/env";
import { formatOperatorReadiness, operatorChecksPass, operatorDatabase, operatorEnvironment } from "@/lib/notifications/operator-readiness";

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  if (arguments_.some((argument) => argument !== "--database") || arguments_.length > 1) {
    console.error("Usage: npm run automations:check -- [--database]");
    process.exitCode = 2;
    return;
  }
  // Use the operator's already-loaded environment. Never load or create a
  // credential file, obtain credentials, provision services or send a push.
  const report = operatorEnvironment();
  if (arguments_.includes("--database")) {
    try { Object.assign(report, await operatorDatabase(getDatabaseSettings())); }
    catch { report.database = "unavailable"; }
  }
  for (const line of formatOperatorReadiness(report)) console.log(line);
  process.exitCode = operatorChecksPass(report) ? 0 : 1;
}

void main().catch(() => {
  console.error("Automation checks could not complete. No configuration values are displayed.");
  process.exitCode = 1;
});
