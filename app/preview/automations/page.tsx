import type { Metadata } from "next";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { localAutomationPreviewAllowed } from "@/app/preview/sms-automation/fixtures";
import { AutomationsSettingsPreview } from "./preview";

export const metadata: Metadata = { title: "Automations settings preview · Alfred", robots: { index: false, follow: false } };

export default function AutomationsSettingsPreviewPage() {
  return <Suspense fallback={<p className="p-8 text-sm text-muted">Loading the local preview…</p>}><LocalPreview /></Suspense>;
}

async function LocalPreview() {
  await connection();
  if (!localAutomationPreviewAllowed(process.env)) notFound();
  return <AutomationsSettingsPreview />;
}
