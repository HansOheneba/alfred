"use client";

import { useMemo, useState } from "react";
import { AccountsReadClient } from "./accounts-read-client";
import type { AccountsReadView } from "@/lib/finance/accounting/read-view";
import type { AccountingAction } from "@/lib/finance/accounting/types";
import { AccountsWorkspace } from "./accounts-workspace";
import { AccountsErrorState, AccountsLoading } from "./accounts-status";
import { sendJson } from "@/app/components/ui";
import { loadAccountSubscriptions } from "./subscriptions-actions";
import { createSubscriptionsResource } from "./subscriptions-resource";
import { SubscriptionsPanel } from "./subscriptions-panel";
import { ownedPaymentMovement, type PaymentTargetRequest } from '@/lib/notifications/payment-target';
import { dispatchAccounting, requestAccounting, UNCONFIRMED_SAVE_MESSAGE, type AccountsPayload } from "./accounting-request";

export type { AccountsPayload } from "./accounting-request";
export function AccountsClient(props: { defaultCurrency: string; initialView?: AccountsReadView | null; initialPayload?: AccountsPayload | null; initialError?: string; paymentRequest?: PaymentTargetRequest; expectedOwnerId?: string }) {
  if ("initialView" in props) return <AccountsReadClient key={props.expectedOwnerId ?? props.initialView?.ownerId ?? ""} initialView={props.initialView ?? null} initialError={props.initialError} expectedOwnerId={props.expectedOwnerId ?? ""} defaultCurrency={props.defaultCurrency} paymentUnavailable={props.paymentRequest?.requested && !props.paymentRequest.id} />;
  return <CompleteAccountsClient {...props} initialPayload={props.initialPayload ?? null} />;
}
function CompleteAccountsClient({ defaultCurrency, initialPayload, initialError = "", paymentRequest, expectedOwnerId }: { defaultCurrency: string; initialPayload: AccountsPayload | null; initialError?: string; paymentRequest?: PaymentTargetRequest; expectedOwnerId?: string }) {
  const [payload,setPayload] = useState(initialPayload);
  const [error,setError] = useState(initialError);
  const [loading,setLoading] = useState(false);
  const [recoveryRequired,setRecoveryRequired] = useState(false);
  const ownerId = payload?.state.ownerId ?? "";
  // One owner-scoped resource outlives tab panels, without a cross-user cache.
  const subscriptions = useMemo(() => createSubscriptionsResource(ownerId, loadAccountSubscriptions, (action) => sendJson("/api/bills", "POST", action)), [ownerId]);
  async function retry() {
    setLoading(true); setError("");
    try { setPayload(await requestAccounting({ ownerId: ownerId || expectedOwnerId })); setRecoveryRequired(false); }
    catch (error) { setError(error instanceof Error ? error.message : "Account records could not be loaded."); }
    finally { setLoading(false); }
  }
  async function dispatch(action: AccountingAction) {
    return dispatchAccounting(action, { ownerId, publish: setPayload, recover: message => { setError(message); setRecoveryRequired(true); } });
  }
  if (recoveryRequired) return <AccountsErrorState title="We couldn’t confirm that save." message={error || UNCONFIRMED_SAVE_MESSAGE} retryLabel="Reload latest records" onRetry={() => { window.location.reload(); }} />;
  if (!payload) return loading ? <AccountsLoading /> : <AccountsErrorState message={error || "Account records could not be loaded. Try again shortly."} onRetry={() => { void retry(); }} />;
  const payment = paymentRequest?.requested ? ownedPaymentMovement(payload.state, expectedOwnerId ?? '', paymentRequest.id) : null;
  return <AccountsWorkspace key={ownerId} state={payload.state} dispatch={dispatch} mode="live" availability={payload.availability} defaultCurrency={defaultCurrency} initialPaymentMovementId={payment?.id} paymentUnavailable={paymentRequest?.requested && !payment} subscriptions={<SubscriptionsPanel key={ownerId} resource={subscriptions} accounting={payload.state} />} />;
}
