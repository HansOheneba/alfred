import { readdir, readFile } from "node:fs/promises";
import { loadEnvFile } from "node:process";
import path from "node:path";

import { getStudioSettings } from "@/lib/env";
import { query } from "@/lib/supabase/connection";

try {
  loadEnvFile();
} catch {
  // .env is loaded when the file exists.
}

async function main(): Promise<void> {
  const settings = getStudioSettings().supabase;
  const directory = path.join(process.cwd(), "supabase", "migrations");
  const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  await query(
    settings,
    `create table if not exists public.alfred_schema_migrations (
      filename text primary key,
      applied_at timestamptz not null default now()
    )`,
  );
  const applied = new Set(
    (await query<{ filename: string }>(settings, "select filename from public.alfred_schema_migrations")).map(
      (row) => row.filename,
    ),
  );
  for (const filename of files) {
    if (applied.has(filename)) continue;
    const sql = await readFile(path.join(directory, filename), "utf8");
    await query(settings, sql);
    await query(settings, "insert into public.alfred_schema_migrations (filename) values ($1)", [filename]);
    console.log(`applied ${filename}`);
  }
  console.log(`ledger ready on ${settings.projectRef}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Migration failed.";
  console.error(message);
  process.exitCode = 1;
});
