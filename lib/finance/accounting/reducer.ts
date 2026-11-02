import { applyAccountAction, validateAccountData } from "./accounts";
import { applySettlementAction } from "./settlements";
import { AccountingError, type AccountingAction, type AccountingData, type AccountingState } from "./types";

/** Canonical JSON is shared by memory and persisted idempotency checks. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function accountingData(state: AccountingState): AccountingData {
  return structuredClone({accounts:state.accounts,movements:state.movements,snapshots:state.snapshots,transfers:state.transfers,settlements:state.settlements});
}
export function actionFingerprint(action: AccountingAction): string { return stableJson(action); }

/** All mutations, including undo, are revision checked. Raw evidence never changes. */
export function applyAccountingAction(state: AccountingState, action: AccountingAction, now = new Date().toISOString()): AccountingState {
  if (!action || typeof action.requestId !== "string" || !/^[\w:.-]{1,200}$/.test(action.requestId)) throw new AccountingError("A stable request ID is required.");
  if (!Number.isSafeInteger(action.expectedRevision) || action.expectedRevision < 0) throw new AccountingError("A valid revision is required.");
  const fingerprint = actionFingerprint(action);
  const prior = state.audit.find((event) => event.requestId === action.requestId);
  if (prior) {
    if (prior.actionFingerprint !== fingerprint) throw new AccountingError("This request ID was used for a different action.","conflict");
    return state;
  }
  if (state.revision !== action.expectedRevision) throw new AccountingError("The financial records changed. Refresh before saving.","stale");
  if (!Number.isFinite(Date.parse(now))) throw new AccountingError("A valid action timestamp is required.");
  validateAccountData(state);
  let next: AccountingState;
  if (action.type === "undo") {
    const active:typeof state.audit=[];
    for(const event of state.audit) {if(event.action==="undo") active.pop();else active.push(event);}
    const previous = active.at(-1);
    if (!previous) throw new AccountingError("There is no financial change to undo.","not_found");
    const before = previous.before;
    // Fresh source imports are retained. Changed evidence must be reviewed, never overwritten by undo.
    for (const old of before.movements) {
      const current = state.movements.find((movement) => movement.id === old.id);
      if (!current || current.sourceFingerprint !== old.sourceFingerprint) throw new AccountingError("Source evidence changed since that action; undo is unavailable.","stale");
    }
    const restored = new Map(before.movements.map((movement) => [movement.id,movement]));
    next = {...state,...structuredClone(before),movements:state.movements.map((movement) => {
      const old = restored.get(movement.id);
      return old ? {...movement,accountId:old.accountId,status:old.status,category:old.category} : movement;
    }),snapshots:[...before.snapshots,...state.snapshots.filter((snapshot) => !before.snapshots.some((old) => old.id === snapshot.id) && snapshot.sourceMovementId !== null)]};
    // Snapshot evidence is retained, but snapshots of accounts removed by undo do not contribute.
    next.snapshots = next.snapshots.filter((snapshot) => next.accounts.some((account) => account.id === snapshot.accountId));
  } else if (action.type === "save_settlement" || action.type === "delete_settlement") {
    next = applySettlementAction(state,action,now);
  } else {
    next = applyAccountAction(state,action,now);
  }
  validateAccountData(next);
  const revision = state.revision + 1;
  if (!Number.isSafeInteger(revision)) throw new AccountingError("Financial revision capacity exceeded.");
  return {...next,revision,audit:[...state.audit,{id:`revision:${revision}`,requestId:action.requestId,action:action.type,actionFingerprint:fingerprint,at:now,revision,before:accountingData(state)}].slice(-50)};
}
