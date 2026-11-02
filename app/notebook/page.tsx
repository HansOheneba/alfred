import { redirect } from "next/navigation";

/** Keep existing bookmarks useful now that Notebook lives alongside Chat. */
export default function NotebookPage() {
  redirect("/chat?panel=notebook");
}
