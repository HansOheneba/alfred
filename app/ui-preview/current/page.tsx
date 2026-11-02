import { notFound } from "next/navigation";

import { PreviewScreen } from "../preview-screen";

/** Render the unmodified current dashboard against the same synthetic fixture. */
export default function CurrentDashboardStudy() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <PreviewScreen variant="current" />;
}
