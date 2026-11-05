import type { Metadata } from "next";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { drawChart, chartSummary } from "@/lib/finance/charts";
import type { TransactionRecord } from "@/lib/finance/types";
import { automationPreviewAllowed } from "@/lib/preview/access";
import { StreamingChatPreview } from "./preview";

export const metadata: Metadata = { title: "Streaming chat preview · Alfred", robots: { index: false, follow: false } };

export default function StreamingChatPreviewPage() {
  return <Suspense fallback={<p className="p-8 text-sm text-muted">Loading the sample chat…</p>}><LocalPreview /></Suspense>;
}

/** Fictional food spending only. */
function sampleBooks(): TransactionRecord[] {
  const rows: [string, string, string][] = [["03", "45.00", "Waakye"], ["05", "220.00", "Melcom groceries"], ["09", "60.00", "Jollof"], ["12", "180.00", "Shoprite"], ["16", "95.00", "Banku and tilapia"], ["19", "40.00", "Waakye"]];
  return rows.map(([day, amount, description], index) => ({
    transactionId: `sample-${index}`, createdAt: `2026-11-${day}T12:00:00.000Z`, transactionDate: `2026-11-${day}`, userId: "sample", type: "expense", amount, currency: "GHS",
    category: "Food", description, paymentMethod: "", notes: "", status: "active", updatedAt: `2026-11-${day}T12:00:00.000Z`, sourceUpdateId: `sample:${index}`, rowNumber: index,
  }));
}

async function LocalPreview() {
  await connection();
  if (!automationPreviewAllowed(process.env)) notFound();
  const drawn = drawChart({ query: { measure: "spending", by: "week", category: "Food", period: "this_month" }, transactions: sampleBooks(), userId: "sample", currency: "GHS", today: "2026-11-20" });
  if (!drawn.ok) notFound();
  return <StreamingChatPreview chart={drawn.chart} reply={`${chartSummary(drawn.chart)} Most of it went on two big shops, Melcom on 5 Nov and Shoprite on 12 Nov; the rest was small meals out.`} />;
}
