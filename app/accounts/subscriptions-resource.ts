import type { BillAction } from "@/lib/finance/bill-schedule";
import type { SubscriptionsResult } from "./subscriptions-actions";
import { subscriptionLoading, subscriptionReadState, subscriptionReloadFailed, type SubscriptionReadState } from "./subscriptions-state";

type ResourceState = SubscriptionReadState | { kind: "idle" };
/** Per Accounts-client lifetime. No global data, browser storage or owner-keyed cache. */
export function createSubscriptionsResource(ownerId: string, read: () => Promise<SubscriptionsResult>, write: (action: BillAction) => Promise<unknown>) {
  let state: ResourceState = { kind: "idle" };
  let generation = 0;
  let pending: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  function publish(next: ResourceState) { state = next; listeners.forEach((listener) => listener()); }
  function reload(afterWrite = false): Promise<void> {
    const current = ++generation;
    publish(subscriptionLoading);
    const task = Promise.resolve().then(read).then((result) => {
      if (current === generation) publish(subscriptionReadState(result, ownerId, afterWrite));
    }).catch(() => {
      if (current === generation) publish({ kind: "error", text: afterWrite ? subscriptionReloadFailed : "Your subscriptions could not be loaded. Try again shortly." });
    }).finally(() => { if (current === generation) pending = null; });
    pending = task;
    return task;
  }
  return {
    ownerId,
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    ensureLoaded() { return state.kind === "idle" ? reload() : pending ?? Promise.resolve(); },
    reload,
    async save(action: BillAction) {
      const current = ++generation;
      publish(subscriptionLoading);
      try { await write(action); }
      catch (error) {
        if (current === generation) publish({ kind: "error", text: error instanceof Error ? error.message : "That bill could not be saved. Try again shortly." });
        throw error;
      }
      if (current === generation) await reload(true);
    },
  };
}
export type SubscriptionsResource = ReturnType<typeof createSubscriptionsResource>;
