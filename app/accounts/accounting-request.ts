import type { AccountingAction, AccountingState } from "@/lib/finance/accounting/types";
import { assertMutationsAvailable, requireMutationRecovery } from "@/app/components/mutation-request";

export type AccountsPayload = { ok: true; state: AccountingState; availability: "ready" | "migration-required" };
export const ACCOUNTING_REQUEST_TIMEOUT_MS = 20_000;
export const UNCONFIRMED_SAVE_MESSAGE = "The save could not be confirmed. It may have completed. Reload the latest records before making another change.";

export class AccountingRequestError extends Error {
  constructor(message: string, readonly status?: number, readonly unconfirmed = false) {
    super(message);
    this.name = "AccountingRequestError";
  }
}

function validPayload(body: unknown): body is AccountsPayload {
  if (!body || typeof body !== "object") return false;
  const value = body as AccountsPayload;
  return value.ok === true && ["ready", "migration-required"].includes(value.availability) && !!value.state
    && typeof value.state.ownerId === "string" && Number.isSafeInteger(value.state.revision) && value.state.revision >= 0
    && [value.state.accounts, value.state.movements, value.state.snapshots, value.state.transfers, value.state.settlements, value.state.audit].every(Array.isArray);
}

/** Covers both response headers and body, even when a transport ignores abort. Never retries a write. */
export async function requestAccounting({ method = "GET", action, ownerId, request = fetch, timeoutMs = ACCOUNTING_REQUEST_TIMEOUT_MS }: {
  method?: "GET" | "POST";
  action?: AccountingAction;
  ownerId?: string;
  request?: typeof fetch;
  timeoutMs?: number;
} = {}): Promise<AccountsPayload> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fallback = method === "POST" ? UNCONFIRMED_SAVE_MESSAGE : "Account records could not be loaded. Try reloading them again.";
  try {
    if (method === "POST") assertMutationsAvailable();
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new AccountingRequestError(fallback, undefined, method === "POST"));
        controller.abort();
      }, timeoutMs);
    });
    const result = (async () => {
      const response = await request("/api/accounting", {
        method, cache: "no-store", credentials: "same-origin", signal: controller.signal,
        ...(method === "POST" ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(action) } : {}),
      });
      const body = await response.json();
      if (!response.ok || !validPayload(body)) {
        const message = typeof body?.text === "string" ? body.text : typeof body?.error === "string" ? body.error : typeof body?.message === "string" ? body.message : fallback;
        throw new AccountingRequestError(message, response.status, method === "POST" && (response.ok || response.status >= 500));
      }
      if (ownerId && body.state.ownerId !== ownerId) throw new AccountingRequestError(fallback, undefined, method === "POST");
      return body as AccountsPayload;
    })();
    return await Promise.race([result, deadline]);
  } catch (error) {
    if (error instanceof AccountingRequestError) throw error;
    throw new AccountingRequestError(fallback, undefined, method === "POST");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function dispatchAccounting(action: AccountingAction, { ownerId, publish, recover, request, timeoutMs }: {
  ownerId: string;
  publish: (payload: AccountsPayload) => void;
  recover: (message: string) => void;
  request?: typeof fetch;
  timeoutMs?: number;
}): Promise<AccountingState> {
  try {
    const next = await requestAccounting({ method: "POST", action, ownerId, request, timeoutMs });
    if (next.state.revision !== action.expectedRevision + 1 || next.state.audit.at(-1)?.requestId !== action.requestId) {
      throw new AccountingRequestError(UNCONFIRMED_SAVE_MESSAGE, undefined, true);
    }
    publish(next);
    return next.state;
  } catch (error) {
    if (error instanceof AccountingRequestError && error.status === 409) {
      let refreshed = false;
      try { publish(await requestAccounting({ ownerId, request, timeoutMs })); refreshed = true; }
      catch { requireMutationRecovery(); recover("The latest account records could not be loaded. Reload them before making another change."); }
      throw new Error(`${error.message} ${refreshed ? "The latest records are loaded. Review the details before confirming again." : "Reload the latest records before confirming again."}`);
    }
    if (error instanceof AccountingRequestError && error.unconfirmed) { requireMutationRecovery(); recover(UNCONFIRMED_SAVE_MESSAGE); }
    throw error;
  }
}
