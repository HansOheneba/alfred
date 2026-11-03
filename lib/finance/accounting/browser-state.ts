import type { AccountingData, AccountingState } from "./types";

const OMITTED: AccountingData = { accounts: [], movements: [], snapshots: [], transfers: [], settlements: [] };

/** Undo runs on the server, so a browser only needs each undo entry, not its full before-state copy. */
export function browserAccountingState(state: AccountingState): AccountingState {
  return { ...state, audit: state.audit.map((entry) => ({ ...entry, before: OMITTED })) };
}
