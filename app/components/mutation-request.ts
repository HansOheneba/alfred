"use client";

export const MUTATION_REQUEST_TIMEOUT_MS = 20_000;
export const MUTATION_UNCONFIRMED_MESSAGE = "The save could not be confirmed. It may have completed. Reload the latest records before making another change.";

export class MutationUnconfirmedError extends Error {
  constructor() {
    super(MUTATION_UNCONFIRMED_MESSAGE);
    this.name = "MutationUnconfirmedError";
  }
}

class MutationRejectedError extends Error {}

function rejectionMessage(body: unknown): string {
  if (body && typeof body === "object") {
    const payload = body as Record<string, unknown>;
    for (const field of ["text", "error", "message"]) {
      if (typeof payload[field] === "string" && payload[field].trim()) return payload[field];
    }
  }
  return "That change could not be saved. Check the details and try again.";
}

/** Each page keeps only a recovery flag; financial data and request bodies are never cached here. */
export function createMutationTransport({ request, timeoutMs = MUTATION_REQUEST_TIMEOUT_MS }: { request?: typeof fetch; timeoutMs?: number } = {}) {
  let recoveryRequired = false;
  const listeners = new Set<() => void>();
  const getMutationRecoverySnapshot = () => recoveryRequired;
  function subscribeMutationRecovery(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }
  function requireMutationRecovery() {
    if (recoveryRequired) return;
    recoveryRequired = true;
    for (const listener of listeners) listener();
  }
  function assertMutationsAvailable() {
    if (recoveryRequired) throw new MutationUnconfirmedError();
  }

  /** One attempt, bounded through JSON parsing. A late response never clears recovery. */
  async function requestMutationJson<T>(url: string, method: string, body: unknown): Promise<T> {
    assertMutationsAvailable();
    const payload = JSON.stringify(body);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new MutationUnconfirmedError());
          controller.abort();
        }, timeoutMs);
      });
      const operation = (async () => {
        const response = await (request ?? fetch)(url, {
          method, credentials: "same-origin", cache: "no-store", signal: controller.signal,
          headers: { "content-type": "application/json" }, body: payload,
        });
        // A server error may follow a committed write; never invite a blind replay.
        if (response.status >= 500) throw new MutationUnconfirmedError();
        let json: unknown;
        try { json = await response.json(); }
        catch (error) {
          if (response.status >= 400 && response.status < 500) throw new MutationRejectedError(rejectionMessage(null));
          throw error;
        }
        if (response.status >= 400 && response.status < 500) throw new MutationRejectedError(rejectionMessage(json));
        if (!response.ok || !json || typeof json !== "object" || Array.isArray(json)) throw new MutationUnconfirmedError();
        const result = json as Record<string, unknown>;
        if (result.ok === false) throw new MutationRejectedError(rejectionMessage(json));
        if (result.ok !== true) throw new MutationUnconfirmedError();
        return json as T;
      })();
      return await Promise.race([operation, deadline]);
    } catch (error) {
      if (error instanceof MutationRejectedError) throw error;
      requireMutationRecovery();
      throw error instanceof MutationUnconfirmedError ? error : new MutationUnconfirmedError();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  return { requestMutationJson, requireMutationRecovery, assertMutationsAvailable, subscribeMutationRecovery, getMutationRecoverySnapshot };
}

const pageTransport = createMutationTransport();
export const requestMutationJson = pageTransport.requestMutationJson;
export const requireMutationRecovery = pageTransport.requireMutationRecovery;
export const assertMutationsAvailable = pageTransport.assertMutationsAvailable;
export const subscribeMutationRecovery = pageTransport.subscribeMutationRecovery;
export const getMutationRecoverySnapshot = pageTransport.getMutationRecoverySnapshot;
export const getMutationRecoveryServerSnapshot = () => false;
