"use client";

import { useEffect, useState } from "react";

type Resource = "ledger" | "botUsername";
const message = "This section could not be loaded. Please try again.";

export async function loadOwnedSettingsData<T>(endpoint: string, resource: Resource, ownerId: string | undefined, signal: AbortSignal): Promise<T> {
  const response = await fetch(endpoint, { cache: "no-store", credentials: "same-origin", signal });
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || payload?.ok !== true) throw new Error(typeof payload?.text === "string" ? payload.text : message);
  if (ownerId && payload.ownerId !== ownerId) throw new Error("Your session changed. Reload this page to continue.");
  const value = payload[resource];
  if (resource === "botUsername") {
    if (value !== null && (typeof value !== "string" || !/^[A-Za-z0-9_]{5,64}$/.test(value))) throw new Error(message);
  } else {
    const ledger = value as { rows?: unknown; budgets?: unknown; goals?: unknown; currency?: unknown } | null;
    if (!ledger || !Array.isArray(ledger.rows) || !Array.isArray(ledger.budgets) || !Array.isArray(ledger.goals) || typeof ledger.currency !== "string") throw new Error(message);
  }
  return value as T;
}

/**
 * Component-local, owner-keyed data only. A server refresh or retry starts a new read;
 * the last loaded value stays on screen until it settles, so a save does not unmount the section.
 */
export function useOwnedSettingsData<T>(endpoint: string, resource: Resource, enabled: boolean, initial: T | undefined, ownerId: string | undefined, refreshKey: string) {
  const [attempt, setAttempt] = useState(0);
  const readKey = `${refreshKey}:${attempt}`;
  const scope = JSON.stringify([ownerId ?? null, endpoint, resource]);
  const [state, setState] = useState<{ scope: string; key: string; value?: T; error?: string }>(initial !== undefined ? { scope, key: readKey, value: initial } : { scope, key: "" });
  const value = initial !== undefined ? initial : state.scope === scope ? state.value : undefined;
  const error = state.scope === scope && state.key === readKey ? state.error : undefined;
  useEffect(() => {
    if (!enabled || initial !== undefined || (state.scope === scope && state.key === readKey)) return;
    const controller = new AbortController();
    void loadOwnedSettingsData<T>(endpoint, resource, ownerId, controller.signal).then((next) => {
      if (!controller.signal.aborted) setState({ scope, key: readKey, value: next });
    }).catch((cause) => {
      // A failed reload must not keep presenting old totals as current.
      if (!controller.signal.aborted) setState({ scope, key: readKey, error: cause instanceof Error ? cause.message : message });
    });
    return () => controller.abort();
    // State is committed by this request. Including it would abort every read it settles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, endpoint, initial, ownerId, readKey, resource, scope]);
  const refreshing = enabled && initial === undefined && state.scope === scope && state.value !== undefined && state.key !== readKey;
  return { value, error, refreshing, retry: () => setAttempt((current) => current + 1) };
}
