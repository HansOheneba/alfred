import { CHAT_SESSION_CHANGED } from "@/app/chat/context-data";

/** The same readiness-aware, cheap check used by the initial Chat page. */
export async function loadOwnedChatEmptyStatus(ownerId: string, signal: AbortSignal): Promise<boolean> {
  const response = await fetch("/api/chat/empty", { cache: "no-store", credentials: "same-origin", signal });
  const payload = await response.json() as { ok?: boolean; ownerId?: string; financialsEmpty?: boolean };
  if (!response.ok || payload.ok !== true || typeof payload.financialsEmpty !== "boolean") throw new Error("Your account status could not be checked. Try again.");
  if (payload.ownerId !== ownerId) throw new Error(CHAT_SESSION_CHANGED);
  return payload.financialsEmpty;
}

/** Component-local requests: only the latest response for this owner may update setup guidance. */
export function createChatEmptyStatusRefresh(ownerId: string, publish: (empty: boolean | null) => void) {
  let current: AbortController | null = null;
  let active = true;
  let sequence = 0;
  const cancel = () => { sequence += 1; current?.abort(); current = null; };
  return {
    activate() { active = true; },
    dispose() { active = false; cancel(); },
    async refresh(ledgerChanged: boolean | undefined): Promise<void> {
      if (ledgerChanged === false || !active) return;
      cancel();
      const version = sequence;
      const request = new AbortController();
      current = request;
      // Keep the last confirmed visibility while checking, so empty-account messages
      // do not briefly hide and then restore Get Started. Only a settled result changes it.
      try {
        const empty = await loadOwnedChatEmptyStatus(ownerId, request.signal);
        if (active && !request.signal.aborted && version === sequence) publish(empty);
      } catch {
        // Unknown storage/session status never proves the account is empty.
        if (active && !request.signal.aborted && version === sequence) publish(null);
      } finally {
        if (current === request) current = null;
      }
    },
  };
}
