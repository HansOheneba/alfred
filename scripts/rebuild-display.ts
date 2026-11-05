import { getDatabaseSettings } from "@/lib/env";
import { displayWorkerEnabled, runDisplayWorker } from "@/lib/finance/accounting/display-worker";
import { setTimeout as pause } from "node:timers/promises";

const args = process.argv.slice(2);
async function main() {
  if (args.length === 0 || args.includes("--help")) {
    console.log("Usage: node --import tsx scripts/rebuild-display.ts --run [--max-owners=1..10] [--continuous]\nRequires ALFRED_DURABLE_WORKER_ENABLED=true and database environment variables. Continuous mode polls every five seconds and must run under a process supervisor. This script does not load .env files. Processes display rebuilds only; never applies migrations or financial actions.");
    return;
  }
  if (!args.includes("--run") || args.some(arg => arg !== "--run" && arg !== "--continuous" && !/^--max-owners=(?:[1-9]|10)$/.test(arg))) throw new Error("Use --help for supported display worker options.");
  if (!displayWorkerEnabled()) throw new Error("The durable display worker is disabled.");
  const maxOwners = Number(args.find(arg => arg.startsWith("--max-owners="))?.split("=")[1] ?? 1);
  const continuous = args.includes("--continuous"), settings = getDatabaseSettings();
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  try {
    do {
      try { console.log(JSON.stringify(await runDisplayWorker(settings, { maxOwners }))); }
      catch (error) {
        if (!continuous) throw error;
        console.error("Display worker cycle unavailable; durable leases and pending events are retained.");
      }
      if (continuous && !stopping) await pause(5_000);
    } while (continuous && !stopping);
  } finally { process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop); }
}
main().catch(() => { console.error("Display rebuild failed. Check worker status and configuration; no financial action was run."); process.exitCode = 1; });
