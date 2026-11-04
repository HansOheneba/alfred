import type { LedgerReceipt, LedgerRow } from "../analytics";
import { AccountingError, type AccountingState, type CashMovement } from "./types";

/** Enrich an existing report snapshot in linear time. Never query, serialize raw alerts, or recalculate financial effects. */
export function withLedgerReceipts(rows: LedgerRow[], state: AccountingState, ownerId: string): LedgerRow[] {
  if (state.ownerId !== ownerId) throw new AccountingError("Financial state belongs to another owner.", "ownership");
  const movements = state.movements.filter((movement) => movement.ownerId === ownerId);
  const byId = new Map(movements.map((movement) => [movement.id, movement]));
  const accounts = new Map(state.accounts.map((account) => [account.id, account]));
  const byTransaction = new Map<string, { movement: CashMovement; kind: LedgerReceipt["kind"] } | null>();
  for (const movement of movements) {
    if (movement.status === "duplicate" || movement.sourceMissing) continue;
    for (const [key, kind] of [[movement.legacyTransactionId, "payment"], [movement.feeTransactionId, "fee"]] as const) {
      if (key) byTransaction.set(key, byTransaction.has(key) ? null : { movement, kind });
    }
  }
  const links = new Map<string, Set<LedgerReceipt["links"][number]>>();
  const link = (movementId: string, kind: LedgerReceipt["links"][number]) => {
    const kinds = links.get(movementId) ?? new Set<LedgerReceipt["links"][number]>();
    kinds.add(kind);
    links.set(movementId, kinds);
  };
  for (const transfer of state.transfers) {
    link(transfer.outgoing.movementId, "transfer");
    link(transfer.incoming.movementId, "transfer");
  }
  for (const settlement of state.settlements) {
    link(settlement.original.movementId, settlement.kind);
    for (const returned of settlement.returns) link(returned.movementId, settlement.kind);
  }
  return rows.map((row) => {
    const derived = /^accounting(?:(-fee|-tax))?:(.+)$/.exec(row.id);
    const alias = derived ? undefined : byTransaction.get(row.id);
    const movement = derived ? byId.get(derived[2]) : alias?.movement;
    if (!movement) return row;
    const account = movement.accountId ? accounts.get(movement.accountId) : undefined;
    return { ...row, receipt: {
      kind: derived ? derived[1] === "-fee" ? "fee" : derived[1] === "-tax" ? "tax" : "payment" : alias!.kind,
      accountLabel: account?.currency === row.currency ? account.label : null,
      occurredAt: movement.occurredAt,
      status: movement.status,
      sourceLabel: (movement.sourceLabel || (movement.sourceKind === "bank" ? "Payment alert" : "Recorded transaction")).slice(0, 160),
      principalMinor: movement.amountMinor,
      feeMinor: movement.feeMinor,
      taxMinor: movement.taxMinor ?? 0,
      balanceBeforeMinor: movement.reportedBalanceBeforeMinor ?? null,
      balanceAfterMinor: movement.reportedBalanceMinor ?? null,
      links: [...(links.get(movement.id) ?? [])],
      imported: Boolean(movement.importProvenance),
      sourceMissing: Boolean(movement.sourceMissing),
    } satisfies LedgerReceipt };
  });
}
