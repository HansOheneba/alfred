import { isRealDate } from "../dates";
import {
  AccountingError,
  type AccountingAction,
  type AccountingState,
  type BalanceSnapshot,
  type CashMovement,
  type FinancialAccount,
  type MovementReference,
} from "./types";

const STATUSES = new Set(["confirmed", "review", "hold", "transfer", "duplicate", "excluded"]);
const SOURCE_KINDS = new Set(["bank", "transaction", "manual"]);

function requireText(value: unknown, name: string, max = 512): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) {
    throw new AccountingError(`${name} must be nonempty text of at most ${max} characters.`);
  }
}
function integer(value: number, name: string, minimum = Number.MIN_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new AccountingError(`${name} must be a safe integer in minor units.`);
}
function instant(value: string, name: string) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !isRealDate(value.slice(0, 10)) || !Number.isFinite(Date.parse(value))) {
    throw new AccountingError(`${name} must be an ISO timestamp with a timezone.`);
  }
}
function currency(value: string) {
  if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value)) throw new AccountingError("Currency must be a three-letter uppercase code.");
}
function uniqueIds(rows: { id: string }[], name: string) {
  const ids = new Set<string>();
  for (const row of rows) {
    requireText(row.id, `${name} ID`);
    if (ids.has(row.id)) throw new AccountingError(`Duplicate ${name} ID ${row.id}.`, "conflict");
    ids.add(row.id);
  }
}
function accountFor(state: AccountingState, id: string, indexed?: Map<string, FinancialAccount>): FinancialAccount {
  const account = indexed ? indexed.get(id) : state.accounts.find((row) => row.id === id);
  if (!account) throw new AccountingError("Account was not found.", "not_found");
  return account;
}
function currentMovement(state: AccountingState, reference: MovementReference): CashMovement {
  requireText(reference.movementId, "Movement ID");
  requireText(reference.sourceFingerprint, "Source fingerprint");
  const movement = state.movements.find((row) => row.id === reference.movementId);
  if (!movement) throw new AccountingError("Movement was not found.", "not_found");
  if (movement.ownerId !== state.ownerId) throw new AccountingError("Movement belongs to another owner.", "ownership");
  if (movement.sourceFingerprint !== reference.sourceFingerprint) throw new AccountingError("Source evidence changed. Reload before editing this movement.", "stale");
  return movement;
}
function movementInUse(state: AccountingState, movementId: string) {
  return state.transfers.some((row) => row.outgoing.movementId === movementId || row.incoming.movementId === movementId)
    || state.settlements.some((row) => row.original.movementId === movementId || row.returns.some((item) => item.movementId === movementId));
}
function sameSource(a: CashMovement, b: CashMovement) {
  return a.sourceKind === b.sourceKind && a.sourceId === b.sourceId;
}
function validateSnapshot(state: AccountingState, snapshot: BalanceSnapshot, accounts?: Map<string, FinancialAccount>, movements?: Map<string, CashMovement>) {
  requireText(snapshot.id, "Snapshot ID");
  accountFor(state, snapshot.accountId, accounts);
  integer(snapshot.balanceMinor, "Reported balance");
  instant(snapshot.occurredAt, "Snapshot time");
  requireText(snapshot.sourceId, "Snapshot source ID");
  if (snapshot.sourceFingerprint !== undefined) requireText(snapshot.sourceFingerprint, "Snapshot source fingerprint");
  if (snapshot.sourceMovementId !== null) {
    const movement = movements ? movements.get(snapshot.sourceMovementId) : state.movements.find((row) => row.id === snapshot.sourceMovementId);
    if (!movement) throw new AccountingError("Snapshot source movement was not found.", "not_found");
    if (movement.ownerId !== state.ownerId) throw new AccountingError("Snapshot source belongs to another owner.", "ownership");
  }
}
function sameSnapshot(a: BalanceSnapshot, b: BalanceSnapshot) {
  return a.id === b.id && a.accountId === b.accountId && a.balanceMinor === b.balanceMinor
    && a.occurredAt === b.occurredAt && a.sourceId === b.sourceId && a.sourceMovementId === b.sourceMovementId
    && a.sourceFingerprint === b.sourceFingerprint;
}
function appendSnapshot(state: AccountingState, snapshot: BalanceSnapshot): AccountingState {
  validateSnapshot(state, snapshot);
  const existing = state.snapshots.find((row) => row.id === snapshot.id);
  if (existing) {
    if (!sameSnapshot(existing, snapshot)) throw new AccountingError("Reported snapshots are immutable. Record new evidence instead.", "conflict");
    return state;
  }
  if (snapshot.sourceMovementId !== null) {
    const movement = state.movements.find((row) => row.id === snapshot.sourceMovementId)!;
    if (movement.accountId !== snapshot.accountId || movement.sourceId !== snapshot.sourceId || movement.occurredAt !== snapshot.occurredAt) {
      throw new AccountingError("Snapshot must match its source movement account, source and timestamp.", "conflict");
    }
    if (snapshot.sourceFingerprint !== undefined && snapshot.sourceFingerprint !== movement.sourceFingerprint) {
      throw new AccountingError("Snapshot source evidence changed.", "stale");
    }
    if (movement.reportedBalanceMinor !== undefined && movement.reportedBalanceMinor !== null && movement.reportedBalanceMinor !== snapshot.balanceMinor) {
      throw new AccountingError("Snapshot must preserve the balance reported by its source.", "conflict");
    }
  }
  return { ...state, snapshots: [...state.snapshots, { ...snapshot }] };
}

/** Validate structural invariants without deleting stale evidence, which must remain auditable. */
export function validateAccountData(state: AccountingState): void {
  requireText(state.ownerId, "Owner ID");
  uniqueIds(state.accounts, "account");
  uniqueIds(state.movements, "movement");
  uniqueIds(state.snapshots, "snapshot");
  uniqueIds(state.transfers, "transfer");
  uniqueIds(state.settlements, "settlement");
  for (const account of state.accounts) {
    requireText(account.label, "Account label", 160);
    requireText(account.provider, "Account provider", 160);
    currency(account.currency);
    if (typeof account.includeInCash !== "boolean") throw new AccountingError("Account cash inclusion must be a boolean.");
    instant(account.createdAt, "Account creation time");
  }
  // The uniqueness checks above run first, so lookups preserve both validation
  // order and the exact referenced record without rescanning every history row.
  const accountsById=new Map(state.accounts.map((account) => [account.id,account]));
  const movementsById=new Map(state.movements.map((movement) => [movement.id,movement]));
  for (const movement of state.movements) {
    if (movement.ownerId !== state.ownerId) throw new AccountingError("Movement belongs to another owner.", "ownership");
    currency(movement.currency);
    integer(movement.amountMinor, "Movement principal", 0);
    integer(movement.feeMinor, "Movement fee", 0);
    if (movement.confirmedFeeMinor !== undefined) {
      integer(movement.confirmedFeeMinor, "Confirmed source fee", 0);
      if (movement.confirmedFeeMinor > movement.feeMinor) throw new AccountingError("Confirmed fee exceeds its source fee.");
    }
    if (movement.automaticTransferStale !== undefined && typeof movement.automaticTransferStale !== "boolean") throw new AccountingError("Automatic transfer state is invalid.");
    integer(movement.taxMinor ?? 0, "Movement tax", 0);
    integer(movement.amountMinor + movement.feeMinor + (movement.taxMinor ?? 0), "Movement gross amount", 1);
    if (!STATUSES.has(movement.status) || !["in", "out", "internal"].includes(movement.direction) || !SOURCE_KINDS.has(movement.sourceKind)) throw new AccountingError("Movement classification is invalid.");
    if (!isRealDate(movement.date)) throw new AccountingError("Movement date is invalid.");
    if (movement.occurredAt !== null) instant(movement.occurredAt, "Movement time");
    requireText(movement.sourceId, "Source ID");
    requireText(movement.sourceFingerprint, "Source fingerprint");
    if (movement.accountId !== null && accountFor(state, movement.accountId, accountsById).currency !== movement.currency) throw new AccountingError("Movement currency does not match its account.", "conflict");
    for (const value of [movement.reportedBalanceMinor, movement.reportedBalanceBeforeMinor]) if (value !== undefined && value !== null) integer(value, "Source-reported balance");
  }
  for (const snapshot of state.snapshots) validateSnapshot(state, snapshot, accountsById, movementsById);
  const linked = new Set<string>();
  for (const transfer of state.transfers) {
    instant(transfer.createdAt, "Transfer creation time");
    if (transfer.automatic) {
      if (transfer.automatic.version !== 1) throw new AccountingError("Automatic transfer policy version is invalid.");
      integer(transfer.automatic.pairedRevision, "Automatic transfer revision", 1);
      for (const previous of [transfer.automatic.outgoing, transfer.automatic.incoming]) {
        if (!previous || !STATUSES.has(previous.movementStatus) || !["needs_label", "transfer"].includes(previous.bankStatus) || !["payment", "transfer_own"].includes(previous.bankKind)) throw new AccountingError("Automatic transfer provenance is invalid.");
      }
    }
    for (const reference of [transfer.outgoing, transfer.incoming]) {
      requireText(reference.sourceFingerprint, "Transfer source fingerprint");
      if (!movementsById.has(reference.movementId)) throw new AccountingError("Transfer movement was not found.", "not_found");
      if (linked.has(reference.movementId)) throw new AccountingError("A movement cannot belong to multiple transfer links.", "conflict");
      linked.add(reference.movementId);
    }
  }
  if (state.transferRejections !== undefined) {
    if (!Array.isArray(state.transferRejections) || state.transferRejections.length > 50_000 || new Set(state.transferRejections).size !== state.transferRejections.length) throw new AccountingError("Transfer corrections are invalid.");
    for (const id of state.transferRejections) requireText(id, "Rejected transfer ID", 200);
  }
  for (const settlement of state.settlements) {
    for (const reference of [settlement.original, ...settlement.returns]) {
      if (linked.has(reference.movementId)) throw new AccountingError("A transfer movement cannot also belong to a settlement.", "conflict");
    }
  }
}

/** Actions change account metadata/classification only; raw source amounts and evidence stay intact. */
export function applyAccountAction(state: AccountingState, action: AccountingAction, now: string): AccountingState {
  instant(now, "Action time");
  if (action.type === "create_account") {
    if (state.accounts.some((row) => row.id === action.account.id)) throw new AccountingError("Account ID already exists.", "conflict");
    const next = { ...state, accounts: [...state.accounts, { ...action.account, createdAt: now }] };
    validateAccountData(next);
    return next;
  }
  if (action.type === "update_account") {
    accountFor(state, action.accountId);
    // Runtime callers cannot mutate stable identity or currency by adding extra keys.
    const changes = {
      ...(action.changes.label === undefined ? {} : { label: action.changes.label }),
      ...(action.changes.provider === undefined ? {} : { provider: action.changes.provider }),
      ...(action.changes.includeInCash === undefined ? {} : { includeInCash: action.changes.includeInCash }),
    };
    const next = { ...state, accounts: state.accounts.map((row) => row.id === action.accountId ? { ...row, ...changes } : row) };
    validateAccountData(next);
    return next;
  }
  if (action.type === "assign_movement") {
    const movement = currentMovement(state, action.movement);
    const account = accountFor(state, action.accountId);
    if (account.currency !== movement.currency) throw new AccountingError("Movement currency does not match the selected account.", "conflict");
    if (movement.accountId !== account.id && movementInUse(state, movement.id)) throw new AccountingError("Remove the movement's transfer or settlement link before changing its account.", "conflict");
    let next = { ...state, movements: state.movements.map((row) => row.id === movement.id ? { ...row, accountId: account.id } : row) };
    if (movement.reportedBalanceMinor !== undefined && movement.reportedBalanceMinor !== null && movement.occurredAt !== null) {
      next = appendSnapshot(next, {
        id: `source-snapshot:${movement.id}:${movement.sourceFingerprint}:${account.id}`,
        accountId: account.id, balanceMinor: movement.reportedBalanceMinor, occurredAt: movement.occurredAt,
        sourceId: movement.sourceId, sourceMovementId: movement.id, sourceFingerprint: movement.sourceFingerprint,
      });
    }
    validateAccountData(next);
    return next;
  }
  if (action.type === "classify_movement" || action.type === "classify_movements") {
    // Several at once is one change with one undo: a whole merchant group sorted in chat.
    const references = action.type === "classify_movement" ? [action.movement] : action.movements;
    if (references.length === 0 || references.length > 500 || new Set(references.map((reference) => reference.movementId)).size !== references.length) throw new AccountingError("Choose between 1 and 500 different movements.");
    const ids = new Set(references.map((reference) => {
      const movement = currentMovement(state, reference);
      if (movementInUse(state, movement.id)) throw new AccountingError("Remove the movement's transfer or settlement link before reclassifying it.", "conflict");
      if (movement.legacyClassification) throw new AccountingError("Legacy refund or loan classification must be resolved before reclassifying this movement.", "conflict");
      return movement.id;
    }));
    if (action.category !== undefined) requireText(action.category, "Category", 160);
    const next = { ...state, movements: state.movements.map((row) => {
      if (!ids.has(row.id)) return row;
      const changed={...row,status:action.status};
      if (action.category!==undefined) {changed.category=action.category.trim();changed.categoryOrigin="manual";delete changed.appliedRuleId;delete changed.ruleConflict;}
      return changed;
    }) };
    validateAccountData(next);
    return next;
  }
  if (action.type === "record_snapshot") return appendSnapshot(state, action.snapshot);
  if (action.type === "pair_transfer") {
    requireText(action.id, "Transfer ID");
    const outgoing = currentMovement(state, action.outgoing);
    const incoming = currentMovement(state, action.incoming);
    const existing = state.transfers.find((row) => row.id === action.id);
    if (existing) {
      if (existing.outgoing.movementId === outgoing.id && existing.incoming.movementId === incoming.id && existing.outgoing.sourceFingerprint === action.outgoing.sourceFingerprint && existing.incoming.sourceFingerprint === action.incoming.sourceFingerprint) return state;
      throw new AccountingError("Transfer ID already exists.", "conflict");
    }
    if (outgoing.direction !== "out" || incoming.direction !== "in" || outgoing.status !== "confirmed" || incoming.status !== "confirmed") throw new AccountingError("A transfer needs one confirmed outgoing and one confirmed incoming movement.", "conflict");
    if (!outgoing.accountId || !incoming.accountId || outgoing.accountId === incoming.accountId) throw new AccountingError("A transfer needs two different assigned accounts.", "conflict");
    if (outgoing.currency !== incoming.currency || outgoing.amountMinor !== incoming.amountMinor) throw new AccountingError("Transfer principal and currency must match exactly.", "conflict");
    if (movementInUse(state, outgoing.id) || movementInUse(state, incoming.id)) throw new AccountingError("A movement is already linked to a transfer or settlement.", "conflict");
    if (outgoing.legacyClassification || incoming.legacyClassification) throw new AccountingError("Legacy refund or loan movements cannot be paired as transfers.", "conflict");
    for (const movement of [outgoing, incoming]) {
      if (state.movements.some((row) => row.id !== movement.id && row.status !== "duplicate" && sameSource(row, movement))) {
        throw new AccountingError("Transfer source evidence has multiple active movement records. Resolve the duplicate first.", "conflict");
      }
    }
    const next = {
      ...state,
      movements: state.movements.map((row) => row.id === outgoing.id || row.id === incoming.id ? { ...row, status: "transfer" as const } : row),
      transfers: [...state.transfers, { id: action.id, outgoing: { ...action.outgoing }, incoming: { ...action.incoming }, createdAt: now }],
    };
    validateAccountData(next);
    return next;
  }
  if (action.type === "unpair_transfer") {
    const transfer = state.transfers.find((row) => row.id === action.transferId);
    if (!transfer) throw new AccountingError("Transfer was not found.", "not_found");
    // Removing stale metadata is allowed. Changed evidence returns to its own
    // ingestion status, never the confirmation attached to the old transfer.
    const references = new Map([transfer.outgoing, transfer.incoming].map((row) => [row.movementId, row]));
    return {
      ...state,
      transfers: state.transfers.filter((row) => row.id !== transfer.id),
      movements: state.movements.map((row) => {
        const reference = references.get(row.id);
        if (!reference) return row;
        if (row.ownerId !== state.ownerId) throw new AccountingError("Transfer movement belongs to another owner.", "ownership");
        const status = reference.sourceFingerprint === row.sourceFingerprint ? "confirmed" : row.sourceStatus === "transfer" ? "review" : row.sourceStatus ?? "review";
        return { ...row, status };
      }),
    };
  }
  throw new AccountingError("Unsupported account action.");
}

export type AccountReconciliation = { status: "unavailable" | "incomplete" | "matched" | "mismatch"; expectedMinor: number | null; differenceMinor: number | null; reason: string };
/**
 * `snapshot` is the balance to show: the latest reported one, moved by chat or manual
 * entries for this account logged since (`loggedSinceMinor`). `reported` is the bank's own figure.
 */
export type AccountBalanceRow = { account: FinancialAccount; snapshot: BalanceSnapshot | null; reconciliation: AccountReconciliation; reported?: BalanceSnapshot | null; loggedSinceMinor?: number };

/** Net of confirmed chat or manual entries for this account, logged after the report and not dated before it. */
export function loggedSince(state: Pick<AccountingState, "movements">, account: Pick<FinancialAccount, "id" | "currency">, reported: Pick<BalanceSnapshot, "occurredAt">): number {
  const after = Date.parse(reported.occurredAt), day = reported.occurredAt.slice(0, 10);
  let net = 0;
  for (const movement of state.movements) {
    if (movement.sourceKind !== "transaction" || movement.accountId !== account.id || movement.currency !== account.currency || movement.status !== "confirmed") continue;
    if (!movement.loggedAt || !(Date.parse(movement.loggedAt) > after) || movement.date < day) continue;
    if (movement.direction === "in") net += movement.amountMinor;
    else if (movement.direction === "out") net -= movement.amountMinor;
  }
  if (!Number.isSafeInteger(net)) throw new AccountingError("Logged movements exceed safe integer precision.");
  return net;
}

function sourceSnapshotCurrent(movements: Map<string, CashMovement>, snapshot: BalanceSnapshot) {
  if (snapshot.sourceMovementId === null) return true;
  const movement = movements.get(snapshot.sourceMovementId);
  return movement !== undefined && movement.accountId === snapshot.accountId && movement.sourceId === snapshot.sourceId
    && movement.occurredAt === snapshot.occurredAt && (snapshot.sourceFingerprint === undefined || snapshot.sourceFingerprint === movement.sourceFingerprint)
    && (movement.reportedBalanceMinor === undefined || movement.reportedBalanceMinor === null || movement.reportedBalanceMinor === snapshot.balanceMinor);
}

function reconcile(state: AccountingState, account: FinancialAccount, snapshots: BalanceSnapshot[]): AccountReconciliation {
  const latest = snapshots.at(-1);
  if (!latest) return { status: "unavailable", expectedMinor: null, differenceMinor: null, reason: "No current reported balance snapshot is available." };
  const previous = snapshots.findLast((row) => Date.parse(row.occurredAt) < Date.parse(latest.occurredAt));
  if (!previous) return { status: "incomplete", expectedMinor: null, differenceMinor: null, reason: "A previous reported balance is needed to reconcile this account." };
  const start = Date.parse(previous.occurredAt), end = Date.parse(latest.occurredAt);
  let expected = previous.balanceMinor;
  const issues = new Set<string>();
  const evidence = new Set<string>();
  for (const movement of state.movements) {
    if (movement.currency !== account.currency || (movement.accountId !== null && movement.accountId !== account.id) || movement.status === "duplicate") continue;
    if (movement.occurredAt === null) {
      if (movement.date >= previous.occurredAt.slice(0, 10) && movement.date <= latest.occurredAt.slice(0, 10)) issues.add("Some movements have no exact occurrence time.");
      continue;
    }
    const time = Date.parse(movement.occurredAt);
    if (time <= start || time > end) continue;
    if (movement.accountId === null) { issues.add("Some movements have not been assigned to an account."); continue; }
    const evidenceId = JSON.stringify([movement.sourceKind, movement.sourceId]);
    if (evidence.has(evidenceId)) { issues.add("Multiple active movements share the same source evidence."); continue; }
    evidence.add(evidenceId);
    if (movement.status === "review") issues.add("Some source movements still need review.");
    if (movement.status === "hold") issues.add("Recorded holds do not establish final account settlement.");
    if (movement.direction === "internal") issues.add("Some movements have no explicit incoming or outgoing cash direction.");
    if (movement.status === "transfer" && !state.transfers.some((row) => row.outgoing.movementId === movement.id || row.incoming.movementId === movement.id)) issues.add("Some transfer movements have no confirmed linked counterpart.");
    for (const transfer of state.transfers) {
      const reference = [transfer.outgoing, transfer.incoming].find((row) => row.movementId === movement.id);
      if (reference && reference.sourceFingerprint !== movement.sourceFingerprint) issues.add("Some transfer links refer to changed source evidence.");
    }
    if (movement.direction === "out") expected -= movement.amountMinor + movement.feeMinor + (movement.taxMinor ?? 0);
    else if (movement.direction === "in") expected += movement.amountMinor - movement.feeMinor - (movement.taxMinor ?? 0);
    else if (movement.feeMinor + (movement.taxMinor ?? 0) > 0) expected -= movement.feeMinor + (movement.taxMinor ?? 0);
    if (!Number.isSafeInteger(expected)) throw new AccountingError("Reconciliation exceeds safe integer precision.");
  }
  const difference = latest.balanceMinor - expected;
  if (!Number.isSafeInteger(difference)) throw new AccountingError("Reconciliation difference exceeds safe integer precision.");
  if (issues.size) return { status: "incomplete", expectedMinor: expected, differenceMinor: difference, reason: [...issues].join(" ") };
  return difference === 0
    ? { status: "matched", expectedMinor: expected, differenceMinor: 0, reason: "Recorded cash movements match the two reported balance snapshots; unrecorded activity may still be absent." }
    : { status: "mismatch", expectedMinor: expected, differenceMinor: difference, reason: "The latest reported balance differs from the prior snapshot plus recorded cash movements." };
}

/** Reported cash total, not income minus spending and not net worth. Missing snapshots stay unknown. */
export function accountBalanceFacts(state: AccountingState): AccountBalanceRow[] {
  validateAccountData(state);
  const movementsById=new Map(state.movements.map((movement) => [movement.id,movement]));
  const snapshotsByAccount=new Map<string,BalanceSnapshot[]>();
  for (const snapshot of state.snapshots) {
    if (!sourceSnapshotCurrent(movementsById,snapshot)) continue;
    const rows=snapshotsByAccount.get(snapshot.accountId) ?? [];
    rows.push(snapshot);
    snapshotsByAccount.set(snapshot.accountId,rows);
  }
  const accounts = state.accounts.map((account) => {
    // Stable sort preserves append order for multiple actual observations at the same instant.
    const snapshots = (snapshotsByAccount.get(account.id) ?? []).sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
    const reported = snapshots.at(-1) ?? null;
    const logged = reported ? loggedSince(state, account, reported) : 0;
    const snapshot = reported && logged ? { ...reported, balanceMinor: reported.balanceMinor + logged } : reported;
    return { account, snapshot, reported, loggedSinceMinor: logged, reconciliation: reconcile(state, account, snapshots) };
  });
  return accounts;
}

/** Reported cash total, retaining unknown balances and requested-currency precision checks. */
export function accountBalances(state: AccountingState, requestedCurrency: string): { accounts: AccountBalanceRow[]; totalMinor: number | null; knownSubtotalMinor: number | null; count: number; missingCount: number; excludedCount: number } {
  currency(requestedCurrency);
  const accounts = accountBalanceFacts(state);
  const included = accounts.filter((row) => row.account.includeInCash && row.account.currency === requestedCurrency);
  const known = included.filter((row) => row.snapshot !== null);
  const missingCount = included.length - known.length;
  const knownSubtotalMinor = known.length ? known.reduce((sum, row) => sum + row.snapshot!.balanceMinor, 0) : null;
  if (knownSubtotalMinor !== null) integer(knownSubtotalMinor, "Known account subtotal");
  const totalMinor = included.length > 0 && missingCount === 0 ? knownSubtotalMinor : null;
  return { accounts, totalMinor, knownSubtotalMinor, count: included.length, missingCount, excludedCount: accounts.length - included.length };
}
