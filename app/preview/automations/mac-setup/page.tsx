import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { localAutomationPreviewAllowed } from "@/app/preview/sms-automation/fixtures";
import { MacSetupPreview } from "../mac-setup-preview";

export const metadata: Metadata = { title: "Fictional Mac setup · Alfred", robots: { index: false, follow: false } };

export default function FictionalMacSetupPage() {
  return <Suspense fallback={<p className="p-8 text-sm text-muted">Loading the fictional preview…</p>}><LocalPreview /></Suspense>;
}

async function LocalPreview() {
  await connection();
  if (!localAutomationPreviewAllowed(process.env)) notFound();
  return <main className="min-h-screen bg-bg"><div className="border-b border-line bg-surface px-4 py-3 text-center text-xs leading-5 text-muted">Local preview · fictional Mac setup · no account or permission changes</div><div className="mx-auto max-w-2xl px-4 py-6 sm:py-10"><Link href="/preview/automations#automations" className="mb-5 inline-flex min-h-11 items-center text-sm font-medium text-accent underline underline-offset-4">← Back to Automations preview</Link><MacSetupPreview /></div></main>;
}
