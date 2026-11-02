import { notFound } from "next/navigation";

import { PreviewScreen } from "./preview-screen";

/** An isolated, synthetic UI study. Never available in a production build. */
export default function DashboardStudy() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <PreviewScreen variant="concept" />;
}
