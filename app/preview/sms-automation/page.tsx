import type { Metadata } from "next";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { SmsAutomationPreview } from "./preview";
import { localAutomationPreviewAllowed, paymentMentionPreviewCopies } from "./fixtures";

export const metadata: Metadata = { title: "SMS automation preview · Alfred", robots: { index: false, follow: false } };

export default function SmsAutomationPreviewPage() {
  return <Suspense fallback={<div className="p-8 text-sm text-muted">Loading the local preview…</div>}><LocalPreview /></Suspense>;
}

async function LocalPreview() {
  await connection();
  if (!localAutomationPreviewAllowed(process.env)) notFound();
  return <SmsAutomationPreview {...paymentMentionPreviewCopies()} />;
}
