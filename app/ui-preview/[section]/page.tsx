import { notFound, redirect } from "next/navigation";

import { PreviewDestination, type PreviewDestinationSection } from "../preview-destinations";

const SECTIONS = ["chat", "accounts", "investments", "review", "notebook", "settings"] as const;

export function generateStaticParams() {
  return SECTIONS.map((section) => ({ section }));
}

/** Preview navigation stays synthetic and is unavailable in production. */
export default async function DestinationPage({ params }: { params: Promise<{ section: string }> }) {
  if (process.env.NODE_ENV !== "development") notFound();
  const { section } = await params;
  if (section === "review") redirect("/ui-preview/accounts?tab=needs-attention");
  if (section === "notebook") redirect("/ui-preview/chat?panel=notebook");
  if (!(SECTIONS as readonly string[]).includes(section)) notFound();
  return <PreviewDestination section={section as PreviewDestinationSection} />;
}
