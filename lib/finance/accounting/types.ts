/** Browser-safe financial domain. Amounts are integer minor units; raw evidence is never rewritten by classification. */
export type MovementStatus = "confirmed" | "review" | "hold" | "transfer" | "duplicate" | "excluded";
export type FinancialAccount = { id: string; label: string; provider: string; currency: string; includeInCash: boolean; createdAt: string };
export type CashMovement = {
  id: string; ownerId: string; accountId: string | null; direction: "in" | "out" | "internal"; status: MovementStatus;
  amountMinor: number; feeMinor: number; taxMinor?: number; currency: string; date: string; occurredAt: string | null;
  description: string; category: string; sourceId: string; sourceKind: "bank" | "transaction" | "manual"; sourceFingerprint: string;
  legacyTransactionId: string | null; feeTransactionId: string | null; legacyClassification: null | "refund" | "loan";
  /** Source-reported evidence; never inferred from income/spending. Retained even before account assignment. */
  reportedBalanceMinor?: number | null; reportedBalanceBeforeMinor?: number | null; sourceText?: string; sourceLabel?: string;
  /** Immutable ingestion classification; explicit overrides are stored separately from source facts. */
  sourceStatus?: MovementStatus;
  sourceCategory?: string;
  /** Explicit user categories outrank deterministic account rules, which outrank source/payee defaults. */
  categoryOrigin?: "manual" | "account_rule" | "source";
  appliedRuleId?: string;
  ruleConflict?: boolean;
  sourceMissing?: boolean;
  /** Durable historical import evidence, distinct from SMS ingestion. */
  importProvenance?: { namespace: string; sourceId: string; sourceFingerprint?: string };
};
export type BalanceSnapshot = { id: string; accountId: string; balanceMinor: number; occurredAt: string; sourceId: string; sourceMovementId: string | null; sourceFingerprint?: string };
export type MovementReference = { movementId: string; sourceFingerprint: string };
export type TransferLink = { id: string; outgoing: MovementReference; incoming: MovementReference; createdAt: string };
export type SettlementReturn = MovementReference & { principalMinor: number };
export type SettlementLink = { id: string; kind: "refund" | "loan"; original: MovementReference; returns: SettlementReturn[]; createdAt: string };
export type AccountingData = { accounts: FinancialAccount[]; movements: CashMovement[]; snapshots: BalanceSnapshot[]; transfers: TransferLink[]; settlements: SettlementLink[] };
export type AccountingAudit = { id: string; requestId: string; action: string; actionFingerprint: string; at: string; revision: number; before: AccountingData };
export type AccountingState = AccountingData & { ownerId: string; revision: number; audit: AccountingAudit[] };
type Command = { expectedRevision: number; requestId: string };
export type AccountingAction = Command & (
  | { type: "create_account"; account: Omit<FinancialAccount,"createdAt"> }
  | { type: "update_account"; accountId: string; changes: Partial<Pick<FinancialAccount,"label" | "provider" | "includeInCash">> }
  | { type: "assign_movement"; movement: MovementReference; accountId: string }
  | { type: "classify_movement"; movement: MovementReference; status: "confirmed" | "review" | "hold" | "duplicate" | "excluded"; category?: string }
  | { type: "record_snapshot"; snapshot: BalanceSnapshot }
  | { type: "pair_transfer"; id: string; outgoing: MovementReference; incoming: MovementReference }
  | { type: "unpair_transfer"; transferId: string }
  | { type: "save_settlement"; settlement: Omit<SettlementLink,"createdAt"> }
  | { type: "delete_settlement"; settlementId: string }
  | { type: "undo" }
);
export class AccountingError extends Error {
  constructor(message: string, public readonly code: "validation" | "stale" | "ownership" | "not_found" | "conflict" = "validation") { super(message); this.name = "AccountingError"; }
}
export function emptyAccountingState(ownerId: string): AccountingState { return { ownerId,revision:0,accounts:[],movements:[],snapshots:[],transfers:[],settlements:[],audit:[] }; }

/** What the Accounts page lists under Needs attention: no account yet, waiting for review, or on hold. */
export function needsAttention(movement: Pick<CashMovement, "accountId" | "status">): boolean {
  return !movement.accountId || movement.status === "review" || movement.status === "hold";
}

/** How many movements need attention, and why, so Alfred can speak to the same list the Accounts page shows. */
export type AttentionSummary = { total: number; review: number; unassigned: number; hold: number };
export function attentionSummary(movements: Pick<CashMovement, "accountId" | "status">[]): AttentionSummary {
  const rows = movements.filter(needsAttention);
  return {
    total: rows.length,
    review: rows.filter((row) => row.status === "review").length,
    unassigned: rows.filter((row) => !row.accountId).length,
    hold: rows.filter((row) => row.status === "hold").length,
  };
}
