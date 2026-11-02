"use client";

import Link from "next/link";
import type { ComponentProps } from "react";
import { BillsCard } from "@/app/dashboard/bills-card";
import { upcomingBills } from "@/lib/finance/bill-schedule";
import { dispatchPreviewBill, previewBillSuggestions, usePreviewBills } from "@/ui-preview/bills-store";
import "./preview-review.css";
import "./preview-bills.css";

/** Bill records do not carry a category; categorise the incoming payment in Review. */
export function PreviewBillsCard(props: ComponentProps<typeof BillsCard>) {
  const bills = usePreviewBills();
  const suggestions = previewBillSuggestions.filter((suggestion) => !bills.some((bill) => bill.name.toLowerCase() === suggestion.name.toLowerCase()));
  return <div className="alfred-preview-billsWrapper" data-preview-local-actions="true"><BillsCard {...props} bills={bills} upcoming={upcomingBills(bills, props.today)} suggestions={suggestions} onAction={dispatchPreviewBill} reminderNote="Synthetic subscriptions · Changes stay in this browser. No reminder is sent."/><Link className="alfred-preview-billsCategoryLink" href="/ui-preview/accounts?tab=needs-attention"><span>Missing a category? Categorise an incoming payment</span><span aria-hidden="true">↗</span></Link></div>;
}
