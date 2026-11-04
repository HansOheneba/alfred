import type { Metadata } from "next";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { automationPreviewAllowed } from "@/lib/preview/access";
import { TransferChatPreview } from "./preview";
import { paymentQuestionPreviewSamples } from "./fixtures";

export const metadata: Metadata = { title: "Transfer conversation preview · Alfred", robots: { index: false, follow: false } };

export default function TransferConversationPreviewPage() {
  return <Suspense fallback={<p className="p-8 text-sm text-muted">Loading the sample conversation…</p>}><LocalPreview /></Suspense>;
}
async function LocalPreview() {
  await connection();
  if (!automationPreviewAllowed(process.env)) notFound();
  return <TransferChatPreview ordinarySamples={await paymentQuestionPreviewSamples()} />;
}
