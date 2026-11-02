"use client";

import { AccountsWorkspace } from "@/app/accounts/accounts-workspace";
import { dispatchPreviewAccounting, resetPreviewAccounting, usePreviewAccounting } from "@/ui-preview/accounting-store";
import { PREVIEW_ACCOUNTING_NOW } from "@/ui-preview/accounting-fixture";
import { SubscriptionsPreview } from "./subscriptions-preview";
import { resetPreviewBills } from "@/ui-preview/bills-store";

export function AccountsPreview() {
  const state = usePreviewAccounting();
  return <div data-preview-local-actions="true"><AccountsWorkspace state={state} dispatch={dispatchPreviewAccounting} mode="preview" now={PREVIEW_ACCOUNTING_NOW} onReset={() => { resetPreviewAccounting(); resetPreviewBills(); }} subscriptions={<SubscriptionsPreview />} /></div>;
}
