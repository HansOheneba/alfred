import type { Ledger } from "@/lib/web/ledger";

export const CHAT_CONTEXT_ERROR = "Your financial summary could not be loaded. You can keep chatting and try again.";
export const CHAT_SESSION_CHANGED = "Your session changed. Reload this page to continue.";

/** Verify the response belongs to the owner who opened this conversation. */
export async function loadOwnedChatContext(ownerId: string, signal: AbortSignal, request: typeof fetch = fetch): Promise<Ledger> {
  const response = await request("/api/chat/context", { cache: "no-store", credentials: "same-origin", signal });
  const payload = await response.json() as { ok?: boolean; ownerId?: string; ledger?: Ledger };
  if (!response.ok || payload.ok !== true || !payload.ledger) throw new Error(CHAT_CONTEXT_ERROR);
  if (payload.ownerId !== ownerId) throw new Error(CHAT_SESSION_CHANGED);
  const ledger = payload.ledger;
  if (!Array.isArray(ledger.rows) || !Array.isArray(ledger.budgets) || !Array.isArray(ledger.goals) || typeof ledger.currency !== "string") throw new Error(CHAT_CONTEXT_ERROR);
  return ledger;
}

/** Drop the loaded summary after a write or an uncertain legacy outcome. The page itself holds no financial data to refresh. */
export function invalidateAfterChatOutcome(ledgerChanged: boolean | undefined, invalidate: () => void, refreshCategories?: () => void) {
  if (ledgerChanged === false) return;
  invalidate();
  refreshCategories?.();
}
