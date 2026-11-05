import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { applyAccountRules } from "@/lib/account-rules/matcher";
import { emptyAccountRuleState } from "@/lib/account-rules/types";
import { validateAccountData, accountBalances } from "@/lib/finance/accounting/accounts";
import { browserAccountingState } from "@/lib/finance/accounting/browser-state";
import { hydrateAccountingSources, sourceMovements } from "@/lib/finance/accounting/sources";
import { accountingReportRows, buildAccountingView, projectAccountingTransactions } from "@/lib/finance/accounting/view";
import { withLedgerReceipts } from "@/lib/finance/accounting/receipts";
import { accountingCpuFixture, CPU_OWNER } from "./accounting-cpu-fixture";
import { populatedPerformanceFixture } from "./populated-performance-fixture";

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
function measure(task: () => unknown, iterations = 11) {
  for (let warm = 0; warm < 3; warm++) task();
  const samplesMs = Array.from({ length: iterations }, () => { const at = performance.now(); task(); return performance.now() - at; }).sort((a, b) => a - b);
  return { iterations, medianMs: Number(samplesMs[Math.floor(iterations / 2)].toFixed(3)), minMs: Number(samplesMs[0].toFixed(3)), maxMs: Number(samplesMs.at(-1)!.toFixed(3)) };
}

it("measures actual accounting phases on declared fictional populated fixtures", async () => {
  const reports = [];
  for (const [scenario, fixture] of [["source-heavy", accountingCpuFixture()], ["imported-majority", populatedPerformanceFixture()]] as const) {
    const { state, raw, messages, fresh } = fixture;
    validateAccountData(state);
    const rules = emptyAccountRuleState(CPU_OWNER);
    const rows = accountingReportRows(state);
    const browser = browserAccountingState(state);
    const sourceTextBytes = state.movements.reduce((total, row) => total + Buffer.byteLength(row.sourceText ?? ""), 0);
    const tasks = {
      sourceMovements: () => sourceMovements(CPU_OWNER, raw, messages),
      applyRules: () => applyAccountRules(state, rules),
      hydrate: () => hydrateAccountingSources(state, fresh),
      validate: () => validateAccountData(state),
      accountBalances: () => accountBalances(state, "GHS"),
      buildView: () => buildAccountingView(state, "GHS"),
      project: () => projectAccountingTransactions(raw, state),
      receipts: () => withLedgerReceipts(rows, state, CPU_OWNER),
      browserProjection: () => browserAccountingState(state),
      browserJsonStringify: () => JSON.stringify(browser),
    };
    expect(state.movements).toHaveLength(2315); expect(state.snapshots).toHaveLength(2277);
    reports.push({ scenario, counts: { movements: state.movements.length, snapshots: state.snapshots.length, accounts: state.accounts.length, transferLinks: state.transfers.length, auditBeforeCopies: state.audit.length, rawTransactions: raw.length, bankMessages: messages.length, imported: "imported" in fixture ? fixture.imported.length : 0, rules: 0 },
      compactJsonBytes: { fullState: bytes(state), browserState: bytes(browser), snapshots: bytes(state.snapshots), sourceTextOnly: sourceTextBytes, browserWithoutSourceText: bytes({ ...browser, movements: browser.movements.map(movement => { const row = { ...movement }; delete row.sourceText; return row; }) }) },
      phases: Object.fromEntries(Object.entries(tasks).map(([name, task]) => [name, measure(task)])),
    });
  }
  if (process.env.ALFRED_POPULATED_CPU_OUTPUT) await writeFile(process.env.ALFRED_POPULATED_CPU_OUTPUT, JSON.stringify({
    description: "Actual pure accounting functions on fictional fixtures; warm local Node CPU, no database/network/browser. Not production CPU or measured HTTP/RSC bytes.",
    model: "Each phase has 3 warmups and 11 measured calls; phase times overlap (buildView includes balances/validation) and must not be summed. Sizes are compact JSON UTF-8, not PostgreSQL jsonb text nor compressed wire bytes. Imported-majority has exactly 4 audit before copies and 4 repeated synthetic source-text clauses per imported movement, chosen independently of production bytes.",
    results: reports,
  }, null, 2) + "\n");
}, 20_000);
