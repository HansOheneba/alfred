import type { AccountingData, AccountingState } from "@/lib/finance/accounting/types";
import { sourceMovements } from "@/lib/finance/accounting/sources";
import { accountingCpuFixture, CPU_OWNER } from "./accounting-cpu-fixture";

/** Explicit fictional workload, not a reconstruction of a person's financial records. */
export function populatedPerformanceFixture() {
  const original = accountingCpuFixture(2315, 2277);
  const currentMonth = (date: string) => date.replace(/^2026-01-/, "2026-11-");
  const raw = original.raw.slice(0, 2).map(row => ({ ...row, createdAt: currentMonth(row.createdAt), transactionDate: currentMonth(row.transactionDate), updatedAt: currentMonth(row.updatedAt) }));
  const messages = original.messages.slice(0, 6).map((row, index) => ({ ...row, occurredAt: currentMonth(row.occurredAt), transactionId: index < 2 ? row.transactionId : null, balance: Number(row.balance).toFixed(2) }));
  const bankIds = new Set(messages.map((row) => row.id));
  const imported = original.fresh.filter((row) => !bankIds.has(row.sourceId)).map((row, index) => ({ ...row,
    date: currentMonth(row.date), occurredAt: row.occurredAt && currentMonth(row.occurredAt),
    sourceText: `FICTIONAL IMPORT ${index}. ${"Synthetic evidence retained. ".repeat(4)}`,
    importProvenance: { namespace: "fictional-fixture", sourceId: row.sourceId },
  }));
  const fresh = [...sourceMovements(CPU_OWNER, raw, messages), ...imported];
  // Exactly 2277 movements carry reported balance evidence. Hydration must not
  // manufacture additional fixture snapshots beyond the declared workload.
  for (const row of fresh.slice(2277)) row.reportedBalanceMinor = null;
  const outgoing = fresh.filter((row) => row.direction === "out").slice(0, 200);
  const incoming = fresh.filter((row) => row.direction === "in").slice(0, 200);
  const transferIds = new Set([...outgoing, ...incoming].map((row) => row.id));
  const movements = fresh.map((row, index) => ({ ...row, accountId: transferIds.has(row.id) ? row.direction === "out" ? "account:0" : "account:1" : `account:${index % 8}`, status: transferIds.has(row.id) ? "transfer" as const : row.status }));
  const state: AccountingState = { ...original.state, movements,
    transfers: original.state.transfers.map((row, index) => ({ ...row, createdAt: currentMonth(row.createdAt),
      outgoing: { movementId: outgoing[index].id, sourceFingerprint: outgoing[index].sourceFingerprint },
      incoming: { movementId: incoming[index].id, sourceFingerprint: incoming[index].sourceFingerprint },
    })),
    snapshots: movements.slice(0, 2277).map((row) => ({ id: `source-snapshot:${row.id}:${row.sourceFingerprint}:${row.accountId}`,
      accountId: row.accountId, balanceMinor: row.reportedBalanceMinor!, occurredAt: row.occurredAt!, sourceId: row.sourceId, sourceMovementId: row.id, sourceFingerprint: row.sourceFingerprint })),
  };
  const before: AccountingData = { accounts: state.accounts, movements: state.movements, snapshots: state.snapshots, transfers: state.transfers, settlements: state.settlements };
  // Four retained full before-states illustrate audit multiplication. This count
  // and source-string length are declared choices, not tuned to production bytes.
  state.audit = Array.from({ length: 4 }, (_, index) => ({ id: `fixture-audit:${index}`, requestId: `fixture-request:${index}`, action: "update_account", actionFingerprint: `fixture-fingerprint:${index}`, at: "2026-11-05T00:00:00.000Z", revision: index + 1, before }));
  return { state, raw, messages, imported, fresh };
}
