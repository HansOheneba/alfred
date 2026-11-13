import { writeFile } from "node:fs/promises";
import { loadEnvFile } from "node:process";

import { interpretMessage } from "@/lib/ai/model";
import { createVoice } from "@/lib/ai/voice";
import { getStudioSettings } from "@/lib/env";
import { loadCases } from "@/lib/evals/cases";
import { runCase, summarize, type CaseResult } from "@/lib/evals/run";

/**
 * Plays every case in evals/cases through Alfred with the real model, on
 * in-memory books, and checks what was saved. Run: npm run evals
 *   EVAL_ONLY=george   only cases whose id contains this
 *   EVAL_RUNS=3        play each case this many times (the model varies)
 *   EVAL_MIN_PASS=0.8  fail below this pass rate
 */

try {
  loadEnvFile();
} catch {
  // CI passes the key as an environment variable instead.
}

const RUNS = Math.max(1, Number(process.env.EVAL_RUNS ?? 1));
const MIN_PASS = Number(process.env.EVAL_MIN_PASS ?? 0.8);
const CONCURRENCY = 4;

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    console.log("ANTHROPIC_API_KEY is not set, so the evals were skipped.");
    return;
  }
  // Evals run on in-memory books. A fake database password means no code path can reach the real database.
  const settings = { ...getStudioSettings(), supabase: { ...getStudioSettings().supabase, password: "synthetic-only" } };
  const only = process.env.EVAL_ONLY?.trim();
  const cases = (await loadCases()).filter((item) => !only || item.id.includes(only));
  const queue = cases.flatMap((item) => Array.from({ length: RUNS }, () => item));
  const results: CaseResult[] = [];
  const brain = { interpret: (request: Parameters<typeof interpretMessage>[1]) => interpretMessage(settings.ai, request), voice: createVoice(settings.ai) };
  const label = `${settings.ai.model} (${settings.ai.strongModel} for payment turns)`;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const result = await runCase(next, settings, brain);
      results.push(result);
      console.log(`${result.passed ? "pass" : "FAIL"}  ${result.id}  (${result.seconds.toFixed(1)}s)`);
      if (!result.passed) {
        for (const step of result.steps) console.log(`        you: ${step.said}\n        alfred: ${step.reply.replace(/\s+/g, " ").slice(0, 240)}${step.asksToConfirm ? " [Confirm/Cancel]" : ""}`);
        for (const problem of result.problems) console.log(`      ✗ ${problem}`);
      }
    }
  }));
  const summary = summarize(results);
  const seconds = results.map((item) => item.seconds).sort((left, right) => left - right);
  const median = seconds[Math.floor(seconds.length / 2)] ?? 0;
  console.log(`\n${summary.passed}/${summary.total} passed (${(summary.passRate * 100).toFixed(0)}%), model ${label}, median ${median.toFixed(1)}s per conversation`);
  for (const [tag, rate] of Object.entries(summary.byTag)) console.log(`  ${tag.padEnd(14)} ${(rate * 100).toFixed(0)}%`);
  await writeFile("eval-results.json", JSON.stringify({ at: new Date().toISOString(), model: label, runs: RUNS, summary, medianSeconds: median, results }, null, 2));
  if (summary.passRate < MIN_PASS) {
    console.log(`Below the ${(MIN_PASS * 100).toFixed(0)}% pass rate.`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
