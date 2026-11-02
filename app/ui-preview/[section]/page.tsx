import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";

import { PreviewDestination, type PreviewDestinationSection } from "../preview-destinations";

const SECTIONS = ["chat", "accounts", "investments", "review", "settings"] as const;
type DestinationProps = { params: Promise<{ section: string }> };

export function generateStaticParams() {
  return SECTIONS.map((section) => ({ section }));
}

async function DestinationContent({ params }: DestinationProps) {
  const { section } = await params;
  if (section === "review") redirect("/ui-preview/accounts?tab=needs-attention");
  if (section === "notebook") redirect("/ui-preview/chat");
  if (!(SECTIONS as readonly string[]).includes(section)) notFound();
  return <PreviewDestination section={section as PreviewDestinationSection} />;
}

/** Preview navigation stays synthetic and is unavailable in production. */
export default function DestinationPage({ params }: DestinationProps) {
  if (process.env.NODE_ENV !== "development") notFound();
  return (
    <Suspense fallback={<div role="status" className="mx-auto w-full max-w-5xl px-4 py-7 text-sm text-muted sm:px-8">Loading preview…</div>}>
      <DestinationContent params={params} />
    </Suspense>
  );
}
