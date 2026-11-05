"use client";

import { useMemo, useState } from "react";
import type { AccountingAction, AccountingState } from "@/lib/finance/accounting/types";
import { AccountsWorkspace } from "./accounts-workspace";
import { AccountsErrorState, AccountsLoading } from "./accounts-status";
import { sendJson } from "@/app/components/ui";
import { loadAccountSubscriptions } from "./subscriptions-actions";
import { createSubscriptionsResource } from "./subscriptions-resource";
import { SubscriptionsPanel } from "./subscriptions-panel";
import { ownedPaymentMovement, type PaymentTargetRequest } from '@/lib/notifications/payment-target';

export type AccountsPayload = { ok: true; state: AccountingState; availability: "ready" | "migration-required" };
async function readResponse(response: Response): Promise<AccountsPayload> {
  const body = await response.json();
  if (!response.ok || body.ok !== true || !body.state) throw new Error(typeof body.text === "string" ? body.text : typeof body.error === "string" ? body.error : typeof body.message === "string" ? body.message : "Account records could not be loaded. Refresh and try again.");
  return body as AccountsPayload;
}
export function AccountsClient({ defaultCurrency, initialPayload, initialError = "", paymentRequest, expectedOwnerId }: { defaultCurrency: string; initialPayload: AccountsPayload | null; initialError?: string; paymentRequest?: PaymentTargetRequest; expectedOwnerId?: string }) {
  const [payload,setPayload] = useState(initialPayload);
  const [error,setError] = useState(initialError);
  const [loading,setLoading] = useState(false);
  const ownerId = payload?.state.ownerId ?? "";
  // One owner-scoped resource outlives tab panels, without a cross-user cache.
  const subscriptions = useMemo(() => createSubscriptionsResource(ownerId, loadAccountSubscriptions, (action) => sendJson("/api/bills", "POST", action)), [ownerId]);
  async function retry() {
    setLoading(true); setError("");
    try { setPayload(await readResponse(await fetch("/api/accounting", { cache: "no-store" }))); }
    catch (error) { setError(error instanceof Error ? error.message : "Account records could not be loaded."); }
    finally { setLoading(false); }
  }
  async function dispatch(action: AccountingAction) {
    const response = await fetch("/api/accounting", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action) });
    if (response.status === 409) {
      const latest = await readResponse(await fetch("/api/accounting", { cache: "no-store" })); setPayload(latest);
      throw new Error("Your account records changed in another session. The latest records are loaded; check your selection and try again.");
    }
    const next = await readResponse(response); setPayload(next); return next.state;
  }
  if (!payload) return loading ? <AccountsLoading /> : <AccountsErrorState message={error || "Account records could not be loaded. Try again shortly."} onRetry={() => { void retry(); }} />;
  const payment = paymentRequest?.requested ? ownedPaymentMovement(payload.state, expectedOwnerId ?? '', paymentRequest.id) : null;
  return <AccountsWorkspace key={ownerId} state={payload.state} dispatch={dispatch} mode="live" availability={payload.availability} defaultCurrency={defaultCurrency} initialPaymentMovementId={payment?.id} paymentUnavailable={paymentRequest?.requested && !payment} subscriptions={<SubscriptionsPanel key={ownerId} resource={subscriptions} accounting={payload.state} />} />;
}
