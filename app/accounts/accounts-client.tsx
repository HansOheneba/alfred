"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { AccountingAction, AccountingState } from "@/lib/finance/accounting/types";
import { AccountsWorkspace } from "./accounts-workspace";
import { AccountsErrorState, AccountsLoading } from "./accounts-status";

type Payload = { ok: true; state: AccountingState; availability: "ready" | "migration-required" };
async function readResponse(response: Response): Promise<Payload> {
  const body = await response.json();
  if (!response.ok || body.ok !== true || !body.state) throw new Error(typeof body.text === "string" ? body.text : typeof body.error === "string" ? body.error : typeof body.message === "string" ? body.message : "Account records could not be loaded. Refresh and try again.");
  return body as Payload;
}
export function AccountsClient({ defaultCurrency, subscriptions }: { defaultCurrency: string; subscriptions: ReactNode }) {
  const [payload,setPayload] = useState<Payload | null>(null);
  const [error,setError] = useState("");
  const [retry,setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/accounting", { signal: controller.signal, cache: "no-store" }).then(readResponse).then((next) => { setPayload(next); setError(""); }).catch((error) => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Account records could not be loaded."); });
    return () => controller.abort();
  }, [retry]);
  async function dispatch(action: AccountingAction) {
    const response = await fetch("/api/accounting", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action) });
    if (response.status === 409) {
      const latest = await readResponse(await fetch("/api/accounting", { cache: "no-store" })); setPayload(latest);
      throw new Error("Your account records changed in another session. The latest records are loaded; check your selection and try again.");
    }
    const next = await readResponse(response); setPayload(next); return next.state;
  }
  if (!payload) return error ? <AccountsErrorState message={error} onRetry={() => { setError(""); setRetry((value) => value+1); }} /> : <AccountsLoading />;
  return <AccountsWorkspace state={payload.state} dispatch={dispatch} mode="live" availability={payload.availability} defaultCurrency={defaultCurrency} subscriptions={subscriptions} />;
}
