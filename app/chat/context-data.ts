import { chatContextSchema, type ChatContext } from "@/lib/web/chat-context";

export const CHAT_CONTEXT_ERROR = "Your financial summary could not be loaded. You can keep chatting and try again.";
export const CHAT_SESSION_CHANGED = "Your session changed. Reload this page to continue.";

/** Verify the response belongs to the owner who opened this conversation. */
export async function loadOwnedChatContext(ownerId: string, signal: AbortSignal, request: typeof fetch = fetch): Promise<ChatContext> {
  const response = await request("/api/chat/context", { cache: "no-store", credentials: "same-origin", signal });
  const payload = await response.json() as { ok?: boolean; ownerId?: string; context?: unknown };
  if (!response.ok || payload.ok !== true || !payload.context) throw new Error(CHAT_CONTEXT_ERROR);
  if (payload.ownerId !== ownerId) throw new Error(CHAT_SESSION_CHANGED);
  const parsed = chatContextSchema.safeParse(payload.context);
  if (!parsed.success) throw new Error(CHAT_CONTEXT_ERROR);
  return parsed.data as ChatContext;
}

/** Drop the loaded summary after a write or an uncertain legacy outcome. The page itself holds no financial data to refresh. */
export function invalidateAfterChatOutcome(ledgerChanged: boolean | undefined, invalidate: () => void, refreshCategories?: () => void) {
  if (ledgerChanged === false) return;
  invalidate();
  refreshCategories?.();
}
