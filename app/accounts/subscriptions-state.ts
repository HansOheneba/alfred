import type { SubscriptionBillsData, SubscriptionsResult } from "./subscriptions-actions";

export type SubscriptionReadState = { kind: "loading" } | { kind: "error"; text: string } | { kind: "ready"; ownerId: string; data: SubscriptionBillsData };
export const subscriptionLoading: SubscriptionReadState = { kind: "loading" };
export const subscriptionReloadFailed = "Your change was saved, but subscriptions could not be reloaded. Try again shortly.";
export function subscriptionReadState(result: SubscriptionsResult, expectedOwnerId: string, afterWrite = false): SubscriptionReadState {
  if (!result.ok) return { kind: "error", text: afterWrite ? subscriptionReloadFailed : result.text };
  if (result.ownerId !== expectedOwnerId) return { kind: "error", text: "Your signed-in account changed. Reload Accounts before viewing subscriptions." };
  return { kind: "ready", ownerId: result.ownerId, data: result.data };
}
