"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { buttonClassName } from "@/app/components/button-styles";
import { BillsCard } from "@/app/dashboard/bills-card";
import type { AccountingState } from "@/lib/finance/accounting/types";
import { subscriptionsData } from "./subscriptions-data";
import type { SubscriptionsResource } from "./subscriptions-resource";

/** The resource belongs to AccountsClient and survives this tab panel unmounting. */
export function SubscriptionsPanel({ resource, accounting }: { resource: SubscriptionsResource; accounting: AccountingState }) {
  const state = useSyncExternalStore(resource.subscribe, resource.getSnapshot, resource.getSnapshot);
  useEffect(() => { void resource.ensureLoaded(); }, [resource]);
  const data = useMemo(() => state.kind === "ready" && state.ownerId === accounting.ownerId && resource.ownerId === accounting.ownerId ? subscriptionsData(state.data, accounting) : null, [state, resource.ownerId, accounting]);
  if (resource.ownerId !== accounting.ownerId || state.kind === "ready" && state.ownerId !== accounting.ownerId) return <p role="alert">Your signed-in account changed. Reload Accounts before viewing subscriptions.</p>;
  if (state.kind === "error") return <div className="alfred-accounts-message" role="alert"><p>{state.text}</p><button className={buttonClassName({ variant: "secondary", size: "sm" })} onClick={() => { void resource.reload(); }}>Retry subscriptions</button></div>;
  if (data) return <BillsCard showCategoryLink {...data} onAction={resource.save} />;
  return <p role="status">Loading your subscriptions…</p>;
}
