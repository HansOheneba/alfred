import type { LedgerRow } from "@/lib/finance/analytics";
import { formatDisplayDate } from "@/lib/finance/dates";
import { needsAttention, type AccountingAction, type AccountingState, type CashMovement } from "@/lib/finance/accounting/types";
import type { ActivityHandoff } from "@/lib/web/activity-handoff";

export type AccountCommand = AccountingAction extends infer A ? A extends AccountingAction ? Omit<A, "expectedRevision" | "requestId"> : never : never;
export type ActivityFilters = ActivityHandoff & { account: string; status: string };
export const emptyActivityFilters: ActivityFilters = { search: "", account: "", status: "", start: "", end: "", category: "", type: "all", sort: "date-desc", currency: "" };

export function filterActivityMovements(state: AccountingState, filters: ActivityFilters, reportRows: LedgerRow[]): CashMovement[] {
  const needle = filters.search.trim().toLowerCase();
  const scoped = Boolean(filters.category) || filters.type !== "all";
  const reportMatches = new Set(reportRows.filter(row => (!filters.category || row.category === filters.category) && (filters.type === "all" || row.type === filters.type) && (!filters.currency || row.currency === filters.currency)
    && (!needle || `${row.description} ${row.category}`.toLowerCase().includes(needle))).map(row => row.id.replace(/^accounting(?:-fee|-tax)?:/, "")));
  return state.movements.filter(row => (!filters.account || row.accountId === filters.account || filters.account === "unassigned" && !row.accountId)
    && (!filters.status || row.status === filters.status) && (!filters.start || row.date >= filters.start) && (!filters.end || row.date <= filters.end)
    && (!filters.currency || row.currency === filters.currency)
    && (scoped ? reportMatches.has(row.id) : !needle || reportMatches.has(row.id) || `${row.description} ${row.category} ${row.sourceId}`.toLowerCase().includes(needle)))
    .sort((a, b) => filters.sort === "amount-desc" ? b.amountMinor - a.amountMinor : filters.sort === "amount-asc" ? a.amountMinor - b.amountMinor : filters.sort === "date-asc" ? (a.occurredAt ?? a.date).localeCompare(b.occurredAt ?? b.date) : (b.occurredAt ?? b.date).localeCompare(a.occurredAt ?? a.date));
}

export function movementIsLinked(state: AccountingState, movement: CashMovement): boolean {
  return state.transfers.some(link => link.outgoing.movementId === movement.id || link.incoming.movementId === movement.id)
    || state.settlements.some(link => link.original.movementId === movement.id || link.returns.some(item => item.movementId === movement.id));
}
export function nextReviewMovement(state: AccountingState, currentId: string | undefined): CashMovement | undefined {
  return state.movements.find(row => row.id !== currentId && needsAttention(row) && !movementIsLinked(state, row));
}
export function attentionGroupKey(row: CashMovement): string { return JSON.stringify([row.description, row.accountId, row.currency, row.direction]); }
export function groupAttention(rows: CashMovement[]): { key: string; rows: CashMovement[] }[] {
  const groups = new Map<string, CashMovement[]>();
  for (const row of rows) { const key = attentionGroupKey(row); groups.set(key, [...(groups.get(key) ?? []), row]); }
  return [...groups].map(([key, items]) => ({ key, rows: items }));
}
/** Group consecutive days without changing an amount-sorted or paginated order. */
export function movementDayGroups(rows: CashMovement[]): [string, CashMovement[]][] {
  const groups: [string, CashMovement[]][] = [];
  for (const row of rows) { const previous = groups.at(-1); if (previous?.[0] === row.date) previous[1].push(row); else groups.push([row.date, [row]]); }
  return groups;
}
export function readableMovementDay(value: string): string {
  try { return /^\d{4}-\d{2}-\d{2}$/.test(value) ? formatDisplayDate(value) : value; } catch { return value; }
}

export type ReviewFields = { accountId: string | null; category: string; status: CashMovement["status"] };
export type ReviewedMovement = { id: string; description: string; date: string; amountMinor: number; currency: string; before: ReviewFields; after: ReviewFields };
export type AccountReview = { ownerId: string; revision: number; movements: ReviewedMovement[]; commands: AccountCommand[] };
type EditableStatus = Extract<AccountingAction, { type: "classify_movement" }>["status"];
function editable(status: string): status is EditableStatus { return ["confirmed", "review", "hold", "duplicate", "excluded"].includes(status); }
function checkedCategory(category: string): string {
  const value = category.trim();
  if (!value || value.length > 40 || /[\u0000-\u001f]/.test(value)) throw new Error("Use a category name of 1–40 characters.");
  return value;
}
export function prepareMovementReview(state: AccountingState, movementId: string, input: { accountId: string | null; category: string; status: string }): AccountReview {
  const row = state.movements.find(item => item.id === movementId && item.ownerId === state.ownerId);
  if (!row || movementIsLinked(state, row)) throw new Error("This payment is no longer available for classification. Review its current details.");
  const category = checkedCategory(input.category);
  if (!editable(input.status)) throw new Error("Choose an available status.");
  if (input.accountId && !state.accounts.some(account => account.id === input.accountId && account.currency === row.currency)) throw new Error("Choose an account in the payment's currency.");
  if (row.accountId && !input.accountId) throw new Error("Choose an assigned account. This form cannot remove its account.");
  const commands: AccountCommand[] = [], reference = { movementId: row.id, sourceFingerprint: row.sourceFingerprint };
  if (input.accountId && input.accountId !== row.accountId) commands.push({ type: "assign_movement", movement: reference, accountId: input.accountId });
  if (category !== row.category || input.status !== row.status) commands.push({ type: "classify_movement", movement: reference, status: input.status, category });
  if (!commands.length) throw new Error("Change an account, category or status before reviewing.");
  return { ownerId: state.ownerId, revision: state.revision, commands, movements: [{ id: row.id, description: row.description, date: row.date, amountMinor: row.amountMinor, currency: row.currency, before: { accountId: row.accountId, category: row.category, status: row.status }, after: { accountId: input.accountId, category, status: input.status } }] };
}
export function prepareSimilarReview(state: AccountingState, movementIds: string[], category: string): AccountReview {
  const chosen = [...new Set(movementIds)], value = checkedCategory(category);
  if (!chosen.length) throw new Error("Select the payments to update.");
  if (chosen.length > 25) throw new Error("Review up to 25 matching payments at a time.");
  const rows = chosen.map(id => state.movements.find(row => row.id === id && row.ownerId === state.ownerId));
  if (rows.some(row => !row)) throw new Error("A selected payment is no longer available.");
  const movements = rows as CashMovement[];
  if (new Set(movements.map(attentionGroupKey)).size !== 1) throw new Error("Only matching merchant, account, currency and direction can be reviewed together.");
  if (movements.some(row => !editable(row.status) || movementIsLinked(state, row))) throw new Error("A selected payment has a protected classification. Review it separately.");
  const changed = movements.filter(row => row.category !== value);
  if (!changed.length) throw new Error("The selected payments already use that category.");
  return { ownerId: state.ownerId, revision: state.revision, commands: changed.map(row => ({ type: "classify_movement", movement: { movementId: row.id, sourceFingerprint: row.sourceFingerprint }, status: row.status as EditableStatus, category: value })), movements: changed.map(row => ({ id: row.id, description: row.description, date: row.date, amountMinor: row.amountMinor, currency: row.currency, before: { accountId: row.accountId, category: row.category, status: row.status }, after: { accountId: row.accountId, category: value, status: row.status } })) };
}

export type AccountChangeReceipt = { ownerId: string; revision: number; requestIds: string[]; movements: ReviewedMovement[] };
export type ReviewOutcome = { ok: true; state: AccountingState; receipt: AccountChangeReceipt } | { ok: false; confirmed: number; total: number; error: string };
function confirmedState(value: unknown, ownerId: string, revision: number, requestId: string): value is AccountingState {
  if (!value || typeof value !== "object") return false;
  const state = value as AccountingState;
  return state.ownerId === ownerId && state.revision === revision && Array.isArray(state.movements) && Array.isArray(state.audit) && state.audit.at(-1)?.requestId === requestId;
}
export async function executeAccountReview(review: AccountReview, current: AccountingState, dispatch: (action: AccountingAction) => Promise<unknown>, createId: () => string, progress: (done: number, total: number) => void = () => {}): Promise<ReviewOutcome> {
  let latest = current, done = 0;
  const requestIds: string[] = [];
  try {
    if (review.ownerId !== current.ownerId || review.revision !== current.revision) throw new Error("Records changed after this review. Go back and review the latest details.");
    for (const command of review.commands) {
      const requestId = createId();
      const next = await dispatch({ ...command, requestId, expectedRevision: latest.revision } as AccountingAction);
      if (!confirmedState(next, current.ownerId, latest.revision + 1, requestId)) throw new Error("The saved result could not be confirmed. Refresh and review the latest records before retrying.");
      latest = next; requestIds.push(requestId); done += 1; progress(done, review.commands.length);
    }
    return { ok: true, state: latest, receipt: { ownerId: latest.ownerId, revision: latest.revision, requestIds, movements: review.movements } };
  } catch (error) { return { ok: false, confirmed: done, total: review.commands.length, error: error instanceof Error ? error.message : "This change could not be confirmed. Review the latest records before retrying." }; }
}
function activeRequests(state: AccountingState): string[] {
  const active: string[] = [];
  for (const event of state.audit) { if (event.action === "undo") active.pop(); else active.push(event.requestId); }
  return active;
}
export function canUndoReceipt(state: AccountingState, receipt: AccountChangeReceipt): boolean {
  const active = activeRequests(state);
  return state.ownerId === receipt.ownerId && state.revision === receipt.revision && receipt.requestIds.length > 0 && receipt.requestIds.length <= active.length && receipt.requestIds.every((request, index) => active[active.length - receipt.requestIds.length + index] === request);
}
export async function undoAccountReceipt(receipt: AccountChangeReceipt, current: AccountingState, dispatch: (action: AccountingAction) => Promise<unknown>, createId: () => string): Promise<{ ok: boolean; confirmed: number; error?: string }> {
  let latest = current, done = 0;
  try {
    if (!canUndoReceipt(current, receipt)) throw new Error("Another account change has happened. This receipt can no longer undo it.");
    for (const originalRequest of [...receipt.requestIds].reverse()) {
      if (activeRequests(latest).at(-1) !== originalRequest) throw new Error("The next change is no longer part of this receipt.");
      const requestId = createId(), next = await dispatch({ type: "undo", expectedRevision: latest.revision, requestId });
      if (!confirmedState(next, current.ownerId, latest.revision + 1, requestId)) throw new Error("The undo result could not be confirmed. Refresh and review the latest records.");
      latest = next; done += 1;
    }
    return { ok: true, confirmed: done };
  } catch (error) { return { ok: false, confirmed: done, error: error instanceof Error ? error.message : "Undo could not be confirmed." }; }
}
