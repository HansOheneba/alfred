import { connection } from "next/server";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { automationPreviewAllowed } from "@/lib/preview/access";
import { RowsPreview } from "./preview";

export const metadata = { title: "Accounts rows preview · Alfred", robots: { index: false, follow: false } };

export default function AccountsRowsPreviewPage() {
  return <Suspense fallback={<p className="p-8 text-sm text-muted">Loading the sample rows…</p>}><LocalPreview /></Suspense>;
}

async function LocalPreview() {
  await connection();
  if (!automationPreviewAllowed(process.env)) notFound();
  return <RowsPreview />;
}
