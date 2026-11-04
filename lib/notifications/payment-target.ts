import type { AccountingState } from '@/lib/finance/accounting/types';

/** A locator, never an authorization token. Financial details stay on the signed-in page. */
export function paymentTargetId(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) ? value : null;
}

export type PaymentTargetRequest = { requested: boolean; id: string | null };
export function paymentTargetRequest(value: unknown): PaymentTargetRequest {
  return { requested: value !== undefined, id: paymentTargetId(value) };
}

/** Resolve only the exact, current bank source in the authenticated owner's state. */
export function ownedPaymentMovement(state: AccountingState, ownerId: string, target: unknown) {
  const id = paymentTargetId(target);
  if (!id || !ownerId || state.ownerId !== ownerId) return null;
  return state.movements.find(movement => movement.ownerId === ownerId && movement.sourceKind === 'bank' &&
    movement.sourceId === id && movement.id === `bank:${id}` && !movement.sourceMissing) ?? null;
}
