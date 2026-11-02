import {
  AccountingError,
  type AccountingAction,
  type AccountingState,
  type CashMovement,
  type MovementReference,
  type SettlementLink,
  type SettlementReturn,
} from "./types";

export type SettlementIssue = {
  link: SettlementLink;
  reason: string;
  code: AccountingError["code"];
};

export type ResolvedSettlement = {
  link: SettlementLink;
  original: CashMovement;
  returns: { reference: SettlementReturn; movement: CashMovement }[];
  returnedMinor: number;
  outstandingMinor: number;
  spendingOffsetMinor: number;
};

export type SettlementEffect = {
  settlementId: string;
  kind: SettlementLink["kind"];
  role: "original" | "return";
  originalMovementId: string;
  originalDate: string;
  spendingOffsetMinor: number;
  receivedOffsetMinor: number;
  principalMinor: number;
  /** The link's aggregate returned principal, on both original and return effects. */
  returnedMinor: number;
  outstandingMinor: number;
  /** Unallocated incoming principal remains income; fees are separate, unchanged expenses. */
  extraIncomeMinor: number;
};

function problem(message: string, code: AccountingError["code"] = "validation"): never {
  throw new AccountingError(message, code);
}

function nonempty(value: unknown, max = 500): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function validDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parts = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts || !validDay(parts[1]) || Number(parts[2]) > 23
    || Number(parts[3]) > 59 || Number(parts[4]) > 59) return false;
  if (parts[5] !== "Z"
    && (Number(parts[5].slice(1, 3)) > 23 || Number(parts[5].slice(4, 6)) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}

function linkReferences(link: SettlementLink): MovementReference[] {
  return [link?.original, ...(Array.isArray(link?.returns) ? link.returns : [])].filter(Boolean);
}

function sourceKey(movement: CashMovement): string {
  return JSON.stringify([movement.sourceKind, movement.sourceId]);
}

/**
 * Resolve only exact, still-current evidence. Invalid metadata never changes reports.
 * Conflicting links all fail closed, rather than the array's first link winning.
 */
export function validateSettlements(state: AccountingState): {
  valid: ResolvedSettlement[];
  issues: SettlementIssue[];
} {
  const movements = new Map<string, CashMovement>();
  const duplicateIds = new Set<string>();
  const sourceCounts = new Map<string, number>();
  for (const movement of state.movements) {
    if (movements.has(movement.id)) duplicateIds.add(movement.id);
    movements.set(movement.id, movement);
    if (movement.status !== "duplicate") {
      const key = sourceKey(movement);
      sourceCounts.set(key, (sourceCounts.get(key) ?? 0) + 1);
    }
  }

  const reservations = new Map<string, Set<number>>();
  const linkIdCounts = new Map<string, number>();
  state.settlements.forEach((link, index) => {
    linkIdCounts.set(link.id, (linkIdCounts.get(link.id) ?? 0) + 1);
    for (const reference of linkReferences(link)) {
      const reserved = reservations.get(reference.movementId) ?? new Set<number>();
      reserved.add(index);
      reservations.set(reference.movementId, reserved);
    }
  });
  const transferMovements = new Set(
    state.transfers.flatMap((transfer) => [transfer.outgoing.movementId, transfer.incoming.movementId]),
  );

  const valid: ResolvedSettlement[] = [];
  const issues: SettlementIssue[] = [];
  for (const link of state.settlements) {
    try {
      if (!nonempty(link.id, 200) || !["refund", "loan"].includes(link.kind)) {
        problem("A settlement needs a stable ID and a refund or loan kind.");
      }
      if ((linkIdCounts.get(link.id) ?? 0) !== 1) problem("Settlement IDs must be unique.", "conflict");
      if (!validTimestamp(link.createdAt)) problem("The settlement creation timestamp is invalid.");
      if (!Array.isArray(link.returns) || link.returns.length > 100) {
        problem("A settlement supports at most 100 return records.");
      }
      if (link.kind === "refund" && link.returns.length === 0) {
        problem("Select at least one return for a refund.");
      }

      const resolve = (reference: MovementReference, direction: "in" | "out"): CashMovement => {
        if (!reference || !nonempty(reference.movementId, 200) || !nonempty(reference.sourceFingerprint)) {
          problem("Every linked record needs its exact source reference.");
        }
        const movement = movements.get(reference.movementId);
        if (!movement) problem("A linked source record no longer exists.", "not_found");
        if (movement.ownerId !== state.ownerId) problem("Linked records must belong to this owner.", "ownership");
        if (movement.sourceFingerprint !== reference.sourceFingerprint) {
          problem("A linked source record changed. Review it before linking again.", "stale");
        }
        if (duplicateIds.has(movement.id) || (sourceCounts.get(sourceKey(movement)) ?? 0) !== 1) {
          problem("A linked source record is duplicated or ambiguous.", "conflict");
        }
        if (movement.status !== "confirmed" || movement.direction !== direction) {
          problem("Link only confirmed outgoing payments and confirmed incoming returns.");
        }
        if (movement.legacyClassification !== null) {
          problem("Undo the legacy refund or loan classification before linking this record.", "conflict");
        }
        if (!Number.isSafeInteger(movement.amountMinor) || movement.amountMinor <= 0
          || !Number.isSafeInteger(movement.feeMinor) || movement.feeMinor < 0
          || !/^[A-Z]{3}$/.test(movement.currency) || !nonempty(movement.sourceId)
          || !["bank", "transaction", "manual"].includes(movement.sourceKind)) {
          problem("A linked source amount, fee, currency or identity needs review.");
        }
        if (!validDay(movement.date)
          || (movement.occurredAt !== null && !validTimestamp(movement.occurredAt))) {
          problem("A linked source date or timestamp needs review.");
        }
        if (transferMovements.has(movement.id) || (reservations.get(movement.id)?.size ?? 0) > 1) {
          problem("A source record is already linked to another settlement or transfer.", "conflict");
        }
        return movement;
      };

      const original = resolve(link.original, "out");
      const used = new Set([original.id]);
      let returnedMinor = 0;
      const returns = link.returns.map((reference) => {
        const movement = resolve(reference, "in");
        if (used.has(movement.id)) problem("Each return source can be linked only once.", "conflict");
        used.add(movement.id);
        if (movement.currency !== original.currency) problem("Original and return currencies must match.");
        if (movement.date < original.date
          || (movement.occurredAt !== null && original.occurredAt !== null
            && Date.parse(movement.occurredAt) < Date.parse(original.occurredAt))) {
          problem("A return cannot occur before its original payment.");
        }
        if (!Number.isSafeInteger(reference.principalMinor) || reference.principalMinor <= 0
          || reference.principalMinor > movement.amountMinor) {
          problem("Allocated principal must be positive and no larger than the incoming amount.");
        }
        returnedMinor += reference.principalMinor;
        if (!Number.isSafeInteger(returnedMinor) || returnedMinor > original.amountMinor) {
          problem("Returned principal cannot exceed the original payment.");
        }
        return { reference, movement };
      });
      valid.push({
        link,
        original,
        returns,
        returnedMinor,
        outstandingMinor: original.amountMinor - returnedMinor,
        spendingOffsetMinor: link.kind === "loan" ? original.amountMinor : returnedMinor,
      });
    } catch (error) {
      if (!(error instanceof AccountingError)) throw error;
      issues.push({ link, reason: error.message, code: error.code });
    }
  }
  return { valid, issues };
}

/** Pure command step; the shared reducer adds revision/idempotency checks and audit. */
export function applySettlementAction(
  state: AccountingState,
  action: AccountingAction,
  now: string,
): AccountingState {
  if (action.type === "delete_settlement") {
    if (!state.settlements.some((link) => link.id === action.settlementId)) {
      problem("Settlement not found.", "not_found");
    }
    return { ...state, settlements: state.settlements.filter((link) => link.id !== action.settlementId) };
  }
  if (action.type !== "save_settlement") problem("Unsupported settlement action.");
  if (!validTimestamp(now)) problem("A valid command timestamp is required.");
  const previous = state.settlements.filter((link) => link.id === action.settlement.id);
  if (previous.length > 1) problem("Resolve duplicated settlement IDs before updating.", "conflict");
  const link: SettlementLink = {
    ...action.settlement,
    original: { ...action.settlement.original },
    returns: Array.isArray(action.settlement.returns)
      ? action.settlement.returns.map((reference) => ({ ...reference }))
      : action.settlement.returns,
    createdAt: previous[0]?.createdAt ?? now,
  };
  const next = { ...state, settlements: [...state.settlements.filter((item) => item.id !== link.id), link] };
  const issue = validateSettlements(next).issues.find((item) => item.link === link);
  if (issue) problem(issue.reason, issue.code);
  return next;
}

/**
 * Reporting subtracts these offsets from principal contributions only. Apply an
 * original's spending offset on originalDate (including refunds received later).
 * Source cash movements, balance snapshots and fee contributions stay untouched.
 */
export function settlementEffects(state: AccountingState): Map<string, SettlementEffect> {
  const effects = new Map<string, SettlementEffect>();
  for (const resolved of validateSettlements(state).valid) {
    const { link, original, returnedMinor, outstandingMinor, spendingOffsetMinor } = resolved;
    const common = {
      settlementId: link.id,
      kind: link.kind,
      originalMovementId: original.id,
      originalDate: original.date,
      returnedMinor,
      outstandingMinor,
    };
    effects.set(original.id, {
      ...common,
      role: "original",
      spendingOffsetMinor,
      receivedOffsetMinor: 0,
      principalMinor: original.amountMinor,
      extraIncomeMinor: 0,
    });
    for (const { reference, movement } of resolved.returns) {
      effects.set(movement.id, {
        ...common,
        role: "return",
        spendingOffsetMinor: 0,
        receivedOffsetMinor: reference.principalMinor,
        principalMinor: reference.principalMinor,
        extraIncomeMinor: movement.amountMinor - reference.principalMinor,
      });
    }
  }
  return effects;
}
