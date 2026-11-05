import { performance } from "node:perf_hooks";
import type { BankMessage } from "../lib/bank/store";
import type { TransactionRecord } from "../lib/finance/types";
import { accountBalances } from "../lib/finance/accounting/accounts";
import { hydrateAccountingSources, sourceMovements } from "../lib/finance/accounting/sources";
import { accountingReportRows, buildAccountingView, projectAccountingTransactions } from "../lib/finance/accounting/view";
import { withLedgerReceipts } from "../lib/finance/accounting/receipts";
import { emptyAccountingState, type AccountingState } from "../lib/finance/accounting/types";

export const CPU_OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export function accountingCpuFixture(count = 2315, snapshotCount = 2277) {
  const raw: TransactionRecord[] = [], messages: BankMessage[] = [];
  for (let index = 0; index < count; index += 1) {
    const at = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
    raw.push({ transactionId: `fixture:${index}`, createdAt: at, transactionDate: at.slice(0, 10), userId: CPU_OWNER,
      type: index % 2 ? "income" : "expense", amount: "100.00", currency: "GHS", category: "Food", description: `Fictional payment ${index}`,
      paymentMethod: "Synthetic wallet", notes: "", status: "active", updatedAt: at, sourceUpdateId: `bank:fixture-bank:${index}`, rowNumber: index + 2 });
    messages.push({ id: `fixture-bank:${index}`, ownerId: CPU_OWNER, source: "momo", channel: "manual", externalId: null,
      direction: index % 2 ? "in" : "out", kind: "payment", amount: "100.00", fee: "0.00", currency: "GHS", counterparty: `Fictional merchant ${index}`,
      balance: String(10000 + index), occurredAt: at, status: "recorded", transactionId: `fixture:${index}`, feeTransactionId: null, askedAt: null,
      raw: `FICTIONAL ALERT ${index}. ${"Synthetic source evidence only. ".repeat(22)}`, readBy: "rules" });
  }
  const fresh = sourceMovements(CPU_OWNER, raw, messages);
  const state: AccountingState = { ...emptyAccountingState(CPU_OWNER), revision: 7,
    accounts: Array.from({ length: 8 }, (_, index) => ({ id: `account:${index}`, label: `Fictional account ${index}`, provider: "Synthetic provider", currency: "GHS", includeInCash: index < 7, createdAt: "2025-01-01T00:00:00.000Z" })),
    movements: fresh.map((row, index) => ({ ...row, accountId: `account:${index % 8}`, status: index < 400 ? "transfer" : row.status })),
  };
  state.transfers = Array.from({ length: Math.min(200, Math.floor(count / 2)) }, (_, index) => {
    const outgoing = state.movements[index * 2], incoming = state.movements[index * 2 + 1];
    return { id: `transfer:${index}`, outgoing: { movementId: outgoing.id, sourceFingerprint: outgoing.sourceFingerprint }, incoming: { movementId: incoming.id, sourceFingerprint: incoming.sourceFingerprint }, createdAt: "2026-01-05T00:00:00.000Z" };
  });
  state.snapshots = state.movements.slice(0, snapshotCount).map((row) => ({ id: `source-snapshot:${row.id}:${row.sourceFingerprint}:${row.accountId}`,
    accountId: row.accountId!, balanceMinor: row.reportedBalanceMinor!, occurredAt: row.occurredAt!, sourceId: row.sourceId, sourceMovementId: row.id, sourceFingerprint: row.sourceFingerprint }));
  return { state, fresh, raw, messages };
}

/** Seeded histories exercise changed/missing evidence, ties, links and cash uncertainty. */
export function accountingCpuVariant(seed: number) {
  const fixture = accountingCpuFixture(60, 50);
  let random = seed + 1;
  const next = (maximum: number) => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random % maximum; };
  for (const account of fixture.state.accounts) account.includeInCash = next(3) !== 0;
  for (const movement of fixture.state.movements) {
    movement.status = (["confirmed", "review", "hold", "transfer", "duplicate", "excluded"] as const)[next(6)];
    movement.sourceStatus = (["confirmed", "review", "transfer"] as const)[next(3)];
    movement.direction = (["in", "out", "internal"] as const)[next(3)];
    movement.feeMinor = next(150); movement.taxMinor = next(20);
    movement.confirmedFeeMinor = movement.feeMinor;
    movement.feeTransactionId = `fee:${movement.id}`;
    if (next(4) === 0) movement.accountId = null;
    if (next(5) === 0) movement.sourceFingerprint += ":changed";
    if (next(7) === 0) movement.sourceMissing = true;
    if (next(9) === 0) movement.legacyClassification = next(2) ? "refund" : "loan";
    if (next(8) === 0) movement.importProvenance = { namespace: "fictional", sourceId: movement.sourceId };
    if (next(8) === 0) movement.occurredAt = null;
  }
  for (const snapshot of fixture.state.snapshots) {
    if (next(3) === 0) { snapshot.sourceMovementId = null; snapshot.occurredAt = "2026-01-01T00:10:00.000Z"; }
    if (next(4) === 0) snapshot.sourceFingerprint += ":stale";
  }
  for (const transfer of fixture.state.transfers) {
    if (next(3) === 0) transfer.outgoing.sourceFingerprint += ":stale";
    if (next(2) === 0) transfer.automatic = { version: 1, pairedRevision: 1, outgoing: { movementStatus: "review", bankStatus: "needs_label", bankKind: "payment" }, incoming: { movementStatus: "confirmed", bankStatus: "transfer", bankKind: "transfer_own" } };
  }
  fixture.fresh = fixture.fresh.filter(() => next(5) !== 0);
  // Hydration historically accepts duplicate source rows before later validation.
  if (seed % 3 === 0 && fixture.fresh[0]) fixture.fresh.push({ ...fixture.fresh[0], sourceFingerprint: "duplicate-fresh-fingerprint", status: "review" });
  return fixture;
}

/** Real local CPU time on fictional data. No network, timers, database or user records. */
export function benchmarkAccountingCpu(iterations = 11) {
  const fixture = accountingCpuFixture();
  const rows = accountingReportRows(fixture.state);
  const tasks: Record<string, () => unknown> = {
    sourceMovements: () => sourceMovements(CPU_OWNER, fixture.raw, fixture.messages),
    hydrate: () => hydrateAccountingSources(fixture.state, fixture.fresh),
    accountBalances: () => accountBalances(fixture.state, "GHS"),
    buildView: () => buildAccountingView(fixture.state, "GHS"),
    project: () => projectAccountingTransactions(fixture.raw, fixture.state),
    receipts: () => withLedgerReceipts(rows, fixture.state, CPU_OWNER),
  };
  const medians: Record<string, number> = {};
  for (const [name, task] of Object.entries(tasks)) {
    for (let warm = 0; warm < 3; warm += 1) task();
    const samples: number[] = [];
    for (let run = 0; run < iterations; run += 1) { const started = performance.now(); task(); samples.push(performance.now() - started); }
    samples.sort((a, b) => a - b);
    medians[name] = Number(samples[Math.floor(samples.length / 2)].toFixed(3));
  }
  return { movements: fixture.state.movements.length, snapshots: fixture.state.snapshots.length, rawSmsBytes: Buffer.byteLength(fixture.messages.map((message) => message.raw).join("")), stateBytes: Buffer.byteLength(JSON.stringify(fixture.state)), iterations, medianMs: medians };
}
