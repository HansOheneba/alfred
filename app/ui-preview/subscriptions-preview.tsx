"use client";

import { PreviewBillsCard } from "./preview-bills";
import { previewLedger } from "@/ui-preview/fixture";

export function SubscriptionsPreview() {
  return <PreviewBillsCard bills={previewLedger.bills ?? []} upcoming={previewLedger.upcomingBills ?? []} suggestions={previewLedger.renewalSuggestions ?? []} currency={previewLedger.currency} today={previewLedger.today} />;
}
